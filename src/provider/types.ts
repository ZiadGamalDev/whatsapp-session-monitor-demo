/**
 * Contract between the monitor and whatever actually holds the WhatsApp-like
 * sessions. The monitor never talks to a transport directly; it only sees
 * these calls and events. This repo ships one implementation:
 * `SimulatedProvider`. No real network transport exists in this codebase.
 */

export type AckStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** Opaque, simulated credentials for one session (think "linked device"). */
export interface Credentials {
  sessionId: string;
  /** Increments every time the user explicitly relinks the session. */
  generation: number;
  /** Short fingerprint shown in the UI so you can see credentials were kept. */
  fingerprint: string;
  createdAt: number;
}

export interface SessionDescriptor {
  id: string;
  label: string;
  /** Fake number in an unassigned range; never a real subscriber. */
  phone: string;
}

export interface OutboundMessage {
  /** Monitor-side id. */
  id: string;
  to: string;
  text: string;
}

export interface SendResult {
  accepted: boolean;
  /** Provider-side id, used to correlate later acks. */
  providerMessageId?: string;
  error?: string;
}

export interface ProviderEventMap {
  open: { sessionId: string };
  close: { sessionId: string; code: number; reason?: string };
  error: { sessionId: string; code: string; message: string; kind: 'credential' | 'transport' | 'other' };
  ack: { sessionId: string; id: string; status: AckStatus; errorCode?: number; errorTitle?: string };
  /**
   * Keepalive signal. Not every transport exposes this directly; a real
   * adapter would map its own ping/pong (or a periodic cheap request) onto it.
   * The monitor treats heartbeat age as the source of truth.
   */
  heartbeat: { sessionId: string };
}

export type ProviderEvent = keyof ProviderEventMap;
export type Listener<E extends ProviderEvent> = (payload: ProviderEventMap[E]) => void;

export interface SessionProvider {
  readonly name: string;
  listSessions(): SessionDescriptor[];
  connect(sessionId: string, credentials: Credentials): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: OutboundMessage): Promise<SendResult>;
  on<E extends ProviderEvent>(event: E, listener: Listener<E>): void;
  off<E extends ProviderEvent>(event: E, listener: Listener<E>): void;
}

/** Close code used for "logged out / unauthorized" (mirrors HTTP 401). */
export const CLOSE_LOGGED_OUT = 401;
