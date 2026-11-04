import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime.js';
import { SESSION_STATES, type SessionState } from '../monitor/state-machine.js';
import { tokenAuth } from './auth.js';
import { fixedWindowLimit } from './rate-limit.js';
import { registerCloudRoutes } from './cloud-routes.js';

export interface AppHooks {
  /** Extra routes registered outside the token-protected /api scope. */
  register?: (app: FastifyInstance) => void | Promise<void>;
  /** Called for every route as it is registered (used by the docs coverage test). */
  onRoute?: (method: string, url: string) => void;
}

/** Only numbers in the unassigned +999 range: the simulator never sees a real number. */
export const FAKE_NUMBER_PATTERN = '^\\+999[0-9 ]{4,24}$';

/** Parses `?limit=` defensively: NaN, zero and negatives fall back to the default. */
export function clampLimit(raw: unknown, def = 100, max = 500): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, n);
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // The dashboard URL can carry ?token=; never leak it in a Referer header.
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};

const PROBLEM_STATES: SessionState[] = ['degraded', 'reconnecting', 'logged_out', 'stuck'];

export async function buildApp(rt: Runtime, hooks: AppHooks = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  if (hooks.onRoute) {
    const cb = hooks.onRoute;
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) cb(m, r.url);
    });
  }
  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  let openStreams = 0;

  app.get('/api/health', async () => ({
    status: 'ok',
    provider: rt.provider.name,
    simulated: true,
    stateStore: rt.store.kind,
    cloudApi: rt.cloud ? 'simulated' : rt.cloudSecret ? 'webhook-only' : 'off',
    clock: rt.virtualClock ? 'virtual' : 'system',
    sessions: rt.monitor.snapshots().length,
    now: rt.clock.now(),
    uptimeMs: rt.clock.now() - rt.startedAt,
  }));

  await app.register(async (api) => {
    api.addHook('onRequest', tokenAuth(rt.config.demoToken));

    api.get('/api/sessions', async (req) => {
      const q = req.query as { state?: string; q?: string; problems?: string };
      const fleet = await rt.fleet();
      let sessions = fleet.sessions;
      if (q.state) {
        const wanted = q.state.split(',').filter((s): s is SessionState => SESSION_STATES.includes(s as SessionState));
        sessions = sessions.filter((s) => wanted.includes(s.state));
      }
      if (q.problems === '1' || q.problems === 'true') {
        sessions = sessions.filter((s) => PROBLEM_STATES.includes(s.state) || s.undelivered > 0);
      }
      if (q.q) {
        const needle = q.q.toLowerCase();
        sessions = sessions.filter(
          (s) => s.id.includes(needle) || s.label.toLowerCase().includes(needle) || s.phone.includes(needle),
        );
      }
      return { now: fleet.now, summary: fleet.summary, undeliveredMessages: fleet.undeliveredMessages, policy: fleet.policy, sessions };
    });

    api.get('/api/sessions/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = await rt.row(id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return {
        now: rt.clock.now(),
        session: row,
        simulatorScenario: rt.provider.scenarioOf(id) ?? null,
        policy: rt.monitor.policy,
        ackTimeoutMs: rt.tracker.ackTimeoutMs,
        timeline: rt.db.timeline(id, 200),
        messages: rt.db.messages({ sessionId: id, limit: 50 }),
        undeliveredMessages: rt.db.messages({ sessionId: id, undeliveredOnly: true, limit: 50 }),
        alerts: rt.db.alerts({ sessionId: id, limit: 50 }),
      };
    });

    const relinkLimit = fixedWindowLimit({ max: rt.config.rateLimitRelinksPerMin });
    const messageLimit = fixedWindowLimit({ max: rt.config.rateLimitMessagesPerMin });

    api.post('/api/sessions/:id/relink', { preHandler: relinkLimit }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!rt.monitor.has(id)) return reply.code(404).send({ error: 'not_found' });
      rt.monitor.relink(id);
      await rt.flush();
      return reply.code(202).send({ session: await rt.row(id) });
    });

    api.post(
      '/api/messages',
      {
        preHandler: messageLimit,
        schema: {
          body: {
            type: 'object',
            required: ['sessionId', 'to', 'text'],
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', minLength: 1, maxLength: 32 },
              to: { type: 'string', pattern: FAKE_NUMBER_PATTERN },
              text: { type: 'string', minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
      async (req, reply) => {
        const body = req.body as { sessionId: string; to: string; text: string };
        if (!rt.monitor.has(body.sessionId)) return reply.code(404).send({ error: 'unknown_session' });
        const message = await rt.tracker.send(body.sessionId, body.to, body.text, 'api');
        return reply.code(202).send({ message });
      },
    );

    api.get('/api/messages', async (req) => {
      const q = req.query as { sessionId?: string; undelivered?: string; limit?: string };
      return {
        messages: rt.db.messages({
          sessionId: q.sessionId,
          undeliveredOnly: q.undelivered === '1' || q.undelivered === 'true',
          limit: clampLimit(q.limit),
        }),
        totals: rt.db.messageTotals({ sessionId: q.sessionId }),
        unmatchedReceipts: rt.tracker.unmatchedReceipts(),
      };
    });

    api.get('/api/alerts', async (req) => {
      const q = req.query as { sessionId?: string; limit?: string };
      return {
        alerts: rt.db.alerts({ sessionId: q.sessionId, limit: clampLimit(q.limit) }),
        total: rt.db.alertCount(),
      };
    });

    registerCloudRoutes(api, rt);

    api.get('/api/stream', (req, reply) => {
      if (openStreams >= rt.config.maxStreams) {
        return reply.code(503).header('retry-after', '5').send({ error: 'too_many_streams' });
      }
      openStreams++;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let pending = false;
      const pushFleet = async () => {
        if (pending) return;
        pending = true;
        try {
          send('fleet', await rt.fleet());
        } finally {
          pending = false;
        }
      };
      const onTimeline = (e: unknown) => send('timeline', e);
      const onAlert = (a: unknown) => send('alert', a);
      const onInbox = (e: unknown) => send('inbox', e);
      // Ages change every second even when nothing else does.
      const interval = setInterval(() => void pushFleet(), 1_000);
      rt.bus.on('timeline', onTimeline);
      rt.bus.on('alert', onAlert);
      rt.bus.on('inbox', onInbox);
      void pushFleet();
      req.raw.on('close', () => {
        openStreams--;
        clearInterval(interval);
        rt.bus.off('timeline', onTimeline);
        rt.bus.off('alert', onAlert);
        rt.bus.off('inbox', onInbox);
      });
    });
  });

  if (hooks.register) await hooks.register(app);

  const webDir = resolve(rt.config.webDir);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', index: ['index.html'] });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/plain').send('Dashboard not built. Run `npm run build` first. API is under /api.'),
    );
  }
  return app;
}
