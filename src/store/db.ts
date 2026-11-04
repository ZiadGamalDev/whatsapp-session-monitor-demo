import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TrackedMessage } from '../delivery/tracker.js';
import type { TimelineEntry } from '../monitor/monitor.js';

/**
 * History store on the built-in `node:sqlite` (no native build step).
 * Holds the event timeline, message history and alert log. Current session
 * state lives in the `StateStore` (memory or Redis).
 */

export interface AlertRow {
  id: number;
  sessionId: string;
  at: number;
  type: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  deliveryStatus: 'not_configured' | 'pending' | 'delivered' | 'retrying' | 'failed';
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  channels: string[];
}

type Row = Record<string, string | number | null>;

export class MonitorDb {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        code TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS timeline_session ON timeline(session_id, id);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_message_id TEXT,
        status TEXT NOT NULL,
        undelivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        reason TEXT,
        delivery_status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_error TEXT,
        channels TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  /** The simulated fleet restarts from its seed, so history restarts too. */
  reset(): void {
    this.db.exec('DELETE FROM timeline; DELETE FROM messages; DELETE FROM alerts;');
  }

  close(): void {
    this.db.close();
  }

  addTimeline(e: TimelineEntry): void {
    this.db
      .prepare('INSERT INTO timeline (session_id, at, kind, code, detail) VALUES (?, ?, ?, ?, ?)')
      .run(e.sessionId, e.at, e.kind, e.code, e.detail ? JSON.stringify(e.detail) : null);
  }

  timeline(sessionId: string, limit = 200): TimelineEntry[] {
    const rows = this.db
      .prepare('SELECT session_id, at, kind, code, detail FROM timeline WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as Row[];
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      at: Number(r.at),
      kind: r.kind as TimelineEntry['kind'],
      code: String(r.code),
      detail: r.detail ? JSON.parse(String(r.detail)) : undefined,
    }));
  }

  upsertMessage(m: TrackedMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, provider_message_id, status, undelivered, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider_message_id = excluded.provider_message_id,
           status = excluded.status, undelivered = excluded.undelivered, data = excluded.data`,
      )
      .run(m.id, m.sessionId, m.providerMessageId, m.status, m.undelivered ? 1 : 0, m.createdAt, JSON.stringify(m));
  }

  messages(filter: { sessionId?: string; undeliveredOnly?: boolean; limit?: number } = {}): TrackedMessage[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      args.push(filter.sessionId);
    }
    if (filter.undeliveredOnly) where.push('undelivered = 1');
    const sql = `SELECT data FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC, id DESC LIMIT ?`;
    args.push(filter.limit ?? 100);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(String(r.data)) as TrackedMessage);
  }

  /** Totals over the same table the message list reads, so the two always agree. */
  messageTotals(filter: { sessionId?: string } = {}): { total: number; undelivered: number; delivered: number; read: number; failed: number } {
    const where = filter.sessionId ? 'WHERE session_id = ?' : '';
    const args = filter.sessionId ? [filter.sessionId] : [];
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(undelivered), 0) AS undelivered,
                COALESCE(SUM(status = 'delivered'), 0) AS delivered,
                COALESCE(SUM(status = 'read'), 0) AS read,
                COALESCE(SUM(status = 'failed'), 0) AS failed
         FROM messages ${where}`,
      )
      .get(...args) as Row;
    return {
      total: Number(r.total),
      undelivered: Number(r.undelivered),
      delivered: Number(r.delivered),
      read: Number(r.read),
      failed: Number(r.failed),
    };
  }

  getMessage(id: string): TrackedMessage | null {
    const r = this.db.prepare('SELECT data FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as TrackedMessage) : null;
  }

  /** Every message created at or after `since` (for reports). */
  messagesSince(since: number): TrackedMessage[] {
    return (this.db.prepare('SELECT data FROM messages WHERE created_at >= ? ORDER BY created_at').all(since) as Row[]).map(
      (r) => JSON.parse(String(r.data)) as TrackedMessage,
    );
  }

  insertAlert(a: Omit<AlertRow, 'id'>): AlertRow {
    const res = this.db
      .prepare(
        `INSERT INTO alerts (session_id, at, type, from_state, to_state, reason, delivery_status, attempts,
           last_attempt_at, last_error, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.sessionId,
        a.at,
        a.type,
        a.fromState,
        a.toState,
        a.reason,
        a.deliveryStatus,
        a.attempts,
        a.lastAttemptAt,
        a.lastError,
        JSON.stringify(a.channels),
      );
    return { ...a, id: Number(res.lastInsertRowid) };
  }

  updateAlertDelivery(
    id: number,
    patch: Pick<AlertRow, 'deliveryStatus' | 'attempts' | 'lastAttemptAt' | 'lastError'>,
  ): void {
    this.db
      .prepare('UPDATE alerts SET delivery_status = ?, attempts = ?, last_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(patch.deliveryStatus, patch.attempts, patch.lastAttemptAt, patch.lastError, id);
  }

  alerts(filter: { sessionId?: string; limit?: number } = {}): AlertRow[] {
    const rows = (
      filter.sessionId
        ? this.db.prepare('SELECT * FROM alerts WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(filter.sessionId, filter.limit ?? 100)
        : this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(filter.limit ?? 100)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      sessionId: String(r.session_id),
      at: Number(r.at),
      type: String(r.type),
      fromState: r.from_state === null ? null : String(r.from_state),
      toState: r.to_state === null ? null : String(r.to_state),
      reason: r.reason === null ? null : String(r.reason),
      deliveryStatus: r.delivery_status as AlertRow['deliveryStatus'],
      attempts: Number(r.attempts),
      lastAttemptAt: r.last_attempt_at === null ? null : Number(r.last_attempt_at),
      lastError: r.last_error === null ? null : String(r.last_error),
      channels: JSON.parse(String(r.channels)) as string[],
    }));
  }

  alertCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as Row).n);
  }
}
