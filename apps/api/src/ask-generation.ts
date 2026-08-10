import type { Env } from './env';
import { askOutputTokenLimit, consumeAskGeneration, prepareQuestion, streamingGenerationClient, type AskProject } from './ask';
import {
  ASK_GENERATION_CANCELLED, completeAskGeneration, failAskGeneration, getAskGeneration, updateAskGeneration,
  type StoredAskGeneration,
} from './ask-chats';
import { listWorkspaceProjects } from './lib/workspace-operations';
import { resolveAskModel } from './ask-models';

const encoder = new TextEncoder();
const frame = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function accessibleAskProjectsForUser(env: Env, userId: string): Promise<AskProject[]> {
  return listWorkspaceProjects(env, { userId });
}

/** Alarm entrypoint: inference is owned by a Durable Object alarm (15 minute wall-time budget),
 * not by the browser's HTTP connection. D1 is canonical so deleting the chat cancels the reader
 * at the next persisted checkpoint even if no browser is connected. */
export async function runAskGeneration(env: Env, generationId: string): Promise<void> {
  const generation = await getAskGeneration(env.DB, generationId);
  if (!generation || generation.status === 'completed' || generation.status === 'failed') return;
  let model;
  try {
    model = resolveAskModel(env, generation.model);
  } catch (error) {
    await failAskGeneration(env.DB, generationId, error instanceof Error ? error.message : 'Ask model configuration is invalid');
    return;
  }
  const gen = streamingGenerationClient(env, model.id);
  if (!gen) {
    await failAskGeneration(env.DB, generationId, 'no AI backend — asking questions requires the Workers AI (AI) binding');
    return;
  }

  let answer = generation.answer;
  let reasoning = generation.reasoning;
  let active = true;
  let lastWrite = 0;
  const base = {
    sources: generation.sources,
    trace: generation.trace,
    mode: generation.mode,
    model: generation.model,
    graphEnhanced: generation.graphEnhanced,
  };
  const persist = async (status: StoredAskGeneration['status'], force = false): Promise<boolean> => {
    const now = Date.now();
    if (!force && now - lastWrite < 150) return active;
    lastWrite = now;
    active = await updateAskGeneration(env.DB, generationId, { status, answer, reasoning, ...base });
    return active;
  };

  try {
    if (!await persist('searching', true)) return;
    const projects = await accessibleAskProjectsForUser(env, generation.userId);
    let retrievalUsed = false;
    const prepared = await prepareQuestion(env, {
      question: generation.question,
      projects,
      history: generation.history,
      model: model.id,
      onRetrieval: async () => {
        retrievalUsed = true;
        base.trace = ['Ask chose to search accessible Noriq evidence…'];
        await persist('searching', true);
      },
    });
    base.sources = prepared.sources;
    base.mode = prepared.mode;
    base.model = prepared.model;
    base.graphEnhanced = prepared.graphEnhanced;
    if (retrievalUsed && prepared.mode) {
      const projectCount = new Set(prepared.sources.map((source) => source.projectId)).size;
      const retrieval = `${prepared.mode}${prepared.graphEnhanced ? ' + graph' : ''}`;
      base.trace = [
        `Ask used search_noriq and selected ${prepared.sources.length} ${retrieval} source${prepared.sources.length === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'}.`,
        'Generating a grounded response…',
      ];
    } else {
      base.trace = ['No Noriq evidence was needed for this response.', 'Generating a general response…'];
    }
    if (!await persist('generating', true)) return;

    const result = await consumeAskGeneration(gen, prepared, {
      shouldContinue: () => active,
      onReasoning: async (delta) => {
        reasoning += delta;
        await persist('generating');
      },
      onDelta: async (delta) => {
        answer += delta;
        await persist('generating');
      },
    }, askOutputTokenLimit(env));
    if (!result || !active) return;
    answer = result.answer;
    reasoning = result.reasoning;
    base.trace = [...base.trace, result.truncated
      ? `Response truncated (${result.finishReason ?? 'token limit'}).`
      : 'Response complete.'];
    if (!await persist('generating', true)) return;
    await completeAskGeneration(env.DB, generationId, result.finishReason, result.truncated);
  } catch (error) {
    await failAskGeneration(env.DB, generationId, error instanceof Error ? error.message : 'generation failed');
  }
}

export interface AskGenerationStreamOptions {
  answerOffset?: number;
  reasoningOffset?: number;
  thread?: { id: string; title: string };
}

/** Replaying follower stream. Disconnecting only stops polling; it never touches inference. */
export function askGenerationEventStream(
  env: Env,
  userId: string,
  generationId: string,
  options: AskGenerationStreamOptions = {},
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let answerOffset = Math.max(0, options.answerOffset ?? 0);
      let reasoningOffset = Math.max(0, options.reasoningOffset ?? 0);
      let revision = -1;
      if (options.thread) controller.enqueue(frame('thread', options.thread));
      controller.enqueue(frame('generation', { id: generationId }));
      try {
        while (!cancelled) {
          const current = await getAskGeneration(env.DB, generationId, userId);
          if (!current) {
            controller.enqueue(frame('error', { error: 'generation not found' }));
            controller.close();
            return;
          }
          if (current.revision !== revision) {
            revision = current.revision;
            controller.enqueue(frame('meta', {
              sources: current.sources,
              mode: current.mode,
              model: current.model,
              graphEnhanced: current.graphEnhanced,
              trace: current.trace,
            }));
            controller.enqueue(frame('status', { phase: current.status }));
            if (current.reasoning.length > reasoningOffset) {
              controller.enqueue(frame('reasoning', { text: current.reasoning.slice(reasoningOffset) }));
              reasoningOffset = current.reasoning.length;
            }
            if (current.answer.length > answerOffset) {
              controller.enqueue(frame('delta', { text: current.answer.slice(answerOffset) }));
              answerOffset = current.answer.length;
            }
          }
          if (current.status === 'completed') {
            controller.enqueue(frame('done', {
              finishReason: current.finishReason,
              truncated: current.truncated,
            }));
            controller.close();
            return;
          }
          if (current.status === 'failed') {
            if (current.error === ASK_GENERATION_CANCELLED) {
              controller.enqueue(frame('cancelled', {}));
              controller.close();
              return;
            }
            controller.enqueue(frame('error', { error: current.error ?? 'generation failed' }));
            controller.close();
            return;
          }
          const delay = Math.min(Math.max(Number(env.ASK_STREAM_POLL_MS) || 250, 25), 2000);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        if (cancelled) return;
        controller.enqueue(frame('error', { error: error instanceof Error ? error.message : 'stream failed' }));
        controller.close();
      }
    },
    cancel() { cancelled = true; },
  });
}
