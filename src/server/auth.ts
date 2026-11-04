import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison takes the same time whatever the input length (a plain
 * length check would leak the secret's length).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Single static demo token. Accepted as `Authorization: Bearer <token>`, or
 * as `?token=` on the SSE stream only (EventSource cannot set headers).
 */
export function tokenAuth(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    let given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given && req.routeOptions.url === '/api/stream') {
      given = String((req.query as Record<string, unknown>)?.token ?? '');
    }
    if (!given || !safeEqual(given, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
