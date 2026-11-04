import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isPrivateAddress } from './alerts/ssrf.js';

export interface AppConfig {
  host: string;
  port: number;
  demoToken: string;
  /** True when DEMO_TOKEN was not set and a random one was generated (non-loopback HOST). */
  demoTokenGenerated: boolean;
  seed: number;
  sessionCount: number;
  dbPath: string;
  redisUrl: string | null;
  ackTimeoutMs: number;
  syntheticTraffic: boolean;
  trafficIntervalMs: number;
  /** When set, run on a virtual clock: fast-forward this many ms, then freeze. */
  virtualTimeMs: number | null;
  virtualStart: number;
  alertWebhookUrl: string | null;
  alertWebhookSecret: string;
  /** Allow ALERT_WEBHOOK_URL to resolve to loopback/private/link-local addresses. */
  alertWebhookAllowPrivate: boolean;
  /** Point alerts at the built-in signed-webhook receiver (demo only). */
  demoAlertSink: boolean;
  telegramNotifierEnabled: boolean;
  cloudApiAppSecret: string | null;
  cloudApiVerifyToken: string | null;
  webDir: string;
  /** Per client IP, per minute, for POST /api/messages. */
  rateLimitMessagesPerMin: number;
  /** Per client IP, per minute, for POST /api/sessions/:id/relink. */
  rateLimitRelinksPerMin: number;
  /** Max concurrent SSE connections. */
  maxStreams: number;
  /** Run the simulated Cloud API number (inbox, templates, status webhooks). */
  cloudSim: boolean;
  /** Reject free-form text outside the 24 h window before sending. */
  cloudEnforceWindow: boolean;
  /** How often a simulated customer writes in. */
  cloudInboundIntervalMs: number;
  /** Webhook events older than this are ignored (replay protection). */
  cloudMaxEventAgeMs: number;
}

export const DEFAULT_DEMO_TOKEN = 'demo-token';
export const DEFAULT_WEBHOOK_SECRET = 'demo-webhook-secret';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const str = (v: string | undefined) => (v === undefined || v === '' ? null : v);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST || '127.0.0.1';
  // Without DEMO_TOKEN: the well-known demo token on loopback only; a random
  // token (printed at start-up) anywhere else.
  const generate = !env.DEMO_TOKEN && !LOOPBACK.has(host);
  return {
    host,
    port: num(env.PORT, 3000),
    demoToken: env.DEMO_TOKEN || (generate ? randomBytes(24).toString('base64url') : DEFAULT_DEMO_TOKEN),
    demoTokenGenerated: generate,
    seed: num(env.SEED, 42),
    sessionCount: num(env.SESSION_COUNT, 40),
    dbPath: env.DB_PATH || 'data/monitor.sqlite',
    redisUrl: str(env.REDIS_URL),
    ackTimeoutMs: num(env.ACK_TIMEOUT_MS, 60_000),
    syntheticTraffic: bool(env.SYNTHETIC_TRAFFIC, true),
    trafficIntervalMs: num(env.TRAFFIC_INTERVAL_MS, 1_500),
    virtualTimeMs: env.VIRTUAL_TIME_MS ? Number(env.VIRTUAL_TIME_MS) : null,
    virtualStart: Date.parse(env.VIRTUAL_START || '2026-01-01T09:00:00Z'),
    alertWebhookUrl: str(env.ALERT_WEBHOOK_URL),
    alertWebhookSecret: env.ALERT_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET,
    alertWebhookAllowPrivate: bool(env.ALERT_WEBHOOK_ALLOW_PRIVATE, false),
    demoAlertSink: bool(env.DEMO_ALERT_SINK, true),
    telegramNotifierEnabled: bool(env.TELEGRAM_NOTIFIER_ENABLED, false),
    cloudApiAppSecret: str(env.CLOUD_API_APP_SECRET),
    cloudApiVerifyToken: str(env.CLOUD_API_VERIFY_TOKEN),
    webDir: env.WEB_DIR || 'dist/web',
    rateLimitMessagesPerMin: num(env.RATE_LIMIT_MESSAGES_PER_MIN, 30),
    rateLimitRelinksPerMin: num(env.RATE_LIMIT_RELINKS_PER_MIN, 10),
    maxStreams: num(env.MAX_STREAMS, 50),
    cloudSim: bool(env.CLOUD_SIM, true),
    cloudEnforceWindow: bool(env.CLOUD_ENFORCE_WINDOW, true),
    cloudInboundIntervalMs: num(env.CLOUD_INBOUND_INTERVAL_MS, 90_000),
    cloudMaxEventAgeMs: num(env.CLOUD_MAX_EVENT_AGE_MS, 7 * 86_400_000),
  };
}


/**
 * Fails fast on settings that would make the demo unsafe or broken.
 * Returns warnings for settings that are fine locally but risky when exposed.
 */
export function validateConfig(c: AppConfig): string[] {
  const errors: string[] = [];
  const intOk = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!intOk(c.port, 0, 65535)) errors.push(`PORT must be an integer 0-65535 (got ${c.port})`);
  if (!intOk(c.sessionCount, 1, 500)) errors.push(`SESSION_COUNT must be 1-500 (got ${c.sessionCount})`);
  if (!Number.isFinite(c.seed)) errors.push('SEED must be a number');
  if (!intOk(c.ackTimeoutMs, 1_000, 86_400_000)) errors.push('ACK_TIMEOUT_MS must be 1000-86400000');
  if (!intOk(c.trafficIntervalMs, 100, 3_600_000)) errors.push('TRAFFIC_INTERVAL_MS must be 100-3600000');
  if (c.virtualTimeMs !== null && !intOk(c.virtualTimeMs, 0, 86_400_000)) errors.push('VIRTUAL_TIME_MS must be 0-86400000');
  if (!intOk(c.rateLimitMessagesPerMin, 1, 100_000)) errors.push('RATE_LIMIT_MESSAGES_PER_MIN must be >= 1');
  if (!intOk(c.rateLimitRelinksPerMin, 1, 100_000)) errors.push('RATE_LIMIT_RELINKS_PER_MIN must be >= 1');
  if (!intOk(c.maxStreams, 1, 10_000)) errors.push('MAX_STREAMS must be >= 1');
  if (!intOk(c.cloudInboundIntervalMs, 1_000, 86_400_000)) errors.push('CLOUD_INBOUND_INTERVAL_MS must be 1000-86400000');
  if (!intOk(c.cloudMaxEventAgeMs, 60_000, 30 * 86_400_000)) errors.push('CLOUD_MAX_EVENT_AGE_MS must be 60000-2592000000');
  if (c.alertWebhookUrl) {
    let url: URL | null = null;
    try {
      url = new URL(c.alertWebhookUrl);
    } catch {
      errors.push('ALERT_WEBHOOK_URL is not a valid URL');
    }
    if (url && url.protocol !== 'https:' && url.protocol !== 'http:') errors.push('ALERT_WEBHOOK_URL must be http(s)');
    const literal = url?.hostname.replace(/^\[|\]$/g, '') ?? '';
    if (url && !c.alertWebhookAllowPrivate && (isIP(literal) ? isPrivateAddress(literal) : literal === 'localhost')) {
      errors.push('ALERT_WEBHOOK_URL points to a private/loopback address; set ALERT_WEBHOOK_ALLOW_PRIVATE=true if that is intended');
    }
    if (c.alertWebhookSecret === DEFAULT_WEBHOOK_SECRET) {
      errors.push('ALERT_WEBHOOK_SECRET must be changed when ALERT_WEBHOOK_URL points to a real receiver');
    }
  }
  if (!LOOPBACK.has(c.host) && c.demoToken === DEFAULT_DEMO_TOKEN) {
    errors.push(
      `Refusing to listen on ${c.host} with the public default DEMO_TOKEN. Set a long random DEMO_TOKEN, or leave it unset to get a generated one.`,
    );
  }
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  const warnings: string[] = [];
  if (c.demoTokenGenerated) {
    warnings.push('DEMO_TOKEN was not set: a random token was generated for this run (printed below).');
  }
  return warnings;
}
