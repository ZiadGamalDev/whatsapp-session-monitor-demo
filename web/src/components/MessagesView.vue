<script setup lang="ts">
import { messageLink } from '../logic';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, live, type Message } from '../api';
import { clock, duration, label, t } from '../i18n';
import StateBadge from './StateBadge.vue';

interface Totals {
  total: number;
  undelivered: number;
  delivered: number;
  failed: number;
  read: number;
}
const messages = ref<Message[]>([]);
const totals = ref<Totals | null>(null);

async function load(): Promise<void> {
  const res = await api<{ messages: Message[]; totals: Totals }>('/api/messages?undelivered=1&limit=200');
  messages.value = res.messages;
  totals.value = res.totals;
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (live.health?.clock !== 'virtual') void load();
  }, 3_000);
});
onUnmounted(() => clearInterval(timer));

const now = computed(() => live.fleet?.now ?? 0);
const bySession = computed(() =>
  (live.fleet?.sessions ?? []).filter((s) => s.undelivered > 0).sort((a, b) => b.undelivered - a.undelivered),
);
const max = computed(() => Math.max(1, ...bySession.value.map((s) => s.undelivered)));
const rowOf = (id: string) => live.fleet?.sessions.find((s) => s.id === id);
</script>

<template>
  <div class="page-head">
    <h1>{{ t('msgs.title') }}</h1>
    <p class="muted lead">{{ t('msgs.lead', { s: duration(live.fleet?.policy.ackTimeoutMs ?? null) }) }}</p>
  </div>

  <section v-if="totals" class="kpis kpis-4">
    <div class="kpi">
      <div class="kpi-label">{{ t('msgs.total') }}</div>
      <div class="kpi-value">{{ totals.total }}</div>
    </div>
    <div class="kpi kpi-good">
      <div class="kpi-label">{{ t('msgs.delivered') }}</div>
      <div class="kpi-value">{{ totals.delivered + totals.read }}</div>
    </div>
    <div class="kpi kpi-warn">
      <div class="kpi-label">{{ t('msgs.flagged') }}</div>
      <div class="kpi-value">{{ totals.undelivered }}</div>
    </div>
    <div class="kpi kpi-bad">
      <div class="kpi-label">{{ t('msgs.failed') }}</div>
      <div class="kpi-value">{{ totals.failed }}</div>
    </div>
  </section>

  <section class="detail-grid msgs-grid">
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{{ t('msgcol.id') }}</th>
              <th scope="col">{{ t('msgcol.session') }}</th>
              <th scope="col">{{ t('msgcol.to') }}</th>
              <th scope="col">{{ t('msgcol.status') }}</th>
              <th scope="col" class="num">{{ t('msgcol.sentAt') }}</th>
              <th scope="col" class="num">{{ t('msgcol.waiting') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in messages.slice(0, 13)" :key="m.id">
              <td class="mono">{{ m.id }}</td>
              <td>
                <a :href="messageLink(m)" class="link">{{ m.source === 'cloud' ? t('msgs.cloudSource') : label(rowOf(m.sessionId)?.label ?? m.sessionId) }}</a>
              </td>
              <td class="mono muted" dir="ltr">{{ m.to }}</td>
              <td>
                <span :class="['msg-status', `st-${m.status}`]">{{ t(`msg.${m.status}`) }}</span>
                <span class="note note-warn">{{ t('msg.flag') }}</span>
              </td>
              <td class="num mono">{{ clock(m.sentAt) }}</td>
              <td class="num warn-strong">{{ duration(now - (m.sentAt ?? m.createdAt)) }}</td>
            </tr>
            <tr v-if="messages.length === 0">
              <td colspan="6" class="empty">{{ t('noMessages') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h2 class="card-title">{{ t('msgs.bySession') }}</h2>
      <ul class="bars">
        <li v-for="s in bySession" :key="s.id">
          <a :href="`#/sessions/${s.id}`" class="bar-row">
            <span class="bar-label">{{ label(s.label) }}</span>
            <StateBadge :state="s.state" />
            <span class="bar"><span :style="{ width: (s.undelivered / max) * 100 + '%' }"></span></span>
            <span class="bar-n">{{ s.undelivered }}</span>
          </a>
        </li>
      </ul>
    </div>
  </section>
</template>
