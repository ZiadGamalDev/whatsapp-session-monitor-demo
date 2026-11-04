import { createHmac } from 'node:crypto';
import { safeEqual } from '../server/auth.js';

/**
 * Outbound alert webhooks.
 *
 * Signature: `X-Monitor-Signature-256: sha256=<hex>` where
 *   hex = HMAC_SHA256(secret, `${X-Monitor-Timestamp}.${rawBody}`)
 * The timestamp is part of the signed string so a captured request cannot be
 * replayed later; receivers should reject timestamps outside a tolerance.
 *
 * Retries: network errors, 429 and 5xx are retried with exponential backoff
 * up to `maxAttempts`. Other 4xx responses are not retried (the receiver
 * rejected the request; sending it again will not help).
 *
 * Redirects are NOT followed: a receiver (or anything in front of it) must
 * not be able to bounce signed alerts to another host, e.g. an internal one.
 * A 3xx counts as a non-retryable failure.
 */

export const SIGNATURE_HEADER = 'x-monitor-signature-256';
export const TIMESTAMP_HEADER = 'x-monitor-timestamp';
export const DELIVERY_HEADER = 'x-monitor-delivery';
export const ATTEMPT_HEADER = 'x-monitor-attempt';

export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyPayload(
  secret: string,
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  opts: { now?: number; toleranceMs?: number } = {},
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Date.now();
  if (Math.abs(now - ts) > (opts.toleranceMs ?? 5 * 60_000)) return false;
  return safeEqual(signPayload(secret, timestamp, body), signature);
}

export interface WebhookOptions {
  url: string | (() => string | null);
  secret: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock for the signature timestamp (real time, even on a virtual sim clock). */
  now?: () => number;
  /** Checked before every attempt; throwing refuses the delivery (no retry). */
  guard?: (url: string) => Promise<void>;
}

export interface AttemptInfo {
  attempt: number;
  ok: boolean;
  status: number | null;
  error: string | null;
  willRetry: boolean;
  nextDelayMs: number | null;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  lastError: string | null;
}

export class WebhookSender {
  readonly maxAttempts: number;
  private readonly opts: Required<Omit<WebhookOptions, 'url' | 'guard'>> & Pick<WebhookOptions, 'url' | 'guard'>;

  constructor(opts: WebhookOptions) {
    this.opts = {
      maxAttempts: 5,
      baseDelayMs: 500,
      factor: 2,
      maxDelayMs: 10_000,
      timeoutMs: 5_000,
      fetchImpl: (...args) => fetch(...args),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...opts,
    };
    this.maxAttempts = this.opts.maxAttempts;
  }

  delayFor(attempt: number): number {
    return Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * Math.pow(this.opts.factor, attempt - 1));
  }

  async deliver(deliveryId: string, payload: unknown, onAttempt?: (info: AttemptInfo) => void): Promise<DeliveryResult> {
    const body = JSON.stringify(payload);
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
      if (!url) return { ok: false, attempts: attempt - 1, lastError: 'no_url' };
      if (this.opts.guard) {
        try {
          await this.opts.guard(url);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          onAttempt?.({ attempt, ok: false, status: null, error, willRetry: false, nextDelayMs: null });
          return { ok: false, attempts: attempt, lastError: error };
        }
      }
      const timestamp = String(this.opts.now());
      let status: number | null = null;
      let retryable = true;
      try {
        const res = await this.opts.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: signPayload(this.opts.secret, timestamp, body),
            [TIMESTAMP_HEADER]: timestamp,
            [DELIVERY_HEADER]: deliveryId,
            [ATTEMPT_HEADER]: String(attempt),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        status = res.status;
        // Release the connection; the response body is not used.
        await res.body?.cancel().catch(() => undefined);
        if (res.ok) {
          onAttempt?.({ attempt, ok: true, status, error: null, willRetry: false, nextDelayMs: null });
          return { ok: true, attempts: attempt, lastError: null };
        }
        lastError = res.status >= 300 && res.status < 400 ? `redirect ${res.status} not followed` : `HTTP ${res.status}`;
        retryable = res.status === 429 || res.status >= 500;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      const willRetry = retryable && attempt < this.opts.maxAttempts;
      const nextDelayMs = willRetry ? this.delayFor(attempt) : null;
      onAttempt?.({ attempt, ok: false, status, error: lastError, willRetry, nextDelayMs });
      if (!willRetry) return { ok: false, attempts: attempt, lastError };
      await this.opts.sleep(nextDelayMs!);
    }
    return { ok: false, attempts: this.opts.maxAttempts, lastError };
  }
}
