import type { Env } from './env';

export const DEFAULT_ASK_MODEL_ID = '@cf/openai/gpt-oss-120b';

export interface AskModelCapabilities {
  tools: true;
  streaming: true;
  reasoningSummary: boolean;
}

export interface AskModelDefinition {
  id: string;
  label: string;
  capabilities: AskModelCapabilities;
}

export interface AskModelCatalog {
  models: AskModelDefinition[];
  defaultModel: string;
}

export class AskModelConfigurationError extends Error {}
export class AskModelSelectionError extends Error {}

const builtInCatalog: AskModelCatalog = {
  models: [{
    id: DEFAULT_ASK_MODEL_ID,
    label: 'GPT-OSS 120B',
    capabilities: { tools: true, streaming: true, reasoningSummary: true },
  }],
  defaultModel: DEFAULT_ASK_MODEL_ID,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse the operator allowlist. An absent value keeps the compatible one-model default, while
 * an explicitly malformed value fails closed instead of silently widening or changing models. */
export function askModelCatalog(env: Pick<Env, 'ASK_MODELS' | 'ASK_DEFAULT_MODEL'>): AskModelCatalog {
  if (env.ASK_MODELS === undefined) return builtInCatalog;
  let raw: unknown;
  try {
    raw = JSON.parse(env.ASK_MODELS);
  } catch {
    throw new AskModelConfigurationError('ASK_MODELS must be a JSON array');
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new AskModelConfigurationError('ASK_MODELS must contain 1 to 20 models');
  }
  const seen = new Set<string>();
  const models = raw.map((item, index): AskModelDefinition => {
    if (!isObject(item)) throw new AskModelConfigurationError(`ASK_MODELS[${index}] must be an object`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const capabilities = item.capabilities;
    if (!/^@[A-Za-z0-9._/-]{1,199}$/.test(id)) {
      throw new AskModelConfigurationError(`ASK_MODELS[${index}].id is invalid`);
    }
    if (!label || label.length > 80) {
      throw new AskModelConfigurationError(`ASK_MODELS[${index}].label must contain 1 to 80 characters`);
    }
    if (seen.has(id)) throw new AskModelConfigurationError(`ASK_MODELS contains duplicate model ${id}`);
    seen.add(id);
    if (!isObject(capabilities) || capabilities.tools !== true || capabilities.streaming !== true) {
      throw new AskModelConfigurationError(`ASK_MODELS[${index}] must support tools and streaming`);
    }
    return {
      id,
      label,
      capabilities: {
        tools: true,
        streaming: true,
        reasoningSummary: capabilities.reasoningSummary === true,
      },
    };
  });
  const defaultModel = env.ASK_DEFAULT_MODEL?.trim() || models[0]!.id;
  if (!seen.has(defaultModel)) {
    throw new AskModelConfigurationError('ASK_DEFAULT_MODEL must name a model in ASK_MODELS');
  }
  return { models, defaultModel };
}

/** Resolve a browser selection only through the configured allowlist. */
export function resolveAskModel(
  env: Pick<Env, 'ASK_MODELS' | 'ASK_DEFAULT_MODEL'>,
  requested?: unknown,
): AskModelDefinition {
  const catalog = askModelCatalog(env);
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    throw new AskModelSelectionError('Ask model must be a model id string');
  }
  const id = typeof requested === 'string' && requested.trim() ? requested.trim() : catalog.defaultModel;
  const model = catalog.models.find((candidate) => candidate.id === id);
  if (!model) throw new AskModelSelectionError(`Ask model is not available: ${id}`);
  return model;
}
