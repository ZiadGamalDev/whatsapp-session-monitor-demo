import { createHash } from 'node:crypto';
import type { Credentials } from '../provider/types.js';

/**
 * Holds the (simulated) linked-device credentials per session.
 * `wipe` is called from exactly one place: the monitor's handling of the
 * `wipe_credentials` effect, which only the explicit `relink` input emits.
 */
export interface CredentialStore {
  get(sessionId: string): Credentials | undefined;
  /** Issues the next generation (1 for a new session). */
  issue(sessionId: string, now: number): Credentials;
  wipe(sessionId: string): void;
  /** How many times credentials were wiped (surfaced in the UI and tests). */
  wipeCount(sessionId: string): number;
}

export function fingerprint(sessionId: string, generation: number): string {
  return createHash('sha256').update(`simulated:${sessionId}:${generation}`).digest('hex').slice(0, 10);
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly creds = new Map<string, Credentials>();
  private readonly generations = new Map<string, number>();
  private readonly wipes = new Map<string, number>();

  get(sessionId: string): Credentials | undefined {
    return this.creds.get(sessionId);
  }

  issue(sessionId: string, now: number): Credentials {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const c: Credentials = { sessionId, generation, fingerprint: fingerprint(sessionId, generation), createdAt: now };
    this.creds.set(sessionId, c);
    return c;
  }

  wipe(sessionId: string): void {
    this.creds.delete(sessionId);
    this.wipes.set(sessionId, (this.wipes.get(sessionId) ?? 0) + 1);
  }

  wipeCount(sessionId: string): number {
    return this.wipes.get(sessionId) ?? 0;
  }
}
