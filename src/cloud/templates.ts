import { cloudError } from './errors.js';

/**
 * Simulated approved-template catalog. Names, languages and bodies are
 * invented for the demo. Parameter checks mirror the Cloud API's
 * 132000 / 132001 errors.
 */
export interface TemplateDef {
  name: string;
  category: 'UTILITY' | 'MARKETING';
  params: number;
  body: Record<'ar' | 'en', string>;
}

export const TEMPLATES: TemplateDef[] = [
  {
    name: 'order_update',
    category: 'UTILITY',
    params: 1,
    body: { ar: 'تحديث طلبك {{1}}: تم شحن الطلب.', en: 'Update on your order {{1}}: it has shipped.' },
  },
  {
    name: 'appointment_reminder',
    category: 'UTILITY',
    params: 2,
    body: { ar: 'تذكير بموعدك يوم {{1}} الساعة {{2}}.', en: 'Reminder: your appointment is on {{1}} at {{2}}.' },
  },
  {
    name: 'seasonal_offer',
    category: 'MARKETING',
    params: 0,
    body: { ar: 'عروض الموسم متاحة الآن في متجرنا التجريبي.', en: 'Seasonal offers are now live in our demo store.' },
  },
];

export interface TemplateRequest {
  name?: unknown;
  language?: { code?: unknown };
  components?: Array<{ type?: unknown; parameters?: Array<{ type?: unknown; text?: unknown }> }>;
}

export type TemplateCheck =
  | { ok: true; def: TemplateDef; lang: 'ar' | 'en'; params: string[]; text: string }
  | { ok: false; status: number; body: ReturnType<typeof cloudError> };

export function checkTemplate(t: TemplateRequest | undefined): TemplateCheck {
  const name = typeof t?.name === 'string' ? t.name : '';
  const lang = typeof t?.language?.code === 'string' ? t.language.code : '';
  const def = TEMPLATES.find((x) => x.name === name);
  if (!def || (lang !== 'ar' && lang !== 'en')) {
    return {
      ok: false,
      status: 404,
      body: cloudError(132001, `template name (${name || '?'}) does not exist in ${lang || '?'}`),
    };
  }
  const params: string[] = [];
  for (const c of t?.components ?? []) {
    if (c?.type !== 'body') continue;
    for (const p of c.parameters ?? []) {
      if (p?.type === 'text' && typeof p.text === 'string') params.push(p.text.slice(0, 200));
    }
  }
  if (params.length !== def.params) {
    return {
      ok: false,
      status: 400,
      body: cloudError(132000, `number of localizable_params (${params.length}) does not match the expected number of params (${def.params})`),
    };
  }
  const text = def.body[lang].replace(/\{\{(\d)\}\}/g, (_, i: string) => params[Number(i) - 1] ?? '');
  return { ok: true, def, lang, params, text };
}
