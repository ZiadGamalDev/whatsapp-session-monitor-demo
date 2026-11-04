import { EventEmitter } from 'node:events';
import type { Clock, TimerHandle } from '../clock.js';
import type { AckStatus, ProviderEventMap, SessionProvider } from '../provider/types.js';

/**
 * Tracks every outbound message: sent -> delivered -> read | failed.
 *
 * Ack-timeout rule: a message that is still only `sent` (accepted by the
 * transport, no delivery receipt) `ackTimeoutMs` after it was sent is
 * flagged `undelivered` ("sent but never delivered") and counted against
 * its session. If a delivery receipt shows up later, the flag is cleared and
 * the message is marked `lateDelivery` so the incident is not lost.
 */

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type MessageSource = 'api' | 'synthetic' | 'cloud';

export interface TrackedMessage {
  id: string;
  sessionId: string;
  to: string;
  text: string;
  source: MessageSource;
  providerMessageId: string | null;
  status: MessageStatus;
  createdAt: number;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
  error: string | null;
  /** Flagged by the ack-timeout rule and still without a delivery receipt. */
  undelivered: boolean;
  flaggedAt: number | null;
  lateDelivery: boolean;
}

export interface TrackerOptions {
  clock: Clock;
  provider?: SessionProvider;
  ackTimeoutMs?: number;
  /** Max messages kept in memory (oldest settled ones are evicted first). */
  retain?: number;
}

const RANK: Record<MessageStatus, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export class DeliveryTracker extends EventEmitter {
  readonly ackTimeoutMs: number;
  private readonly clock: Clock;
  private readonly provider?: SessionProvider;
  private readonly retain: number;
  private readonly messages = new Map<string, TrackedMessage>();
  private readonly byProviderId = new Map<string, string>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly undeliveredBySession = new Map<string, number>();
  private readonly flaggedTotalBySession = new Map<string, number>();
  private seq = 0;
  private unmatched = 0;
  private readonly onAck: (p: ProviderEventMap['ack']) => void;

  constructor(opts: TrackerOptions) {
    super();
    this.clock = opts.clock;
    this.provider = opts.provider;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 60_000;
    this.retain = opts.retain ?? 5_000;
    this.onAck = (p) =>
      this.applyAck(p.id, p.status, {
        error: p.errorCode ? `${p.errorCode} ${p.errorTitle ?? ''}`.trim() : undefined,
      });
    this.provider?.on('ack', this.onAck);
  }

  stop(): void {
    this.provider?.off('ack', this.onAck);
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
  }

  /** Sends through the provider and starts tracking. */
  async send(sessionId: string, to: string, text: string, source: MessageSource = 'api'): Promise<TrackedMessage> {
    if (!this.provider) throw new Error('no provider configured');
    const msg = this.create(sessionId, to, text, source);
    let accepted = false;
    let error: string | undefined;
    let providerMessageId: string | undefined;
    try {
      const res = await this.provider.sendMessage(sessionId, { id: msg.id, to, text });
      accepted = res.accepted;
      error = res.error;
      providerMessageId = res.providerMessageId;
    } catch (err) {
      error = String(err);
    }
    if (!accepted) return this.update(msg, { status: 'failed', failedAt: this.clock.now(), error: error ?? 'rejected' });
    return this.markAccepted(msg.id, providerMessageId ?? msg.id);
  }

  /** Registers a message without sending it (e.g. sent by another system). */
  create(sessionId: string, to: string, text: string, source: MessageSource = 'api'): TrackedMessage {
    const id = `m${String(++this.seq).padStart(6, '0')}`;
    const msg: TrackedMessage = {
      id,
      sessionId,
      to,
      text,
      source,
      providerMessageId: null,
      status: 'pending',
      createdAt: this.clock.now(),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      error: null,
      undelivered: false,
      flaggedAt: null,
      lateDelivery: false,
    };
    this.messages.set(id, msg);
    this.prune();
    this.emit('change', msg);
    return msg;
  }

  /**
   * Records the provider id of a message the provider accepted but has not
   * reported as `sent` yet (Cloud API: HTTP 200 only means "accepted"; the
   * `sent` status arrives later by webhook). Status stays `pending`.
   */
  registerAccepted(id: string, providerMessageId: string): TrackedMessage {
    const msg = this.messages.get(id);
    if (!msg) throw new Error(`unknown message ${id}`);
    this.byProviderId.set(providerMessageId, id);
    return this.update(msg, { providerMessageId });
  }

  markAccepted(id: string, providerMessageId: string): TrackedMessage {
    const msg = this.messages.get(id);
    if (!msg) throw new Error(`unknown message ${id}`);
    this.byProviderId.set(providerMessageId, id);
    const updated = this.update(msg, { providerMessageId });
    return this.applyAck(providerMessageId, 'sent') ? this.messages.get(id)! : updated;
  }

  /**
   * Applies a receipt. Out-of-order receipts never move a message backwards
   * (a late `delivered` after `read` is ignored). Returns false if the id is
   * unknown.
   */
  applyAck(providerMessageId: string, status: AckStatus, opts: { at?: number; error?: string } = {}): boolean {
    const id = this.byProviderId.get(providerMessageId);
    const msg = id ? this.messages.get(id) : undefined;
    if (!msg) {
      this.unmatched++;
      return false;
    }
    const at = opts.at ?? this.clock.now();
    if (msg.status === 'failed' || msg.status === 'read') return true;
    if (status !== 'failed' && RANK[status] <= RANK[msg.status]) return true;

    const patch: Partial<TrackedMessage> = { status };
    if (status === 'sent') {
      patch.sentAt = at;
      this.armTimeout(msg.id);
    }
    if (status === 'delivered' || status === 'read') {
      patch.deliveredAt = msg.deliveredAt ?? at;
      if (status === 'read') patch.readAt = at;
      this.clearTimeout(msg.id);
      if (msg.undelivered) {
        patch.undelivered = false;
        patch.lateDelivery = true;
        this.bump(this.undeliveredBySession, msg.sessionId, -1);
      }
    }
    if (status === 'failed') {
      patch.failedAt = at;
      patch.error = opts.error ?? msg.error ?? 'failed';
      this.clearTimeout(msg.id);
      if (msg.undelivered) {
        patch.undelivered = false;
        this.bump(this.undeliveredBySession, msg.sessionId, -1);
      }
    }
    this.update(msg, patch);
    return true;
  }

  get(id: string): TrackedMessage | undefined {
    return this.messages.get(id);
  }

  findByProviderId(providerMessageId: string): TrackedMessage | undefined {
    const id = this.byProviderId.get(providerMessageId);
    return id ? this.messages.get(id) : undefined;
  }

  /** Messages currently flagged "sent but never delivered" for a session. */
  undeliveredCount(sessionId: string): number {
    return this.undeliveredBySession.get(sessionId) ?? 0;
  }

  /** Every message ever flagged for a session (including later-delivered ones). */
  flaggedTotal(sessionId: string): number {
    return this.flaggedTotalBySession.get(sessionId) ?? 0;
  }

  unmatchedReceipts(): number {
    return this.unmatched;
  }

  list(filter: { sessionId?: string; undeliveredOnly?: boolean; limit?: number } = {}): TrackedMessage[] {
    const out: TrackedMessage[] = [];
    for (const m of [...this.messages.values()].reverse()) {
      if (filter.sessionId && m.sessionId !== filter.sessionId) continue;
      if (filter.undeliveredOnly && !m.undelivered) continue;
      out.push(m);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  totals(): { total: number; undelivered: number; delivered: number; failed: number; read: number } {
    let undelivered = 0;
    let delivered = 0;
    let failed = 0;
    let read = 0;
    for (const m of this.messages.values()) {
      if (m.undelivered) undelivered++;
      if (m.status === 'delivered') delivered++;
      if (m.status === 'read') read++;
      if (m.status === 'failed') failed++;
    }
    return { total: this.messages.size, undelivered, delivered, failed, read };
  }

  // ---- internals ----------------------------------------------------------

  private armTimeout(id: string): void {
    this.clearTimeout(id);
    this.timers.set(
      id,
      this.clock.setTimeout(() => {
        this.timers.delete(id);
        const msg = this.messages.get(id);
        if (!msg || msg.status !== 'sent') return;
        this.bump(this.undeliveredBySession, msg.sessionId, 1);
        this.bump(this.flaggedTotalBySession, msg.sessionId, 1);
        const flagged = this.update(msg, { undelivered: true, flaggedAt: this.clock.now() });
        this.emit('undelivered', flagged);
      }, this.ackTimeoutMs),
    );
  }

  private clearTimeout(id: string): void {
    const t = this.timers.get(id);
    if (t) this.clock.clearTimeout(t);
    this.timers.delete(id);
  }

  private bump(map: Map<string, number>, key: string, by: number): void {
    map.set(key, Math.max(0, (map.get(key) ?? 0) + by));
  }

  private update(msg: TrackedMessage, patch: Partial<TrackedMessage>): TrackedMessage {
    const next = { ...msg, ...patch };
    this.messages.set(msg.id, next);
    this.emit('change', next);
    return next;
  }

  private prune(): void {
    if (this.messages.size <= this.retain) return;
    for (const [id, m] of this.messages) {
      if (this.messages.size <= this.retain) break;
      if (m.status === 'read' || m.status === 'failed' || m.status === 'delivered') {
        this.messages.delete(id);
        if (m.providerMessageId) this.byProviderId.delete(m.providerMessageId);
      }
    }
  }
}
