import type { SessionRecord } from '../monitor/state-machine.js';

/**
 * Current per-session state as other readers (API, other instances) see it.
 * Heartbeat age is derived at read time from `lastHeartbeatAt`, so a stale
 * write can never make a dead session look fresh.
 */
export interface StoredSession extends SessionRecord {
  label: string;
  phone: string;
  credentialFingerprint: string | null;
  credentialGeneration: number | null;
  credentialWipes: number;
  undelivered: number;
  flaggedTotal: number;
  updatedAt: number;
}

export interface StateStore {
  readonly kind: 'memory' | 'redis';
  put(sessions: StoredSession[]): Promise<void>;
  get(id: string): Promise<StoredSession | null>;
  all(): Promise<StoredSession[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, StoredSession>();

  async put(sessions: StoredSession[]): Promise<void> {
    for (const s of sessions) this.map.set(s.id, s);
  }

  async get(id: string): Promise<StoredSession | null> {
    return this.map.get(id) ?? null;
  }

  async all(): Promise<StoredSession[]> {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async close(): Promise<void> {}
}
