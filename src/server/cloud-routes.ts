import type { FastifyInstance } from 'fastify';
import { displayNumber, type SendRequest } from '../cloud/simulator.js';
import { TEMPLATES } from '../cloud/templates.js';
import { windowState } from '../cloud/window.js';
import { deliveryGap, toCsv, type Source } from '../reports/delivery-gap.js';
import type { Runtime } from '../runtime.js';
import { fixedWindowLimit } from './rate-limit.js';

/** Routes for the simulated Cloud API number, inbox and reports (token-protected scope). */
export function registerCloudRoutes(api: FastifyInstance, rt: Runtime): void {
  const sendLimit = fixedWindowLimit({ max: rt.config.rateLimitMessagesPerMin });
  const replyLimit = fixedWindowLimit({ max: rt.config.rateLimitMessagesPerMin });
  const notEnabled = { error: 'cloud_sim_disabled', hint: 'set CLOUD_SIM=true' };

  /** Same request/response shape as POST /{phone-number-id}/messages (simulated). */
  api.post('/api/messages/send', { preHandler: sendLimit }, async (req, reply) => {
    if (!rt.cloud) return reply.code(503).send(notEnabled);
    const body = (req.body ?? {}) as SendRequest;
    const res = rt.cloud.send(body);
    await rt.flush();
    return reply.code(res.status).send(res.body);
  });

  api.get('/api/templates', async () => ({
    simulated: true,
    data: TEMPLATES.map((t) => ({
      name: t.name,
      category: t.category,
      status: 'APPROVED',
      languages: Object.keys(t.body),
      params: t.params,
      body: t.body,
    })),
  }));

  api.get('/api/inbox/conversations', async () => {
    const now = rt.clock.now();
    const conversations = rt.cloudStore.contacts().map((c) => {
      const last = rt.cloudStore.lastMessage(c.waId);
      const lastStatus = last?.trackerId ? (rt.tracker.get(last.trackerId) ?? rt.db.getMessage(last.trackerId)) : null;
      return {
        waId: c.waId,
        name: c.name,
        number: displayNumber(c.waId),
        window: windowState(c.lastInboundAt, now),
        lastMessage: last
          ? { direction: last.direction, body: last.body, at: last.at, kind: last.kind, status: lastStatus?.status ?? null }
          : null,
      };
    });
    conversations.sort((a, b) => (b.lastMessage?.at ?? 0) - (a.lastMessage?.at ?? 0));
    return { now, simulated: true, conversations };
  });

  api.get('/api/inbox/conversations/:waId', async (req, reply) => {
    const { waId } = req.params as { waId: string };
    const c = rt.cloudStore.contact(waId);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const now = rt.clock.now();
    const messages = rt.cloudStore.thread(waId, 100).map((m) => {
      const t = m.trackerId ? (rt.tracker.get(m.trackerId) ?? rt.db.getMessage(m.trackerId)) : null;
      return {
        ...m,
        status: t?.status ?? null,
        sentAt: t?.sentAt ?? null,
        deliveredAt: t?.deliveredAt ?? null,
        readAt: t?.readAt ?? null,
        failedAt: t?.failedAt ?? null,
        error: t?.error ?? null,
        undelivered: t?.undelivered ?? false,
        lateDelivery: t?.lateDelivery ?? false,
      };
    });
    return {
      now,
      simulated: true,
      contact: { waId: c.waId, name: c.name, number: displayNumber(c.waId) },
      window: windowState(c.lastInboundAt, now),
      messages,
    };
  });

  /** Simulator control: make a fake customer write in (opens the 24 h window). */
  api.post(
    '/api/sim/customer-reply',
    {
      preHandler: replyLimit,
      schema: {
        body: {
          type: 'object',
          required: ['waId', 'text'],
          additionalProperties: false,
          properties: { waId: { type: 'string', pattern: '^999[0-9]{4,12}$' }, text: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      if (!rt.cloud) return reply.code(503).send(notEnabled);
      const { waId, text } = req.body as { waId: string; text: string };
      if (!rt.cloudStore.contact(waId)) return reply.code(404).send({ error: 'unknown_contact' });
      const wamid = rt.cloud.customerReply(waId, text);
      await rt.flush();
      return reply.code(202).send({ simulated: true, wamid, window: windowState(rt.cloudStore.contact(waId)!.lastInboundAt, rt.clock.now()) });
    },
  );

  const reportOpts = (q: Record<string, string | undefined>) => {
    const n = Math.floor(Number(q.days ?? 7));
    const days = Number.isFinite(n) && n >= 1 ? Math.min(31, n) : 7;
    const source: Source = q.source === 'fleet' || q.source === 'cloud' ? q.source : 'all';
    return { days, source };
  };
  const report = (q: Record<string, string | undefined>) => {
    const { days, source } = reportOpts(q);
    const now = rt.clock.now();
    return deliveryGap(rt.db.messagesSince(now - (days + 1) * 86_400_000), { now, days, source });
  };

  api.get('/api/reports/delivery-gap', async (req) => ({
    now: rt.clock.now(),
    ackTimeoutMs: rt.tracker.ackTimeoutMs,
    ...report(req.query as Record<string, string | undefined>),
  }));

  api.get('/api/reports/delivery-gap.csv', async (req, reply) => {
    const r = report(req.query as Record<string, string | undefined>);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="delivery-gap-${r.source}.csv"`)
      .send(toCsv(r));
  });

}
