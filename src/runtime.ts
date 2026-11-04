import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CloudApiSimulator } from './cloud/simulator.js';
import { CloudStore } from './cloud/store.js';
import { AlertManager } from './alerts/alerts.js';
import { TelegramNotifierStub } from './alerts/telegram.js';
import { assertPublicTarget } from './alerts/ssrf.js';
import { WebhookSender } from './alerts/webhook.js';
import { SystemClock, VirtualClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { DeliveryTracker, type TrackedMessage } from './delivery/tracker.js';
import { MemoryCredentialStore } from './monitor/credentials.js';
import { SessionMonitor, type TimelineEntry } from './monitor/monitor.js';
import { SESSION_STATES, heartbeatAge, type SessionState } from './monitor/state-machine.js';
import { SimulatedProvider } from './provider/simulated.js';
import { SyntheticTraffic } from './provider/traffic.js';
import { MonitorDb } from './store/db.js';
import { MemoryStateStore, type StateStore, type StoredSession } from './store/state-store.js';

export interface FleetRow extends StoredSession {
  heartbeatAgeMs: number | null;
  /** What a dashboard that trusts the last transport event would show. */
  naiveStatus: 'connected' | 'disconnected';
}

export interface FleetSummary {
  total: number;
  byState: Record<SessionState, number>;
  naiveConnected: number;
  healthy: number;
  undelivered: number;
  needsRelink: number;
}

export interface Runtime {
  config: AppConfig;
  clock: Clock;
  virtualClock: VirtualClock | null;
  provider: SimulatedProvider;
  monitor: SessionMonitor;
  tracker: DeliveryTracker;
  db: MonitorDb;
  store: StateStore;
  bus: EventEmitter;
  alerts: AlertManager;
  webhook: WebhookSender | null;
  telegram: TelegramNotifierStub;
  cloud: CloudApiSimulator | null;
  cloudStore: CloudStore;
  /** App secret used to verify Cloud API webhooks (config, or random per process for the simulator). */
  cloudSecret: string | null;
  /** Base URL of this server once listening (used for the demo alert sink). */
  selfUrl: string | null;
  startedAt: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  fleet(): Promise<{
    now: number;
    summary: FleetSummary;
    undeliveredMessages: number;
    policy: { ackTimeoutMs: number; degradedAfterMs: number; deadAfterMs: number };
    sessions: FleetRow[];
  }>;
  row(id: string): Promise<FleetRow | null>;
  /** Waits until pending state-store writes are flushed. */
  flush(): Promise<void>;
}

export function toRow(s: StoredSession, now: number): FleetRow {
  return {
    ...s,
    heartbeatAgeMs: s.state === 'connected' || s.state === 'degraded' ? heartbeatAge(s, now) : null,
    naiveStatus: s.lastEvent === 'open' ? 'connected' : 'disconnected',
  };
}

export function summarize(rows: FleetRow[]): FleetSummary {
  const byState = Object.fromEntries(SESSION_STATES.map((s) => [s, 0])) as Record<SessionState, number>;
  let undelivered = 0;
  let naiveConnected = 0;
  let needsRelink = 0;
  for (const r of rows) {
    byState[r.state]++;
    undelivered += r.undelivered;
    if (r.naiveStatus === 'connected') naiveConnected++;
    if (r.needsRelink) needsRelink++;
  }
  return { total: rows.length, byState, naiveConnected, healthy: byState.connected, undelivered, needsRelink };
}

export async function createRuntime(
  config: AppConfig,
  opts: { store?: StateStore; db?: MonitorDb } = {},
): Promise<Runtime> {
  const virtualClock = config.virtualTimeMs !== null ? new VirtualClock(config.virtualStart) : null;
  const clock: Clock = virtualClock ?? new SystemClock();
  const db = opts.db ?? new MonitorDb(config.dbPath);
  db.reset();

  let store: StateStore;
  if (opts.store) store = opts.store;
  else if (config.redisUrl) {
    const { RedisStateStore } = await import('./store/redis-state-store.js');
    store = new RedisStateStore(config.redisUrl);
  } else store = new MemoryStateStore();
  await store.clear();

  const provider = new SimulatedProvider({ clock, seed: config.seed, sessionCount: config.sessionCount });
  const credentials = new MemoryCredentialStore();
  const monitor = new SessionMonitor({ provider, clock, credentials, seed: config.seed });
  const tracker = new DeliveryTracker({ clock, provider, ackTimeoutMs: config.ackTimeoutMs });
  const traffic = new SyntheticTraffic({
    clock,
    monitor,
    tracker,
    seed: config.seed,
    intervalMs: config.trafficIntervalMs,
  });
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // ---- alerts ---------------------------------------------------------------
  const webhook =
    config.alertWebhookUrl || config.demoAlertSink
      ? new WebhookSender({
          url: () => config.alertWebhookUrl ?? (rt.selfUrl ? `${rt.selfUrl}/demo/alert-sink` : null),
          secret: config.alertWebhookSecret,
          // The built-in sink (loopback) is allowed only because it is the
          // target; an operator URL is checked before every delivery.
          guard: config.alertWebhookUrl
            ? (url) => assertPublicTarget(url, { allowPrivate: config.alertWebhookAllowPrivate })
            : undefined,
        })
      : null;
  const telegram = new TelegramNotifierStub(config.telegramNotifierEnabled, (line) => console.log(line));
  const alerts = new AlertManager({ clock, db, bus, monitor, webhook, telegram });
  alerts.start();

  // ---- simulated Cloud API number -------------------------------------------
  const cloudStore = new CloudStore(db.db);
  cloudStore.reset();
  const cloudSecret = config.cloudApiAppSecret ?? (config.cloudSim ? randomBytes(32).toString('hex') : null);
  const cloud =
    config.cloudSim && cloudSecret
      ? new CloudApiSimulator({
          clock,
          seed: config.seed,
          store: cloudStore,
          tracker,
          db,
          bus,
          secret: cloudSecret,
          enforceWindow: config.cloudEnforceWindow,
          inboundIntervalMs: config.cloudInboundIntervalMs,
        })
      : null;

  // ---- persistence wiring -------------------------------------------------
  const dirty = new Set<string>();
  let flushing: Promise<void> = Promise.resolve();
  let scheduled = false;
  const toStored = (id: string): StoredSession | null => {
    const s = monitor.snapshot(id);
    if (!s) return null;
    const { heartbeatAgeMs: _age, ...rest } = s;
    return {
      ...rest,
      undelivered: tracker.undeliveredCount(id),
      flaggedTotal: tracker.flaggedTotal(id),
      updatedAt: clock.now(),
    };
  };
  const markDirty = (id: string) => {
    dirty.add(id);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = [...dirty].map(toStored).filter((s): s is StoredSession => s !== null);
      dirty.clear();
      flushing = flushing.then(() => store.put(batch)).catch((err) => {
          bus.emit('store-error', err);
        });
      bus.emit('fleet-dirty');
    });
  };

  const onTimeline = (e: TimelineEntry) => {
    db.addTimeline(e);
    bus.emit('timeline', e);
  };
  monitor.on('timeline', onTimeline);
  monitor.on('change', markDirty);
  tracker.on('change', (m: TrackedMessage) => {
    db.upsertMessage(m);
    markDirty(m.sessionId);
    bus.emit('message', m);
  });
  tracker.on('undelivered', (m: TrackedMessage) => {
    onTimeline({
      sessionId: m.sessionId,
      at: clock.now(),
      kind: 'message',
      code: 'ack_timeout',
      detail: { messageId: m.id, sentAt: m.sentAt, timeoutMs: tracker.ackTimeoutMs },
    });
  });

  const rt: Runtime = {
    config,
    clock,
    virtualClock,
    provider,
    monitor,
    tracker,
    db,
    store,
    bus,
    alerts,
    webhook,
    telegram,
    cloud,
    cloudStore,
    cloudSecret,
    selfUrl: null,
    startedAt: clock.now(),
    async start() {
      monitor.start();
      if (config.syntheticTraffic) traffic.start();
      cloud?.seed();
      cloud?.start();
      if (virtualClock && config.virtualTimeMs) {
        // Fast-forward in small steps, letting promises settle in between so
        // async sends resolve at (nearly) the right virtual time.
        const step = 50;
        for (let t = 0; t < config.virtualTimeMs; t += step) {
          virtualClock.advance(step);
          await new Promise((r) => setImmediate(r));
          await cloud?.settle();
        }
      }
      await rt.flush();
    },
    async stop() {
      traffic.stop();
      cloud?.stop();
      monitor.stop();
      tracker.stop();
      provider.shutdown();
      await rt.flush();
      await store.close();
      db.close();
    },
    async flush() {
      await new Promise((r) => setImmediate(r));
      await cloud?.settle();
      await flushing;
    },
    async fleet() {
      const now = clock.now();
      const sessions = (await store.all()).map((s) => toRow(s, now));
      return {
        now,
        summary: summarize(sessions),
        /** Same source as GET /api/messages totals (fleet + Cloud API). */
        undeliveredMessages: db.messageTotals().undelivered,
        policy: {
          ackTimeoutMs: tracker.ackTimeoutMs,
          degradedAfterMs: monitor.policy.degradedAfterMs,
          deadAfterMs: monitor.policy.deadAfterMs,
        },
        sessions,
      };
    },
    async row(id) {
      const s = await store.get(id);
      return s ? toRow(s, clock.now()) : null;
    },
  };
  return rt;
}
