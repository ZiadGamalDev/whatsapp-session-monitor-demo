import { Redis } from 'ioredis';
import type { StateStore, StoredSession } from './state-store.js';

/**
 * Optional Redis-backed state store (enabled with REDIS_URL). Sessions are
 * kept in one hash; every write is also published on `<prefix>:changes` so
 * other processes (a second dashboard, an alerting worker) can follow along.
 */
export class RedisStateStore implements StateStore {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;
  private readonly key: string;
  private readonly channel: string;

  constructor(url: string, prefix = 'wsm') {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.key = `${prefix}:sessions`;
    this.channel = `${prefix}:changes`;
  }

  async put(sessions: StoredSession[]): Promise<void> {
    if (sessions.length === 0) return;
    const args: string[] = [];
    for (const s of sessions) args.push(s.id, JSON.stringify(s));
    await this.redis.multi().hset(this.key, ...args).publish(this.channel, JSON.stringify(sessions.map((s) => s.id))).exec();
  }

  async get(id: string): Promise<StoredSession | null> {
    const v = await this.redis.hget(this.key, id);
    return v ? (JSON.parse(v) as StoredSession) : null;
  }

  async all(): Promise<StoredSession[]> {
    const h = await this.redis.hgetall(this.key);
    return Object.values(h)
      .map((v) => JSON.parse(v) as StoredSession)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async clear(): Promise<void> {
    await this.redis.del(this.key);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
