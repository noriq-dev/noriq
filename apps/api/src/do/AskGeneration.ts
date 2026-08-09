import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAskGeneration } from '../ask-generation';

/** One alarm-backed object per Ask generation. Alarm work has a 15 minute wall-time budget and
 * therefore continues independently of browser navigation or a disconnected SSE follower. */
export class AskGeneration extends DurableObject<Env> {
  async start(generationId: string): Promise<void> {
    await this.ctx.storage.put('generationId', generationId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const generationId = await this.ctx.storage.get<string>('generationId');
    if (!generationId) return;
    await runAskGeneration(this.env, generationId);
    await this.ctx.storage.delete('generationId');
  }
}
