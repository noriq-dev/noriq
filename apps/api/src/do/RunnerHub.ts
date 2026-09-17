import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * Historical class for wrangler migration tag v3. Existing instances keep
 * storage; the Worker no longer binds RUNNER_HUB or routes to this class.
 * Do not add a `deleted_classes` migration — that wipes the namespace permanently.
 */
export class RunnerHub extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response('gone', { status: 410 });
  }

  async alarm(): Promise<void> {
    // Leftover objects may still have alarms; do not reschedule.
  }
}
