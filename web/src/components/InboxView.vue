<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, apiPost, live, type Conversation, type TemplateInfo, type ThreadMessage, type WindowState } from '../api';
import { composerMode } from '../logic';
import { customerName, duration, reasonCode, reasonLabel, stamp, t } from '../i18n';

const props = defineProps<{ waId: string | null }>();

const conversations = ref<Conversation[]>([]);
const serverNow = ref(0);
const fetchedAt = ref(Date.now());
const tickNow = ref(Date.now());
const query = ref('');
const thread = ref<{ contact: { waId: string; name: string; number: string }; window: WindowState; messages: ThreadMessage[] } | null>(null);
const templates = ref<TemplateInfo[]>([]);
const mode = ref<'text' | 'template'>('text');
const draft = ref('');
const tplName = ref('order_update');
const tplLang = ref<'ar' | 'en'>('ar');
const tplParams = ref<string[]>(['']);
const feedback = ref<{ kind: 'ok' | 'error'; text: string } | null>(null);
const busy = ref(false);
const scroller = ref<HTMLElement | null>(null);

const frozen = computed(() => live.health?.clock === 'virtual');
/** Server time, advanced locally between fetches unless the demo clock is frozen. */
const now = computed(() => serverNow.value + (frozen.value ? 0 : tickNow.value - fetchedAt.value));

async function loadList(): Promise<void> {
  const res = await api<{ now: number; conversations: Conversation[] }>('/api/inbox/conversations');
  conversations.value = res.conversations;
  serverNow.value = res.now;
  fetchedAt.value = Date.now();
}

async function loadThread(): Promise<void> {
  if (!props.waId) {
    thread.value = null;
    return;
  }
  const res = await api<{ now: number; contact: { waId: string; name: string; number: string }; window: WindowState; messages: ThreadMessage[] }>(
    `/api/inbox/conversations/${props.waId}`,
  );
  const first = thread.value?.contact.waId !== res.contact.waId;
  thread.value = res;
  serverNow.value = res.now;
  fetchedAt.value = Date.now();
  if (first) mode.value = res.window.open ? 'text' : 'template';
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  templates.value = (await api<{ data: TemplateInfo[] }>('/api/templates')).data;
  await Promise.all([loadList(), loadThread()]);
  timer = setInterval(() => (tickNow.value = Date.now()), 1_000);
});
onUnmounted(() => clearInterval(timer));
watch(() => props.waId, () => {
  feedback.value = null;
  draft.value = '';
  void loadThread();
});
watch(
  () => live.inboxTick,
  () => {
    void loadList();
    if (live.inboxEvent?.waId === props.waId) void loadThread();
  },
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return conversations.value;
  return conversations.value.filter(
    (c) => c.name.toLowerCase().includes(q) || customerName(c.name).includes(q) || c.number.includes(q) || c.waId.includes(q),
  );
});

function remaining(w: WindowState): number {
  return w.expiresAt === null ? 0 : Math.max(0, w.expiresAt - now.value);
}
function windowKind(w: WindowState): 'open' | 'closing' | 'closed' {
  const r = remaining(w);
  if (r <= 0) return 'closed';
  return r < 60 * 60_000 ? 'closing' : 'open';
}
function windowLabel(w: WindowState): string {
  const k = windowKind(w);
  if (k === 'closed') return t('win.closed');
  return `${t(k === 'open' ? 'win.open' : 'win.closing')} · ${t('win.left', { d: duration(remaining(w)) })}`;
}

const currentTemplate = computed(() => templates.value.find((x) => x.name === tplName.value));
watch(currentTemplate, (tpl) => {
  tplParams.value = Array.from({ length: tpl?.params ?? 0 }, (_, i) => tplParams.value[i] ?? '');
}, { immediate: true });
const preview = computed(() => {
  const tpl = currentTemplate.value;
  if (!tpl) return '';
  return (tpl.body[tplLang.value] ?? '').replace(/\{\{(\d)\}\}/g, (_, i: string) => tplParams.value[Number(i) - 1] || `{{${i}}}`);
});
const windowOpen = computed(() => (thread.value ? windowKind(thread.value.window) !== 'closed' : false));
/** What the composer actually shows: text is impossible once the window is closed. */
const effectiveMode = computed(() => composerMode(windowOpen.value, mode.value));
// When the countdown reaches zero, switch to templates on the spot.
watch(windowOpen, (open) => {
  if (!open) mode.value = 'template';
});

interface SendResponse {
  messages?: Array<{ id: string }>;
  error?: { code: number; message: string; error_data?: { details?: string } };
}

async function submit(): Promise<void> {
  if (!thread.value || busy.value) return;
  const to = thread.value.contact.number;
  const payload =
    effectiveMode.value === 'text'
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: draft.value } }
      : {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: tplName.value,
            language: { code: tplLang.value },
            components: [{ type: 'body', parameters: tplParams.value.map((p) => ({ type: 'text', text: p })) }],
          },
        };
  busy.value = true;
  try {
    const res = await apiPost<SendResponse>('/api/messages/send', payload);
    if (res.status === 200 && res.body.messages) {
      feedback.value = { kind: 'ok', text: t('send.accepted', { id: res.body.messages[0]!.id }) };
      draft.value = '';
    } else {
      const e = res.body.error;
      feedback.value = { kind: 'error', text: t('send.error', { code: e?.code ?? res.status, msg: e?.error_data?.details ?? e?.message ?? '' }) };
    }
    await Promise.all([loadThread(), loadList()]);
  } finally {
    busy.value = false;
  }
}

async function simulateReply(): Promise<void> {
  if (!thread.value) return;
  await apiPost('/api/sim/customer-reply', { waId: thread.value.contact.waId, text: t('sim.replyText') });
  await Promise.all([loadThread(), loadList()]);
}

function tickState(m: ThreadMessage): string {
  if (m.status === 'failed') return 'failed';
  if (m.status === 'read') return 'read';
  if (m.status === 'delivered') return 'delivered';
  if (m.status === 'sent') return 'sent';
  return 'pending';
}
</script>

<template>
  <div class="page-head">
    <h1>{{ t('inbox.title') }}</h1>
    <p class="muted lead">{{ t('inbox.lead') }}</p>
  </div>
  <section class="inbox card">
    <aside class="conv-list" :aria-label="t('tab.inbox')">
      <input v-model="query" class="input" type="search" :placeholder="t('inbox.search')" :aria-label="t('inbox.search')" />
      <ul>
        <li v-for="c in filtered" :key="c.waId">
          <a :href="`#/inbox/${c.waId}`" :class="['conv', { active: c.waId === props.waId }]" :aria-current="c.waId === props.waId ? 'true' : undefined">
            <span class="conv-top">
              <span class="conv-name">{{ customerName(c.name) }}</span>
              <span class="muted small">{{ c.lastMessage ? stamp(c.lastMessage.at, now) : '' }}</span>
            </span>
            <span class="conv-snippet muted small">
              <span v-if="c.lastMessage?.direction === 'out'" :class="['mini-tick', `tk-${c.lastMessage.status ?? 'pending'}`]" aria-hidden="true">
                {{ c.lastMessage.status === 'failed' ? '!' : c.lastMessage.status === 'delivered' || c.lastMessage.status === 'read' ? '✓✓' : '✓' }}
              </span>
              <bdi>{{ c.lastMessage?.body ?? '' }}</bdi>
            </span>
            <span :class="['win-badge', `win-${windowKind(c.window)}`]">{{ windowLabel(c.window) }}</span>
          </a>
        </li>
      </ul>
    </aside>

    <div v-if="!thread" class="thread empty">{{ t('inbox.empty') }}</div>
    <div v-else class="thread">
      <header class="thread-head">
        <div>
          <div class="thread-name">{{ customerName(thread.contact.name) }}</div>
          <div class="mono muted small" dir="ltr">{{ thread.contact.number }}</div>
        </div>
        <div class="thread-actions">
          <span :class="['win-badge', 'win-lg', `win-${windowKind(thread.window)}`]" :title="t('win.explain')">
            {{ windowLabel(thread.window) }}
          </span>
          <button class="btn ghost small-btn" type="button" @click="simulateReply">{{ t('sim.reply') }}</button>
        </div>
      </header>

      <div ref="scroller" class="bubbles" role="log" aria-live="polite">
        <div v-for="m in thread.messages" :key="m.id" :class="['bubble-row', m.direction]">
          <div :class="['bubble', m.direction, { failed: m.status === 'failed' }]">
            <div v-if="m.kind === 'template'" class="tpl-badge">{{ t('tpl.badge', { name: m.templateName ?? '' }) }}</div>
            <div class="bubble-text" dir="auto">{{ m.body }}</div>
            <div class="bubble-meta">
              <span class="stamp">{{ stamp(m.at, now) }}</span>
              <span
                v-if="m.direction === 'out'"
                :class="['ticks', `tk-${tickState(m)}`]"
                role="img"
                :aria-label="t(`tick.${tickState(m)}`)"
                :title="t(`tick.${tickState(m)}`)"
              >
                <svg v-if="tickState(m) === 'pending'" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M8 4.5V8l2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
                <svg v-else-if="tickState(m) === 'sent'" viewBox="0 0 16 16" width="15" height="15"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                <svg v-else-if="tickState(m) === 'failed'" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.5" fill="currentColor" /><path d="M8 4.5v4.2M8 11.2v.1" stroke="#fff" stroke-width="1.8" stroke-linecap="round" /></svg>
                <svg v-else viewBox="0 0 20 16" width="19" height="15"><path d="M1.5 8.5l3 3 7-7M8.5 11.5l7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </span>
            </div>
            <div v-if="m.status === 'failed' && m.error" class="bubble-note bad">
              <bdi class="mono">{{ reasonCode(m.error) }}</bdi> · {{ reasonLabel(m.error) }}
            </div>
            <div v-else-if="m.undelivered" class="bubble-note warn">{{ t('tick.noReceipt', { d: duration(now - (m.sentAt ?? m.at)) }) }}</div>
            <div v-else-if="m.lateDelivery" class="bubble-note info">{{ t('tick.late') }}</div>
          </div>
        </div>
      </div>

      <form class="composer" @submit.prevent="submit">
        <div class="composer-modes" role="group">
          <button
            type="button"
            :class="['chip', { active: effectiveMode === 'text' }]"
            :aria-pressed="effectiveMode === 'text'"
            :disabled="!windowOpen"
            :title="windowOpen ? undefined : t('win.templateOnly')"
            @click="mode = 'text'"
          >
            {{ t('send.useText') }}
          </button>
          <button type="button" :class="['chip', { active: effectiveMode === 'template' }]" :aria-pressed="effectiveMode === 'template'" @click="mode = 'template'">
            {{ t('send.useTemplate') }}
          </button>
          <span v-if="!windowOpen" class="closed-hint">{{ t('send.closedHint') }}</span>
        </div>
        <div v-if="effectiveMode === 'text'" class="composer-row">
          <label class="sr-only" for="composer-text">{{ t('send.placeholder') }}</label>
          <input id="composer-text" v-model="draft" class="input grow" :placeholder="t('send.placeholder')" maxlength="4096" />
          <button class="btn primary" type="submit" :disabled="busy || !draft.trim()">{{ t('send.text') }}</button>
        </div>
        <div v-else class="composer-row wrap">
          <label class="field">
            <span class="field-label">{{ t('send.template') }}</span>
            <select v-model="tplName" class="input">
              <option v-for="x in templates" :key="x.name" :value="x.name">{{ x.name }} · {{ x.category }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ t('send.lang') }}</span>
            <select v-model="tplLang" class="input">
              <option value="ar">ar</option>
              <option value="en">en</option>
            </select>
          </label>
          <label v-for="(_, i) in tplParams" :key="i" class="field">
            <span class="field-label">{{ t('send.param', { n: i + 1 }) }}</span>
            <input v-model="tplParams[i]" class="input" maxlength="200" />
          </label>
          <div class="tpl-preview muted small">{{ preview }}</div>
          <button class="btn primary" type="submit" :disabled="busy">{{ t('send.sendTemplate') }}</button>
        </div>
        <p v-if="feedback" :class="['feedback', feedback.kind]" role="status">{{ feedback.text }}</p>
      </form>
    </div>
  </section>
</template>
