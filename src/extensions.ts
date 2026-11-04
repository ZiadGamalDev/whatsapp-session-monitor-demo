import type { FastifyInstance } from 'fastify';
import { ATTEMPT_HEADER, DELIVERY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyPayload } from './alerts/webhook.js';
import { createHash, randomBytes } from 'node:crypto';
import { parseInboundWebhook, parseStatusWebhook, verifyHubSignature } from './cloud-api/statuses.js';
import type { Runtime } from './runtime.js';
import { safeEqual } from './server/auth.js';
import { fixedWindowLimit } from './server/rate-limit.js';

/** Routes outside the token-protected API: demo alert sink, Cloud API webhook. */
export async function registerExtensions(app: FastifyInstance, rt: Runtime): Promise<void> {
  if (rt.config.demoAlertSink) {
    await app.register(async (scope) => {
      // Keep the raw body: the signature covers the exact bytes sent.
      scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

      /**
       * Built-in receiver for the demo: verifies the HMAC signature like a
       * real consumer would. To show retries, the first attempt of every
       * fourth alert gets a 503.
       */
      scope.post('/demo/alert-sink', async (req, reply) => {
        const raw = String(req.body ?? '');
        const ok = verifyPayload(
          rt.config.alertWebhookSecret,
          raw,
          req.headers[TIMESTAMP_HEADER] as string | undefined,
          req.headers[SIGNATURE_HEADER] as string | undefined,
        );
        if (!ok) return reply.code(401).send({ error: 'bad_signature' });
        const id = Number(String(req.headers[DELIVERY_HEADER] ?? '').replace('alert-', ''));
        const attempt = Number(req.headers[ATTEMPT_HEADER] ?? 1);
        if (id % 4 === 0 && attempt === 1) return reply.code(503).send({ error: 'simulated_outage' });
        return { ok: true };
      });
    });
  }

  let requests = 0;
  const bypassHeader = 'x-simulator-bypass';
  const bypassToken = randomBytes(32).toString('hex');
  const getLimiter = fixedWindowLimit({ max: 30, windowMs: 60_000 });
  const postLimiter = fixedWindowLimit({ max: 120, windowMs: 60_000 });

  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    /**
     * Subscription handshake (GET with hub.mode / hub.verify_token / hub.challenge), see
     * https://developers.facebook.com/docs/graph-api/webhooks/getting-started
     */
    scope.get(
      '/webhooks/cloud-api',
      {
        onRequest: async (req, reply) => {
          await getLimiter(req, reply);
        },
      },
      async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const expected = rt.config.cloudApiVerifyToken;
        if (!expected) return reply.code(503).send({ error: 'cloud_api_not_configured' });
        if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], expected)) {
          return reply.type('text/plain').send(q['hub.challenge'] ?? '');
        }
        return reply.code(403).send({ error: 'verification_failed' });
      },
    );

    /**
     * Status receipts (sent / delivered / read / failed) feed the delivery
     * tracker; inbound customer messages feed the inbox.
     *
     * Replay protection and idempotency (the signature has no timestamp, so
     * a captured request stays valid forever):
     *  - an identical body seen before is acknowledged and ignored;
     *  - each status is applied once per (message id, status);
     *  - each inbound message is stored once per message id;
     *  - events older than CLOUD_MAX_EVENT_AGE_MS or more than 5 minutes in
     *    the future are ignored as stale.
     * Duplicates still get 200 so the sender stops retrying.
     */
    scope.post(
      '/webhooks/cloud-api',
      {
        bodyLimit: 64 * 1024,
        onRequest: async (req, reply) => {
          const token = req.headers[bypassHeader];
          if (typeof token === 'string' && safeEqual(token, bypassToken)) {
            return;
          }
          await postLimiter(req, reply);
        },
      },
      async (req, reply) => {
      const secret = rt.cloudSecret;
      if (!secret) return reply.code(503).send({ error: 'cloud_api_not_configured' });
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!verifyHubSignature(secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'bad_signature' });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'invalid_json' });
      }
      const now = rt.clock.now();
      const maxAge = rt.config.cloudMaxEventAgeMs;
      const result = { received: 0, matched: 0, unmatched: 0, skipped: 0, duplicates: 0, stale: 0, inbound: 0, dropped: 0, duplicateDelivery: false };
      const bodyKey = `body:${createHash('sha256').update(raw).digest('hex')}`;
      if (!rt.cloudStore.markSeen(bodyKey, now)) return { ...result, duplicateDelivery: true };
      if (++requests % 500 === 0) rt.cloudStore.pruneSeen(now - 2 * maxAge);
      const isStale = (at: number) => now - at > maxAge || at - now > 5 * 60_000;
      const touched = new Set<string>();

      const parsed = parseStatusWebhook(payload);
      result.received = parsed.statuses.length;
      result.skipped = parsed.skipped;
      for (const s of parsed.statuses) {
        if (isStale(s.at)) {
          result.stale++;
          continue;
        }
        if (!rt.cloudStore.markSeen(`status:${s.id}:${s.status}`, now)) {
          result.duplicates++;
          continue;
        }
        const e = s.errors[0];
        const error = e ? [e.code, e.title].filter((x) => x !== null).join(' ') : undefined;
        if (rt.tracker.applyAck(s.id, s.status, { at: s.at, error })) result.matched++;
        else result.unmatched++;
        if (s.recipientId?.startsWith('999')) touched.add(s.recipientId);
      }

      const inbound = parseInboundWebhook(payload);
      result.skipped += inbound.skipped;
      for (const m of inbound.messages) {
        // Demo data only: senders outside the fake +999 range are never
        // stored (no names, numbers or text from real people).
        if (!m.from.startsWith('999')) {
          result.dropped++;
          continue;
        }
        if (isStale(m.at)) {
          result.stale++;
          continue;
        }
        if (!rt.cloudStore.markSeen(`message:${m.wamid}`, now)) {
          result.duplicates++;
          continue;
        }
        if (!rt.cloudStore.contact(m.from)) {
          rt.cloudStore.upsertContact({ waId: m.from, name: m.name ?? m.from, behavior: 'ok', lastInboundAt: null });
        }
        rt.cloudStore.addMessage({
          waId: m.from,
          direction: 'in',
          wamid: m.wamid,
          kind: 'text',
          templateName: null,
          body: m.text ?? `[${m.type}]`,
          at: m.at,
          trackerId: null,
          seeded: false,
        });
        result.inbound++;
        touched.add(m.from);
      }
      for (const waId of touched) rt.bus.emit('inbox', { waId });
      return result;
    });
  });

  // The simulator delivers its signed webhooks through the route above,
  // in-process (same parser, same signature check, no network).
  rt.cloud?.setTransport(async (raw, signature) => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        [bypassHeader]: bypassToken,
      },
      payload: raw,
    });
    if (res.statusCode !== 200) throw new Error(`webhook rejected: ${res.statusCode} ${res.body}`);
  });
}
