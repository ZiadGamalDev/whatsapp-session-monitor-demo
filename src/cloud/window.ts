/**
 * Customer service window: free-form messages can be sent for 24 hours after
 * the customer's last message; outside it, only approved templates.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#customer-service-windows
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  /** When the window closes (null if the customer never wrote). */
  expiresAt: number | null;
  remainingMs: number;
}

export function windowState(lastInboundAt: number | null, now: number): WindowState {
  if (lastInboundAt === null) return { open: false, expiresAt: null, remainingMs: 0 };
  const expiresAt = lastInboundAt + WINDOW_MS;
  const remainingMs = Math.max(0, expiresAt - now);
  return { open: remainingMs > 0, expiresAt, remainingMs };
}
