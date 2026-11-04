import type { EventEmitter } from 'node:events';
import type { Clock } from '../clock.js';
import type { DeliveryTracker, TrackedMessage } from '../delivery/tracker.js';
import type { AckStatus } from '../provider/types.js';
import { between, deriveSeed, mulberry32 } from '../rng.js';
import { hubSignature } from '../cloud-api/statuses.js';
import type { MonitorDb } from '../store/db.js';
import { cloudError, statusError, type ErrorCode } from './errors.js';
import { inboundPayload, statusPayload } from './payloads.js';
import type { CloudStore, Contact, ContactBehavior } from './store.js';
import { TEMPLATES, checkTemplate, type TemplateRequest } from './templates.js';
import { WINDOW_MS, windowState } from './window.js';

/**
 * SIMULATED WhatsApp Cloud API number. Nothing here talks to Meta.
 *
 * - `send()` behaves like POST /{phone-number-id}/messages: it validates the
 *   request, returns a Meta-shaped 200 (`messages[].id` = wamid) or error,
 *   and HTTP 200 only means "accepted".
 * - The outcome then arrives the way it does on the real platform: as signed
 *   status webhooks (sent → delivered → read, or failed with an error code)
 *   delivered through this app's own POST /webhooks/cloud-api route, with
 *   X-Hub-Signature-256. The receiving side cannot tell it apart from Meta.
 * - Customers are seeded fake contacts (+999 numbers); some write in, which
 *   opens the 24-hour customer service window.
 */

export const CLOUD_SESSION_ID = 'cloud';

export interface CloudSimOptions {
  clock: Clock;
  seed: number;
  store: CloudStore;
  tracker: DeliveryTracker;
  db: MonitorDb;
  bus: EventEmitter;
  secret: string;
  /** Reject free-form text outside the window locally (default true). */
  enforceWindow: boolean;
  inboundIntervalMs: number;
}

export type Transport = (rawBody: string, signature: string) => Promise<void>;

export interface SendRequest {
  messaging_product?: unknown;
  recipient_type?: unknown;
  to?: unknown;
  type?: unknown;
  text?: { body?: unknown };
  template?: TemplateRequest;
}

export type SendResult =
  | {
      status: 200;
      body: {
        messaging_product: 'whatsapp';
        contacts: Array<{ input: string; wa_id: string }>;
        messages: Array<{ id: string; message_status: 'accepted' }>;
        simulated: true;
      };
      trackerId: string;
    }
  | { status: number; body: ReturnType<typeof cloudError> & { simulated: true; source: 'api' | 'local_guard' } };

const INBOUND_TEXTS = [
  'مرحباً، متى يصل طلبي؟',
  'هل يمكن تغيير موعد التوصيل؟',
  'شكراً، وصلني الإشعار.',
  'أحتاج نسخة من الفاتورة.',
  'هل الخدمة متاحة يوم الجمعة؟',
  'Hi, is my order on the way?',
];
const REPLY_TEXTS = ['أهلاً بك، طلبك قيد التجهيز.', 'تم تحديث الموعد كما طلبت.', 'سنرسل الفاتورة اليوم.', 'نعم، الخدمة متاحة.'];

/** How long ago each seeded contact last wrote: open, closing soon, closed. */
const LAST_INBOUND_AGO_H = [0.3, 1.5, 4, 9, 20, 23.75, 27, 31, 50, 70, 96, 144];
const BEHAVIORS: ContactBehavior[] = [
  'ok',
  'ok',
  'offline',
  'ok',
  'marketing_blocked',
  'ok',
  'not_on_whatsapp',
  'ok',
  'flaky',
  'ok',
  'offline',
  'ok',
];

interface Outcome {
  fail?: { code: ErrorCode; details: string; afterSent: boolean };
  sentAfter: number;
  deliveredAfter: number | null;
  readAfter: number | null;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export function displayNumber(waId: string): string {
  // 99971000001 -> +999 7100 0001
  return `+${waId.slice(0, 3)} ${waId.slice(3, 7)} ${waId.slice(7)}`;
}

export function toWaId(input: string): string | null {
  const digits = input.replace(/[\s+()-]/g, '');
  return /^999\d{4,12}$/.test(digits) ? digits : null;
}

export class CloudApiSimulator {
  private transport: Transport | null = null;
  private readonly rand: () => number;
  private readonly pending = new Set<Promise<void>>();
  private seq = 0;
  private inboundHandle?: ReturnType<Clock['setInterval']>;

  constructor(private readonly o: CloudSimOptions) {
    this.rand = mulberry32(deriveSeed(o.seed, 'cloud-sim'));
  }

  setTransport(t: Transport): void {
    this.transport = t;
  }

  /** Seeds fake contacts and 7 days of settled history (flagged `seeded`). */
  seed(): void {
    const now = this.o.clock.now();
    const r = mulberry32(deriveSeed(this.o.seed, 'cloud-history'));
    LAST_INBOUND_AGO_H.forEach((agoH, i) => {
      const waId = `9997100${pad(i + 1, 4)}`;
      const contact: Contact = {
        waId,
        name: `Demo customer ${pad(i + 1, 2)}`,
        behavior: BEHAVIORS[i]!,
        lastInboundAt: null,
      };
      this.o.store.upsertContact(contact);
      const last = now - Math.round(agoH * 3_600_000);
      // A few earlier conversations over the past 7 days, then the last one.
      const starts: number[] = [];
      const n = between(r, 1, 4);
      for (let k = 0; k < n; k++) starts.push(now - between(r, Math.round(agoH * 3_600_000) + 3_600_000, 7 * 86_400_000));
      starts.sort((a, b) => a - b).push(last);
      for (const at of starts) {
        if (at < now - 7 * 86_400_000) continue;
        this.o.store.addMessage({
          waId,
          direction: 'in',
          wamid: `wamid.SIM.IN.${waId}.${at}`,
          kind: 'text',
          templateName: null,
          body: INBOUND_TEXTS[between(r, 0, INBOUND_TEXTS.length - 1)]!,
          at,
          trackerId: null,
          seeded: true,
        });
        // Agent replies inside the window, a few minutes later.
        const replies = between(r, 0, 2);
        for (let k = 0; k < replies; k++) {
          const sentAt = at + between(r, 60_000, 25 * 60_000) * (k + 1);
          if (sentAt > now - 120_000) continue;
          this.seedOutbound(contact, 'text', REPLY_TEXTS[between(r, 0, REPLY_TEXTS.length - 1)]!, null, sentAt, r, now);
        }
      }
      // Templates sent outside the window (allowed), spread over the week.
      const templates = between(r, 1, 4);
      for (let k = 0; k < templates; k++) {
        const def = TEMPLATES[between(r, 0, TEMPLATES.length - 1)]!;
        const sentAt = now - between(r, 10 * 60_000, 7 * 86_400_000 - 60_000);
        const params = def.params === 0 ? [] : def.params === 1 ? [`#A${between(r, 1000, 9999)}`] : ['2026-01-05', '10:30'];
        const body = def.body.ar.replace(/\{\{(\d)\}\}/g, (_, j: string) => params[Number(j) - 1] ?? '');
        this.seedOutbound(contact, 'template', body, def.name, sentAt, r, now);
      }
    });
  }

  start(): void {
    this.inboundHandle = this.o.clock.setInterval(() => this.randomInbound(), this.o.inboundIntervalMs);
  }

  stop(): void {
    this.o.clock.clearInterval(this.inboundHandle);
  }

  /** Resolves when every webhook issued so far has been processed. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** POST /{phone-number-id}/messages, simulated. */
  send(req: SendRequest): SendResult {
    const now = this.o.clock.now();
    const bad = (details: string): SendResult => ({
      status: 400,
      body: { ...cloudError(100, details), simulated: true, source: 'api' },
    });
    if (req.messaging_product !== undefined && req.messaging_product !== 'whatsapp') {
      return bad('messaging_product must be "whatsapp"');
    }
    const waId = typeof req.to === 'string' ? toWaId(req.to) : null;
    if (!waId) return bad('to must be a number in the fake +999 range (this is a simulator)');
    let kind: 'text' | 'template';
    let body: string;
    let templateName: string | null = null;
    let marketing = false;
    if (req.type === 'text') {
      const t = req.text?.body;
      if (typeof t !== 'string' || t.trim() === '' || t.length > 4096) return bad('text.body is required (1-4096 chars)');
      kind = 'text';
      body = t;
    } else if (req.type === 'template') {
      const check = checkTemplate(req.template);
      if (!check.ok) return { status: check.status, body: { ...check.body, simulated: true, source: 'api' } };
      kind = 'template';
      body = check.text;
      templateName = check.def.name;
      marketing = check.def.category === 'MARKETING';
    } else {
      return { status: 400, body: { ...cloudError(131051, `type ${String(req.type)} is not supported here`), simulated: true, source: 'api' } };
    }

    const contact = this.o.store.contact(waId) ?? {
      waId,
      name: displayNumber(waId),
      behavior: 'not_on_whatsapp' as const,
      lastInboundAt: null,
    };
    const win = windowState(contact.lastInboundAt, now);
    if (kind === 'text' && !win.open && this.o.enforceWindow) {
      // Meta accepts this and fails it later with 131047; we stop it before
      // it is sent so nobody mistakes "accepted" for "delivered".
      return {
        status: 422,
        body: {
          ...cloudError(
            131047,
            'More than 24 hours have passed since the customer last replied. Send an approved template instead.',
          ),
          simulated: true,
          source: 'local_guard',
        },
      };
    }

    const wamid = `wamid.SIM.CLOUD.${pad(++this.seq, 6)}`;
    const msg = this.o.tracker.create(CLOUD_SESSION_ID, displayNumber(waId), body, 'cloud');
    this.o.tracker.registerAccepted(msg.id, wamid);
    this.o.store.upsertContact(contact);
    this.o.store.addMessage({
      waId,
      direction: 'out',
      wamid,
      kind,
      templateName,
      body,
      at: now,
      trackerId: msg.id,
      seeded: false,
    });
    this.o.bus.emit('inbox', { waId });

    const outcome =
      kind === 'text' && !win.open
        ? { fail: { code: 131047 as const, details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.', afterSent: false }, sentAfter: 600, deliveredAfter: null, readAfter: null }
        : this.outcome(contact.behavior, marketing, this.rand);
    this.scheduleStatuses(wamid, waId, outcome);
    return {
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: String(req.to), wa_id: waId }],
        messages: [{ id: wamid, message_status: 'accepted' }],
        simulated: true,
      },
      trackerId: msg.id,
    };
  }

  /** A simulated customer writes in (opens / extends the 24 h window). */
  customerReply(waId: string, text: string): string {
    const c = this.o.store.contact(waId);
    if (!c) throw new Error('unknown contact');
    const at = this.o.clock.now();
    const wamid = `wamid.SIM.IN.${waId}.${at}.${++this.seq}`;
    this.emit(inboundPayload({ wamid, from: waId, name: c.name, at, text }));
    return wamid;
  }

  // ---- internals ----------------------------------------------------------

  private outcome(behavior: ContactBehavior, marketing: boolean, r: () => number): Outcome {
    const sentAfter = between(r, 300, 1_200);
    if (behavior === 'not_on_whatsapp') {
      return {
        fail: { code: 131026, details: 'Message Undeliverable. The recipient may not be on WhatsApp or may be using an old version.', afterSent: false },
        sentAfter,
        deliveredAfter: null,
        readAfter: null,
      };
    }
    if (behavior === 'marketing_blocked' && marketing) {
      return {
        fail: { code: 131049, details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.', afterSent: true },
        sentAfter,
        deliveredAfter: null,
        readAfter: null,
      };
    }
    if (behavior === 'flaky' && r() < 0.35) {
      return { fail: { code: 131000, details: 'Something went wrong.', afterSent: true }, sentAfter, deliveredAfter: null, readAfter: null };
    }
    if (behavior === 'offline') {
      // Phone off: no receipt for minutes (crosses the ack timeout), sometimes never.
      const never = r() < 0.4;
      return { sentAfter, deliveredAfter: never ? null : between(r, 120_000, 600_000), readAfter: null };
    }
    const deliveredAfter = sentAfter + between(r, 800, 6_000);
    return { sentAfter, deliveredAfter, readAfter: r() < 0.6 ? deliveredAfter + between(r, 5_000, 300_000) : null };
  }

  private scheduleStatuses(wamid: string, waId: string, o: Outcome): void {
    const at = (ms: number, status: AckStatus, errors?: unknown[]) =>
      this.o.clock.setTimeout(() => {
        this.emit(statusPayload({ wamid, status, at: this.o.clock.now(), recipientId: waId, errors }));
      }, ms);
    if (o.fail && !o.fail.afterSent) {
      at(o.sentAfter, 'failed', [statusError(o.fail.code, o.fail.details)]);
      return;
    }
    at(o.sentAfter, 'sent');
    if (o.fail) {
      at(o.sentAfter + between(this.rand, 1_000, 4_000), 'failed', [statusError(o.fail.code, o.fail.details)]);
      return;
    }
    if (o.deliveredAfter !== null) at(o.deliveredAfter, 'delivered');
    if (o.readAfter !== null) at(o.readAfter, 'read');
  }

  private seedOutbound(
    contact: Contact,
    kind: 'text' | 'template',
    body: string,
    templateName: string | null,
    sentAt: number,
    r: () => number,
    now: number,
  ): void {
    const o = this.outcome(contact.behavior, templateName === 'seasonal_offer', r);
    const id = `h${pad(++this.seq, 6)}`;
    const wamid = `wamid.SIM.HIST.${pad(this.seq, 6)}`;
    const done = (ms: number | null) => (ms === null || sentAt + ms > now ? null : sentAt + ms);
    const sent = o.fail && !o.fail.afterSent ? null : done(o.sentAfter);
    const failedAt = o.fail ? done(o.sentAfter + 2_000) : null;
    const deliveredAt = o.fail ? null : done(o.deliveredAfter);
    const readAt = o.fail || deliveredAt === null ? null : done(o.readAfter);
    const status: TrackedMessage['status'] = failedAt
      ? 'failed'
      : readAt
        ? 'read'
        : deliveredAt
          ? 'delivered'
          : sent
            ? 'sent'
            : 'pending';
    const flagged = status === 'sent' && sent !== null && now - sent >= this.o.tracker.ackTimeoutMs;
    const m: TrackedMessage = {
      id,
      sessionId: CLOUD_SESSION_ID,
      to: displayNumber(contact.waId),
      text: body,
      source: 'cloud',
      providerMessageId: wamid,
      status,
      createdAt: sentAt,
      sentAt: sent,
      deliveredAt,
      readAt,
      failedAt,
      error: failedAt && o.fail ? `${o.fail.code} ${statusError(o.fail.code, '').title}` : null,
      undelivered: flagged,
      flaggedAt: flagged ? sent! + this.o.tracker.ackTimeoutMs : null,
      lateDelivery: deliveredAt !== null && sent !== null && deliveredAt - sent >= this.o.tracker.ackTimeoutMs,
    };
    this.o.db.upsertMessage(m);
    this.o.store.addMessage({ waId: contact.waId, direction: 'out', wamid, kind, templateName, body, at: sentAt, trackerId: id, seeded: true });
  }

  private randomInbound(): void {
    const contacts = this.o.store.contacts().filter((c) => c.behavior !== 'not_on_whatsapp');
    if (!contacts.length) return;
    const c = contacts[Math.floor(this.rand() * contacts.length)]!;
    this.customerReply(c.waId, INBOUND_TEXTS[Math.floor(this.rand() * INBOUND_TEXTS.length)]!);
  }

  private emit(payload: unknown): void {
    const raw = JSON.stringify(payload);
    const sig = hubSignature(this.o.secret, raw);
    if (!this.transport) return;
    const p = this.transport(raw, sig)
      .catch((err) => {
        this.o.bus.emit('cloud-error', err);
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}

export { WINDOW_MS };
