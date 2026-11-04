/**
 * Error objects shaped like the WhatsApp Cloud API's, so client code written
 * against this simulator handles the same fields (code, error_data.details).
 * Codes and meanings follow Meta's public error-code reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *
 * Titles are informational only; Meta advises handling errors by `code`.
 */

export interface CloudError {
  message: string;
  type: string;
  code: number;
  error_data: { messaging_product: 'whatsapp'; details: string };
  fbtrace_id: string;
}

export const ERRORS = {
  100: 'Invalid parameter',
  131000: 'Something went wrong',
  131026: 'Message undeliverable',
  131047: 'Re-engagement message',
  131049: 'Message not delivered to maintain healthy ecosystem engagement',
  131051: 'Unsupported message type',
  132000: 'Template param count mismatch',
  132001: 'Template does not exist',
} as const;

export type ErrorCode = keyof typeof ERRORS;

let trace = 0;

export function cloudError(code: ErrorCode, details: string, type = 'OAuthException'): { error: CloudError } {
  return {
    error: {
      message: `(#${code}) ${ERRORS[code]}`,
      type,
      code,
      error_data: { messaging_product: 'whatsapp', details },
      // Deterministic, obviously fake trace id.
      fbtrace_id: `SIMTRACE${String(++trace).padStart(6, '0')}`,
    },
  };
}

/** Same shape as the `errors[]` entries inside a failed status webhook. */
export function statusError(code: ErrorCode, details: string) {
  return {
    code,
    title: ERRORS[code],
    message: ERRORS[code],
    error_data: { details },
    href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
  };
}
