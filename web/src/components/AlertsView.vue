<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, live, type Alert } from '../api';
import { arrow, clock, has, label, t } from '../i18n';
import StateBadge from './StateBadge.vue';

const alerts = ref<Alert[]>([]);
const total = ref(0);

async function load(): Promise<void> {
  const res = await api<{ alerts: Alert[]; total: number }>('/api/alerts?limit=100');
  alerts.value = res.alerts;
  total.value = res.total;
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (live.health?.clock !== 'virtual') void load();
  }, 3_000);
});
onUnmounted(() => clearInterval(timer));
watch(
  () => live.tick,
  () => void load(),
);

const rowOf = (id: string) => live.fleet?.sessions.find((s) => s.id === id);

function reason(a: Alert): string {
  const code = a.reason ?? '';
  if (code.startsWith('close_')) return t('reason.close', { code: code.slice(6) });
  return has(`reason.${code}`) ? t(`reason.${code}`) : code;
}
</script>

<template>
  <div class="page-head">
    <h1>{{ t('alerts.title') }} <span class="count-pill">{{ total }}</span></h1>
    <p class="muted lead">{{ t('alerts.lead') }}</p>
  </div>
  <section class="card">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">{{ t('alertcol.time') }}</th>
            <th scope="col">{{ t('alertcol.session') }}</th>
            <th scope="col">{{ t('alertcol.change') }}</th>
            <th scope="col">{{ t('alertcol.reason') }}</th>
            <th scope="col">{{ t('alertcol.webhook') }}</th>
            <th scope="col">{{ t('alertcol.channels') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in alerts.slice(0, 14)" :key="a.id">
            <td class="mono">{{ clock(a.at) }}</td>
            <td>
              <span class="iso-row">
                <a :href="`#/sessions/${a.sessionId}`" class="link">{{ label(rowOf(a.sessionId)?.label ?? a.sessionId) }}</a>
                <span class="muted mono small">{{ a.sessionId }}</span>
              </span>
            </td>
            <td class="change">
              <StateBadge v-if="a.fromState" :state="a.fromState" />
              <span class="muted">{{ arrow() }}</span>
              <StateBadge v-if="a.toState" :state="a.toState" />
            </td>
            <td>{{ reason(a) }}</td>
            <td>
              <span :class="['delivery', `dl-${a.deliveryStatus}`]">{{ t(`delivery.${a.deliveryStatus}`) }}</span>
              <span v-if="a.attempts > 0" class="muted small gap-s">{{ t('attempts', { n: a.attempts }) }}</span>
            </td>
            <td class="mono small">{{ a.channels.join(', ') || '—' }}</td>
          </tr>
          <tr v-if="alerts.length === 0">
            <td colspan="6" class="empty">{{ t('alerts.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
