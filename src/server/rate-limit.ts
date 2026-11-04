import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Small fixed-window rate limiter keyed by client IP. In-process only: good
 * enough for a single-instance demo, not a distributed limiter. Uses wall
 * time even when the fleet runs on a virtual clock.
 */
export function fixedWindowLimit(opts: { max: number; windowMs?: number; now?: () => number }) {
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { start: number; count: number }>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const t = now();
    const key = req.ip;
    let w = hits.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      hits.set(key, w);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      }
    }
    w.count++;
    if (w.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'rate_limited', retryAfter });
    }
  };
}
