import type { DatabaseSync } from 'node:sqlite';

/**
 * Conversation storage for the simulated Cloud API number (node:sqlite).
 * Outbound delivery status is NOT stored here: it lives in the delivery
 * tracker's `messages` table and is joined by `trackerId`, so the inbox and
 * the delivery-gap report read the same truth.
 */

export type ContactBehavior = 'ok' | 'offline' | 'not_on_whatsapp' | 'marketing_blocked' | 'flaky';

export interface Contact {
  waId: string;
  name: string;
  behavior: ContactBehavior;
  lastInboundAt: number | null;
}

export interface ConversationMessage {
  id: number;
  waId: string;
  direction: 'in' | 'out';
  wamid: string;
  kind: 'text' | 'template';
  templateName: string | null;
  body: string;
  at: number;
  trackerId: string | null;
  seeded: boolean;
}

type Row = Record<string, string | number | null>;

export class CloudStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_contacts (
        wa_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        behavior TEXT NOT NULL,
        last_inbound_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cloud_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        wamid TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        template_name TEXT,
        body TEXT NOT NULL,
        at INTEGER NOT NULL,
        tracker_id TEXT,
        seeded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cloud_messages_conv ON cloud_messages(wa_id, at);
      CREATE TABLE IF NOT EXISTS webhook_seen (
        key TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `);
  }

  reset(): void {
    this.db.exec('DELETE FROM cloud_contacts; DELETE FROM cloud_messages; DELETE FROM webhook_seen;');
  }

  upsertContact(c: Contact): void {
    this.db
      .prepare(
        `INSERT INTO cloud_contacts (wa_id, name, behavior, last_inbound_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(wa_id) DO UPDATE SET name = excluded.name, behavior = excluded.behavior,
           last_inbound_at = MAX(COALESCE(cloud_contacts.last_inbound_at, 0), COALESCE(excluded.last_inbound_at, 0))`,
      )
      .run(c.waId, c.name, c.behavior, c.lastInboundAt);
  }

  contact(waId: string): Contact | null {
    const r = this.db.prepare('SELECT * FROM cloud_contacts WHERE wa_id = ?').get(waId) as Row | undefined;
    return r ? toContact(r) : null;
  }

  contacts(): Contact[] {
    return (this.db.prepare('SELECT * FROM cloud_contacts ORDER BY wa_id').all() as Row[]).map(toContact);
  }

  /** Returns false if this wamid was already stored (idempotent insert). */
  addMessage(m: Omit<ConversationMessage, 'id'>): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO cloud_messages (wa_id, direction, wamid, kind, template_name, body, at, tracker_id, seeded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.waId, m.direction, m.wamid, m.kind, m.templateName, m.body, m.at, m.trackerId, m.seeded ? 1 : 0);
    if (res.changes === 0) return false;
    if (m.direction === 'in') {
      this.db
        .prepare('UPDATE cloud_contacts SET last_inbound_at = MAX(COALESCE(last_inbound_at, 0), ?) WHERE wa_id = ?')
        .run(m.at, m.waId);
    }
    return true;
  }

  thread(waId: string, limit = 100): ConversationMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM cloud_messages WHERE wa_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(waId, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  lastMessage(waId: string): ConversationMessage | null {
    const r = this.db
      .prepare('SELECT * FROM cloud_messages WHERE wa_id = ? ORDER BY at DESC, id DESC LIMIT 1')
      .get(waId) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** Idempotency key store: true the first time a key is seen. */
  markSeen(key: string, at: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO webhook_seen (key, at) VALUES (?, ?)').run(key, at).changes > 0;
  }

  pruneSeen(olderThan: number): void {
    this.db.prepare('DELETE FROM webhook_seen WHERE at < ?').run(olderThan);
  }
}

function toContact(r: Row): Contact {
  return {
    waId: String(r.wa_id),
    name: String(r.name),
    behavior: r.behavior as ContactBehavior,
    lastInboundAt: r.last_inbound_at === null || Number(r.last_inbound_at) === 0 ? null : Number(r.last_inbound_at),
  };
}

function toMessage(r: Row): ConversationMessage {
  return {
    id: Number(r.id),
    waId: String(r.wa_id),
    direction: r.direction as 'in' | 'out',
    wamid: String(r.wamid),
    kind: r.kind as 'text' | 'template',
    templateName: r.template_name === null ? null : String(r.template_name),
    body: String(r.body),
    at: Number(r.at),
    trackerId: r.tracker_id === null ? null : String(r.tracker_id),
    seeded: Number(r.seeded) === 1,
  };
}
