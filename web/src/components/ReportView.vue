<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, download, live, type GapDay } from '../api';
import { lang, reasonCode, reasonLabel, t } from '../i18n';

type Source = 'all' | 'cloud' | 'fleet';
interface Report {
  source: Source;
  days: GapDay[];
  totals: Omit<GapDay, 'date'>;
  reasons: Array<{ reason: string; count: number }>;
}

const source = ref<Source>('cloud');
const days = ref(7);
const report = ref<Report | null>(null);

async function load(): Promise<void> {
  report.value = await api<Report>(`/api/reports/delivery-gap?days=${days.value}&source=${source.value}`);
}
onMounted(load);
watch([source, days], load);
watch(
  () => live.inboxTick,
  () => {
    if (live.health?.clock !== 'virtual') void load();
  },
);

const max = computed(() => Math.max(1, ...(report.value?.days.map((d) => d.attempted) ?? [1])));
const pct = (n: number) => `${(n / max.value) * 100}%`;
const rate = (r: number | null) => (r === null ? '—' : `${r.toFixed(1)}%`);

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(lang.value === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

async function exportCsv(): Promise<void> {
  await download(`/api/reports/delivery-gap.csv?days=${days.value}&source=${source.value}`, `delivery-gap-${source.value}.csv`);
}
</script>

<template>
  <div class="page-head report-head">
    <div>
      <h1>{{ t('report.title') }}</h1>
      <p class="muted lead">{{ t('report.lead') }}</p>
    </div>
    <div class="report-controls">
      <div class="chips" role="group" :aria-label="t('report.source')">
        <button
          v-for="s in ['cloud', 'fleet', 'all'] as const"
          :key="s"
          type="button"
          :class="['chip', { active: source === s }]"
          :aria-pressed="source === s"
          @click="source = s"
        >
          {{ t(`report.src.${s}`) }}
        </button>
      </div>
      <label class="sr-only" for="report-days">{{ t('report.days', { n: days }) }}</label>
      <select id="report-days" v-model.number="days" class="input">
        <option v-for="n in [7, 14, 30]" :key="n" :value="n">{{ t('report.days', { n }) }}</option>
      </select>
      <button class="btn primary" type="button" @click="exportCsv">{{ t('report.csv') }}</button>
    </div>
  </div>

  <template v-if="report">
    <section class="kpis">
      <div class="kpi">
        <div class="kpi-label">{{ t('report.accepted') }}</div>
        <div class="kpi-value">{{ report.totals.accepted }}</div>
      </div>
      <div class="kpi kpi-good">
        <div class="kpi-label">{{ t('report.delivered') }}</div>
        <div class="kpi-value">{{ report.totals.delivered }}</div>
      </div>
      <div class="kpi kpi-warn">
        <div class="kpi-label">{{ t('report.gap') }}</div>
        <div class="kpi-value">{{ report.totals.gap }}</div>
        <div class="kpi-hint">{{ t('report.gapHint') }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">{{ t('report.rate') }}</div>
        <div class="kpi-value">{{ rate(report.totals.deliveryRate) }}</div>
      </div>
    </section>

    <section class="detail-grid report-grid">
      <div class="card">
        <div class="legend small">
          <span><i class="sw sw-delivered"></i>{{ t('legend.delivered') }}</span>
          <span><i class="sw sw-failed"></i>{{ t('legend.failed') }}</span>
          <span><i class="sw sw-noReceipt"></i>{{ t('legend.noReceipt') }}</span>
          <span><i class="sw sw-pending"></i>{{ t('legend.pending') }}</span>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">{{ t('report.col.date') }}</th>
                <th scope="col" class="num">{{ t('report.col.accepted') }}</th>
                <th scope="col" class="num">{{ t('report.col.delivered') }}</th>
                <th scope="col" class="num">{{ t('report.col.read') }}</th>
                <th scope="col" class="num">{{ t('report.col.failed') }}</th>
                <th scope="col" class="num">{{ t('report.col.noReceipt') }}</th>
                <th scope="col" class="num">{{ t('report.col.gap') }}</th>
                <th scope="col" class="num">{{ t('report.col.rate') }}</th>
                <th scope="col">{{ t('report.col.bar') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in report.days" :key="d.date">
                <td class="nowrap">{{ dayLabel(d.date) }}</td>
                <td class="num">{{ d.accepted }}</td>
                <td class="num">{{ d.delivered }}</td>
                <td class="num muted">{{ d.read }}</td>
                <td :class="['num', d.failed ? 'bad-text' : 'muted']">{{ d.failed }}</td>
                <td :class="['num', d.noReceipt ? 'warn-strong' : 'muted']">{{ d.noReceipt }}</td>
                <td :class="['num', d.gap ? 'warn-strong' : 'muted']">{{ d.gap }}</td>
                <td class="num">{{ rate(d.deliveryRate) }}</td>
                <td class="bar-cell">
                  <span class="stack" aria-hidden="true">
                    <span class="sw-delivered" :style="{ width: pct(d.delivered) }"></span>
                    <span class="sw-failed" :style="{ width: pct(d.failed) }"></span>
                    <span class="sw-noReceipt" :style="{ width: pct(d.noReceipt) }"></span>
                    <span class="sw-pending" :style="{ width: pct(d.pending) }"></span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2 class="card-title">{{ t('report.reasons') }}</h2>
        <table v-if="report.reasons.length" class="table">
          <thead>
            <tr>
              <th scope="col">{{ t('report.reasonCol') }}</th>
              <th scope="col" class="num">{{ t('report.countCol') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in report.reasons" :key="r.reason">
              <td>
                <div class="reason-label">
                  <span class="mono code-pill">{{ reasonCode(r.reason) === 'no_receipt' ? '—' : reasonCode(r.reason) }}</span>
                  {{ reasonLabel(r.reason) }}
                </div>
              </td>
              <td class="num warn-strong">{{ r.count }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">{{ t('report.noReasons') }}</p>
      </div>
    </section>
  </template>
</template>
