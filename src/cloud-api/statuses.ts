import { createHmac } from 'node:crypto';
import type { AckStatus } from '../provider/types.js';
import { safeEqual } from '../server/auth.js';

/**
 * Parser for WhatsApp Cloud API *status* webhooks, written from Meta's public
 * documentation only (no SDK, no unofficial client):
 *
 *   Payload structure and fields (object, entry[].changes[].value.statuses[]):
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/status
 *   Payload examples:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *   X-Hub-Signature-256 and the hub.* verification request:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *
 * Only `statuses` are read (sent / delivered / read / failed). Inbound
 * `messages` in the same payload are ignored: this demo does not process
 * inbound traffic.
 */

export interface CloudApiStatusError {
  code: number | null;
  title: string | null;
  message: string | null;
  details: string | null;
}

export interface CloudApiStatus {
  /** WhatsApp message id (`wamid.…`). */
  id: string;
  status: AckStatus;
  /** Milliseconds since epoch (the payload carries seconds as a string). */
  at: number;
  recipientId: string | null;
  phoneNumberId: string | null;
  errors: CloudApiStatusError[];
}

export interface ParseResult {
  statuses: CloudApiStatus[];
  /** Status entries skipped because of an unknown status value or missing fields. */
  skipped: number;
}

const KNOWN: AckStatus[] = ['sent', 'delivered', 'read', 'failed'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

export function parseStatusWebhook(payload: unknown): ParseResult {
  const out: ParseResult = { statuses: [], skipped: 0 };
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account') return out;
  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const value = change.value;
      const phoneNumberId = isObj(value.metadata) ? strOrNull(value.metadata.phone_number_id) : null;
      for (const s of arr(value.statuses)) {
        if (!isObj(s)) {
          out.skipped++;
          continue;
        }
        const id = strOrNull(s.id);
        const status = s.status as AckStatus;
        const seconds = Number(s.timestamp);
        if (!id || !KNOWN.includes(status) || !Number.isFinite(seconds)) {
          out.skipped++;
          continue;
        }
        out.statuses.push({
          id,
          status,
          at: seconds * 1000,
          recipientId: strOrNull(s.recipient_id),
          phoneNumberId,
          errors: arr(s.errors)
            .filter(isObj)
            .map((e) => ({
              code: typeof e.code === 'number' ? e.code : null,
              title: strOrNull(e.title),
              message: strOrNull(e.message),
              details: isObj(e.error_data) ? strOrNull(e.error_data.details) : null,
            })),
        });
      }
    }
  }
  return out;
}

export interface CloudApiInbound {
  wamid: string;
  from: string;
  name: string | null;
  at: number;
  type: string;
  text: string | null;
}

/**
 * Inbound customer messages from the same webhook (`value.messages[]` with
 * `value.contacts[]`). Only what the inbox needs is read; non-text types are
 * kept with `text: null`.
 */
export function parseInboundWebhook(payload: unknown): { messages: CloudApiInbound[]; skipped: number } {
  const out = { messages: [] as CloudApiInbound[], skipped: 0 };
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account') return out;
  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const names = new Map<string, string>();
      for (const c of arr(change.value.contacts)) {
        if (isObj(c) && typeof c.wa_id === 'string' && isObj(c.profile) && typeof c.profile.name === 'string') {
          names.set(c.wa_id, c.profile.name.slice(0, 100));
        }
      }
      for (const m of arr(change.value.messages)) {
        const from = isObj(m) ? strOrNull(m.from) : null;
        const wamid = isObj(m) ? strOrNull(m.id) : null;
        const seconds = isObj(m) ? Number(m.timestamp) : NaN;
        if (!isObj(m) || !from || !wamid || !Number.isFinite(seconds)) {
          out.skipped++;
          continue;
        }
        const type = strOrNull(m.type) ?? 'unknown';
        const text = type === 'text' && isObj(m.text) ? strOrNull(m.text.body) : null;
        out.messages.push({ wamid, from, name: names.get(from) ?? null, at: seconds * 1000, type, text: text?.slice(0, 4096) ?? null });
      }
    }
  }
  return out;
}

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app secret, raw body)>`. */
export function hubSignature(appSecret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function verifyHubSignature(appSecret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  return safeEqual(hubSignature(appSecret, rawBody), header);
}
