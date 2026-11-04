<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, live, type SessionDetail, type TimelineEntry } from '../api';
import { arrow, clock, duration, has, label, t } from '../i18n';
import StateBadge from './StateBadge.vue';

const props = defineProps<{ id: string }>();
const detail = ref<SessionDetail | null>(null);
const notFound = ref(false);
const flash = ref('');

async function load(): Promise<void> {
  try {
    detail.value = await api<SessionDetail>(`/api/sessions/${props.id}`);
  } catch {
    notFound.value = true;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (live.health?.clock !== 'virtual') void load();
  }, 2_000);
});
onUnmounted(() => clearInterval(timer));
watch(
  () => live.tick,
  () => {
    if (live.lastTimeline?.sessionId === props.id) void load();
  },
);

/** Live row from the SSE fleet feed keeps ages ticking between reloads. */
const s = computed(() => live.fleet?.sessions.find((r) => r.id === props.id) ?? detail.value?.session ?? null);
const policy = computed(() => detail.value?.policy);
const hbPct = computed(() => {
  const age = s.value?.heartbeatAgeMs;
  const dead = policy.value?.deadAfterMs ?? 45_000;
  if (age === null || age === undefined) return 100;
  return Math.min(100, Math.round((age / dead) * 100));
});
const hbLevel = computed(() => {
  const age = s.value?.heartbeatAgeMs;
  if (age === null || age === undefined) return 'dead';
  if (age >= (policy.value?.deadAfterMs ?? 45_000)) return 'dead';
  if (age >= (policy.value?.degradedAfterMs ?? Infinity)) return 'warn';
  return 'ok';
});

function describe(e: TimelineEntry): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.kind === 'event') return t(`tl.event.${e.code}`, { code: String(d.code ?? '') });
  if (e.kind === 'transition') {
    return t('tl.transition', { from: t(`state.${d.from}`), to: t(`state.${d.to}`), arrow: arrow() });
  }
  if (e.kind === 'action') {
    return t(`tl.action.${e.code}`, {
      attempt: String(d.attempt ?? ''),
      max: String(d.maxAttempts ?? ''),
      delay: duration(Number(d.delayMs ?? 0), true),
      from: String(d.from ?? '—'),
      to: String(d.to ?? ''),
      arrow: arrow(),
    });
  }
  return t(`tl.message.${e.code}`, {
    messageId: String(d.messageId ?? ''),
    timeout: duration(Number(d.timeoutMs ?? 0)),
  });
}

function reason(e: TimelineEntry): string {
  if (e.kind !== 'transition') return '';
  if (e.code.startsWith('close_')) return t('reason.close', { code: e.code.slice(6) });
  return has(`reason.${e.code}`) ? t(`reason.${e.code}`) : e.code;
}

function tone(e: TimelineEntry): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.kind === 'transition') {
    const to = String(d.to);
    if (to === 'connected') return 'ok';
    if (to === 'degraded' || to === 'reconnecting') return 'warn';
    if (to === 'stuck' || to === 'logged_out') return 'bad';
    return 'info';
  }
  if (e.kind === 'message') return 'warn';
  if (e.kind === 'event' && (e.code === 'error' || e.code === 'close')) return 'bad';
  if (e.kind === 'action') return 'info';
  return 'neutral';
}

async function relink(): Promise<void> {
  if (!confirm(t('relinkConfirm'))) return;
  await api(`/api/sessions/${props.id}/relink`, { method: 'POST' });
  flash.value = t('relinkDone');
  await load();
}
</script>

<template>
  <div v-if="notFound" class="card empty">{{ t('empty') }}</div>
  <template v-else-if="s && detail">
    <div class="detail-head">
      <a class="back" href="#/">{{ arrow() === '←' ? '→' : '←' }} {{ t('back') }}</a>
      <div class="detail-title">
        <h1>{{ label(s.label) }} <span class="muted mono">{{ s.id }}</span></h1>
        <span class="mono muted" dir="ltr">{{ s.phone }}</span>
        <StateBadge :state="s.state" size="lg" />
        <span v-if="s.stuckReason" class="note note-bad">{{ t(`note.${s.stuckReason}`) }}</span>
        <span v-else-if="s.needsRelink" class="note note-bad">{{ t('note.needsRelink') }}</span>
      </div>
      <div class="relink">
        <button class="btn danger" type="button" @click="relink">{{ t('relink') }}</button>
        <div class="muted small">{{ flash || t('relinkHint') }}</div>
      </div>
    </div>

    <section class="cards">
      <div class="card stat">
        <div class="stat-label">{{ t('card.heartbeat') }}</div>
        <div :class="['stat-value', `lvl-${hbLevel}`]">{{ duration(s.heartbeatAgeMs) }}</div>
        <div class="meter"><span v-if="s.heartbeatAgeMs !== null" :class="`lvl-${hbLevel}`" :style="{ width: hbPct + '%' }"></span></div>
        <div class="stat-hint">
          {{ t('card.heartbeatHint', { d: duration(policy?.degradedAfterMs), x: duration(policy?.deadAfterMs) }) }}
        </div>
      </div>
      <div class="card stat">
        <div class="stat-label">{{ t('card.transport') }}</div>
        <div class="stat-value">
          <span :class="['naive', s.naiveStatus]">{{ t(`naive.${s.naiveStatus}`) }}</span>
        </div>
        <div class="stat-hint mono">
          {{ s.lastEvent ?? '—' }}<template v-if="s.lastCloseCode"> · {{ s.lastCloseCode }}</template>
          <template v-if="s.lastError"> · {{ s.lastError }}</template> · {{ clock(s.lastEventAt) }}
        </div>
      </div>
      <div class="card stat">
        <div class="stat-label">{{ t('card.reconnects') }}</div>
        <div class="stat-value">{{ s.reconnectCount }}</div>
        <div class="stat-hint">{{ t('card.attempts', { a: Math.min(s.attempts, policy?.maxAttempts ?? 0), m: policy?.maxAttempts ?? 0 }) }}</div>
      </div>
      <div class="card stat">
        <div class="stat-label">{{ t('card.undelivered') }}</div>
        <div :class="['stat-value', s.undelivered > 0 ? 'lvl-warn' : '']">{{ s.undelivered }}</div>
        <div class="stat-hint">{{ t('card.undeliveredHint', { n: s.flaggedTotal }) }}</div>
      </div>
      <div class="card stat cred">
        <div class="stat-label">{{ t('card.credentials') }}</div>
        <div class="stat-value mono small-value" dir="ltr">{{ s.credentialFingerprint ?? '—' }}</div>
        <div class="stat-hint">
          {{ t('card.generation', { g: s.credentialGeneration ?? 0 }) }} · {{ t('card.wipes', { n: s.credentialWipes }) }}
        </div>
      </div>
    </section>

    <div class="rule-note">{{ t('credRule') }}</div>

    <section class="detail-grid">
      <div class="card">
        <h2 class="card-title">{{ t('timeline') }}</h2>
        <ol class="timeline">
          <li v-for="(e, i) in detail.timeline" :key="i" :class="['tl', `tone-${tone(e)}`]">
            <span class="tl-dot"></span>
            <span class="tl-time mono">{{ clock(e.at) }}</span>
            <span class="tl-body">
              <span class="tl-text">{{ describe(e) }}</span>
              <span v-if="reason(e)" class="tl-reason">{{ reason(e) }}</span>
            </span>
          </li>
          <li v-if="detail.timeline.length === 0" class="empty">{{ t('timelineEmpty') }}</li>
        </ol>
      </div>
      <div class="side">
        <div class="card sim-card">
          <div class="stat-label">{{ t('sim.title') }}</div>
          <div class="sim-value">{{ detail.simulatorScenario ? t(`scenario.${detail.simulatorScenario}`) : '—' }}</div>
          <div class="stat-hint">{{ t('sim.note') }}</div>
        </div>
        <div class="card">
          <h2 class="card-title">
            {{ t('undeliveredTitle') }} <span class="count-pill warn">{{ detail.undeliveredMessages.length }}</span>
          </h2>
          <ul class="msg-list">
            <li v-for="m in detail.undeliveredMessages.slice(0, 6)" :key="m.id" class="msg flagged">
              <span class="mono">{{ m.id }}</span>
              <span class="mono muted" dir="ltr">{{ m.to }}</span>
              <span class="msg-status st-sent">{{ t('msg.sent') }}</span>
              <span class="note note-warn">{{ t('msg.flag') }}</span>
              <span class="muted small">{{ duration(detail.now - (m.sentAt ?? m.createdAt)) }}</span>
            </li>
            <li v-if="detail.undeliveredMessages.length === 0" class="empty">{{ t('noMessages') }}</li>
          </ul>
          <h2 class="card-title sub">{{ t('recentMessages') }}</h2>
          <ul class="msg-list">
            <li v-for="m in detail.messages.slice(0, 8)" :key="m.id" :class="['msg', { flagged: m.undelivered }]">
              <span class="mono">{{ m.id }}</span>
              <span class="mono muted" dir="ltr">{{ m.to }}</span>
              <span :class="['msg-status', `st-${m.status}`]">{{ t(`msg.${m.status}`) }}</span>
              <span v-if="m.lateDelivery" class="note note-info">{{ t('msg.late') }}</span>
              <span class="muted small">{{ clock(m.createdAt) }}</span>
            </li>
            <li v-if="detail.messages.length === 0" class="empty">{{ t('noMessages') }}</li>
          </ul>
        </div>
      </div>
    </section>
  </template>
</template>
