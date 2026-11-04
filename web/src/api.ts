import { reactive } from 'vue';

export type SessionState = 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'logged_out' | 'stuck';
export const STATES: SessionState[] = ['connected', 'degraded', 'reconnecting', 'connecting', 'logged_out', 'stuck'];

export interface FleetRow {
  id: string;
  label: string;
  phone: string;
  state: SessionState;
  stateSince: number;
  attempts: number;
  reconnectCount: number;
  heartbeatAgeMs: number | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  lastCloseCode: number | null;
  lastError: string | null;
  stuckReason: string | null;
  needsRelink: boolean;
  naiveStatus: 'connected' | 'disconnected';
  undelivered: number;
  flaggedTotal: number;
  credentialFingerprint: string | null;
  credentialGeneration: number | null;
  credentialWipes: number;
}

export interface FleetSummary {
  total: number;
  byState: Record<SessionState, number>;
  naiveConnected: number;
  healthy: number;
  undelivered: number;
  needsRelink: number;
}

export interface Fleet {
  now: number;
  summary: FleetSummary;
  undeliveredMessages: number;
  /** Thresholds as configured on the server (never hardcoded in the UI). */
  policy: { ackTimeoutMs: number; degradedAfterMs: number; deadAfterMs: number };
  sessions: FleetRow[];
}

export interface TimelineEntry {
  sessionId: string;
  at: number;
  kind: 'event' | 'transition' | 'action' | 'message';
  code: string;
  detail?: Record<string, unknown>;
}

export interface Message {
  id: string;
  sessionId: string;
  to: string;
  text: string;
  source: 'api' | 'synthetic';
  providerMessageId: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  createdAt: number;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
  error: string | null;
  undelivered: boolean;
  flaggedAt: number | null;
  lateDelivery: boolean;
}

export interface Alert {
  id: number;
  sessionId: string;
  at: number;
  type: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  deliveryStatus: 'not_configured' | 'pending' | 'delivered' | 'retrying' | 'failed';
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  channels: string[];
}

export interface SessionDetail {
  now: number;
  session: FleetRow;
  simulatorScenario: string | null;
  policy: { degradedAfterMs: number; deadAfterMs: number; maxAttempts: number };
  ackTimeoutMs: number;
  timeline: TimelineEntry[];
  messages: Message[];
  undeliveredMessages: Message[];
  alerts: Alert[];
}

export interface Health {
  status: string;
  clock: 'system' | 'virtual';
  stateStore: string;
}

export const live = reactive({
  token: '',
  connected: false,
  fleet: null as Fleet | null,
  health: null as Health | null,
  /** Increments on every timeline/alert push so views can refetch. */
  tick: 0,
  lastTimeline: null as TimelineEntry | null,
  authFailed: false,
  inboxTick: 0,
  inboxEvent: null as { waId: string } | null,
});

export function loadToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem('wsm.token', fromUrl);
    } catch {
      /* ignore */
    }
    // Do not leave the token in the address bar, history or bookmarks.
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return localStorage.getItem('wsm.token') ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  live.token = token;
  try {
    localStorage.setItem('wsm.token', token);
  } catch {
    /* ignore */
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${live.token}` },
  });
  if (res.status === 401) {
    live.authFailed = true;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

let source: EventSource | null = null;

export async function connectLive(): Promise<void> {
  source?.close();
  live.health = await fetch('/api/health').then((r) => r.json());
  live.fleet = await api<Fleet>('/api/sessions');
  live.authFailed = false;
  source = new EventSource(`/api/stream?token=${encodeURIComponent(live.token)}`);
  source.addEventListener('open', () => (live.connected = true));
  source.addEventListener('error', () => (live.connected = false));
  source.addEventListener('fleet', (e) => {
    live.fleet = JSON.parse((e as MessageEvent).data) as Fleet;
    live.connected = true;
  });
  source.addEventListener('timeline', (e) => {
    live.lastTimeline = JSON.parse((e as MessageEvent).data) as TimelineEntry;
    live.tick++;
  });
  source.addEventListener('alert', () => {
    live.tick++;
  });
  source.addEventListener('inbox', (e) => {
    live.inboxEvent = JSON.parse((e as MessageEvent).data) as { waId: string };
    live.inboxTick++;
  });
}

/** Authenticated download (the CSV endpoint needs the bearer header). */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${live.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function apiPost<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${live.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export interface WindowState {
  open: boolean;
  expiresAt: number | null;
  remainingMs: number;
}

export interface Conversation {
  waId: string;
  name: string;
  number: string;
  window: WindowState;
  lastMessage: { direction: 'in' | 'out'; body: string; at: number; kind: string; status: string | null } | null;
}

export interface ThreadMessage {
  id: number;
  waId: string;
  direction: 'in' | 'out';
  wamid: string;
  kind: 'text' | 'template';
  templateName: string | null;
  body: string;
  at: number;
  seeded: boolean;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  error: string | null;
  undelivered: boolean;
  lateDelivery: boolean;
}

export interface TemplateInfo {
  name: string;
  category: string;
  languages: string[];
  params: number;
  body: Record<string, string>;
}

export interface GapDay {
  date: string;
  attempted: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  noReceipt: number;
  pending: number;
  gap: number;
  deliveryRate: number | null;
  reasons: Record<string, number>;
}
