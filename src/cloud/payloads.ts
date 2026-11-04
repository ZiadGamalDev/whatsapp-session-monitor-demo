import type { AckStatus } from '../provider/types.js';

/**
 * Builders for webhook payloads in the documented Cloud API shape
 * (object / entry[] / changes[] / value.{metadata, statuses | contacts, messages}).
 * Status: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/status
 * Inbound messages: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * All ids are simulated.
 */

export const SIM_WABA_ID = '000000000000001';
export const SIM_PHONE_NUMBER_ID = '100000000000001';
export const SIM_DISPLAY_NUMBER = '99900000001';

const envelope = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: SIM_WABA_ID,
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: SIM_DISPLAY_NUMBER, phone_number_id: SIM_PHONE_NUMBER_ID },
            ...value,
          },
          field: 'messages',
        },
      ],
    },
  ],
});

export function statusPayload(s: {
  wamid: string;
  status: AckStatus;
  at: number;
  recipientId: string;
  errors?: unknown[];
}) {
  return envelope({
    statuses: [
      {
        id: s.wamid,
        status: s.status,
        timestamp: String(Math.floor(s.at / 1000)),
        recipient_id: s.recipientId,
        ...(s.errors ? { errors: s.errors } : {}),
      },
    ],
  });
}

export function inboundPayload(m: { wamid: string; from: string; name: string; at: number; text: string }) {
  return envelope({
    contacts: [{ profile: { name: m.name }, wa_id: m.from }],
    messages: [
      { from: m.from, id: m.wamid, timestamp: String(Math.floor(m.at / 1000)), type: 'text', text: { body: m.text } },
    ],
  });
}
