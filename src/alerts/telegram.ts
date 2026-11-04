import type { AlertPayload } from './alerts.js';

/**
 * Telegram notifier STUB. Off by default (TELEGRAM_NOTIFIER_ENABLED=false).
 *
 * It never makes a network call and takes no bot token. When enabled it only
 * formats the text a real notifier would send and keeps it in an in-memory
 * outbox (visible in logs and tests). A real implementation would POST the
 * same text to the Bot API `sendMessage` method with a token from the
 * environment; that is intentionally not included in this demo.
 */
export class TelegramNotifierStub {
  readonly outbox: string[] = [];

  constructor(
    readonly enabled: boolean,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  format(a: AlertPayload): string {
    const icon = a.type === 'recovered' ? '[OK]' : '[ALERT]';
    return `${icon} ${a.label} (${a.sessionId}): ${a.from} -> ${a.to} (${a.reason}) at ${a.at} [simulated]`;
  }

  notify(a: AlertPayload): boolean {
    if (!this.enabled) return false;
    const text = this.format(a);
    this.outbox.push(text);
    if (this.outbox.length > 200) this.outbox.shift();
    this.log(`telegram stub (not sent): ${text}`);
    return true;
  }
}
