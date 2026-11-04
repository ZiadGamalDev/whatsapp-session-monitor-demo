<script setup lang="ts">
import { computed, ref } from 'vue';
import { STATES, live, type FleetRow, type SessionState } from '../api';
import { duration, label, t } from '../i18n';
import StateBadge from './StateBadge.vue';

const PROBLEMS: SessionState[] = ['degraded', 'reconnecting', 'logged_out', 'stuck'];
const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
const stateFilter = ref<SessionState | 'all'>((params.get('state') as SessionState) || 'all');
const problemsOnly = ref(params.get('problems') === '1');
const query = ref('');

const fleet = computed(() => live.fleet);
const summary = computed(() => fleet.value?.summary);
const gap = computed(() => (summary.value ? summary.value.naiveConnected - summary.value.healthy : 0));
const sec = (ms: number | null) => duration(ms);

const rows = computed<FleetRow[]>(() => {
  const all = fleet.value?.sessions ?? [];
  const q = query.value.trim().toLowerCase();
  return all.filter((r) => {
    if (stateFilter.value !== 'all' && r.state !== stateFilter.value) return false;
    if (problemsOnly.value && !(PROBLEMS.includes(r.state) || r.undelivered > 0)) return false;
    if (q && !(r.id.includes(q) || r.label.toLowerCase().includes(q) || label(r.label).includes(q) || r.phone.includes(q)))
      return false;
    return true;
  }).sort(bySeverity);
});

const SEVERITY: SessionState[] = ['stuck', 'logged_out', 'degraded', 'reconnecting', 'connecting', 'connected'];
function bySeverity(a: FleetRow, b: FleetRow): number {
  return (
    SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state) || b.undelivered - a.undelivered || a.id.localeCompare(b.id)
  );
}

function sinceMs(r: FleetRow): number {
  return Math.max(0, (fleet.value?.now ?? 0) - r.stateSince);
}

function hbClass(r: FleetRow): string {
  if (r.heartbeatAgeMs === null) return 'muted';
  if (r.heartbeatAgeMs >= (fleet.value?.policy.degradedAfterMs ?? Infinity)) return 'warn-text';
  return '';
}

function open(id: string): void {
  location.hash = `#/sessions/${id}`;
}
</script>

<template>
  <section v-if="summary" class="kpis">
    <div class="kpi">
      <div class="kpi-label">{{ t('kpi.naive') }}</div>
      <div class="kpi-value">{{ summary.naiveConnected }}<span class="kpi-of">/ {{ summary.total }}</span></div>
      <div class="kpi-hint">{{ t('kpi.naiveHint') }}</div>
    </div>
    <div class="kpi kpi-good">
      <div class="kpi-label">{{ t('kpi.healthy') }}</div>
      <div class="kpi-value">{{ summary.healthy }}<span class="kpi-of">/ {{ summary.total }}</span></div>
      <div class="kpi-hint">
        {{ t('kpi.healthyHint', { s: sec(fleet?.policy.degradedAfterMs ?? null) }) }}
        <span v-if="gap > 0" class="gap-pill">{{ gap }} {{ t('kpi.gap') }}</span>
      </div>
    </div>
    <a class="kpi kpi-warn" href="#/messages">
      <div class="kpi-label">{{ t('kpi.undelivered') }}</div>
      <div class="kpi-value">{{ summary.undelivered }}</div>
      <div class="kpi-hint">{{ t('kpi.undeliveredHint', { s: sec(fleet?.policy.ackTimeoutMs ?? null) }) }}</div>
    </a>
    <div class="kpi kpi-bad">
      <div class="kpi-label">{{ t('kpi.needsRelink') }}</div>
      <div class="kpi-value">{{ summary.needsRelink }}</div>
      <div class="kpi-hint">{{ t('kpi.needsRelinkHint') }}</div>
    </div>
  </section>

  <section class="card">
    <div class="filters">
      <div class="chips" role="group" :aria-label="t('filter.stateGroup')">
        <button
          :class="['chip', { active: stateFilter === 'all' }]"
          type="button"
          :aria-pressed="stateFilter === 'all'"
          @click="stateFilter = 'all'"
        >
          {{ t('filter.all') }} <span class="chip-n">{{ summary?.total ?? 0 }}</span>
        </button>
        <button
          v-for="s in STATES"
          :key="s"
          :class="['chip', `chip-${s}`, { active: stateFilter === s }]"
          type="button"
          :aria-pressed="stateFilter === s"
          @click="stateFilter = stateFilter === s ? 'all' : s"
        >
          <span :class="['badge-dot', `dot-${s}`]" aria-hidden="true"></span>{{ t(`state.${s}`) }}
          <span class="chip-n">{{ summary?.byState[s] ?? 0 }}</span>
        </button>
      </div>
      <div class="filter-right">
        <label class="toggle">
          <input v-model="problemsOnly" type="checkbox" />
          <span>{{ t('filter.problems') }}</span>
        </label>
        <input
          v-model="query"
          class="input search"
          type="search"
          :placeholder="t('filter.search')"
          :aria-label="t('filter.search')"
        />
      </div>
    </div>
    <div class="table-meta muted">{{ t('filter.count', { n: rows.length, total: summary?.total ?? 0 }) }}</div>

    <div class="table-wrap">
      <table class="table fleet-table">
        <caption class="sr-only">{{ t('fleet.caption') }}</caption>
        <thead>
          <tr>
            <th scope="col">{{ t('col.session') }}</th>
            <th scope="col">{{ t('col.phone') }}</th>
            <th scope="col">{{ t('col.state') }}</th>
            <th scope="col">{{ t('col.transport') }}</th>
            <th scope="col" class="num">{{ t('col.heartbeat') }}</th>
            <th scope="col" class="num">{{ t('col.reconnects') }}</th>
            <th scope="col" class="num">{{ t('col.undelivered') }}</th>
            <th scope="col" class="num">{{ t('col.since') }}</th>
            <th scope="col">{{ t('col.note') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="row-link" @click="open(r.id)">
            <td class="cell-title">
              <span class="iso-row">
                <a class="row-anchor" :href="`#/sessions/${r.id}`" @click.stop>{{ label(r.label) }}</a>
                <span class="muted mono">{{ r.id }}</span>
              </span>
            </td>
            <td class="muted mono small" dir="ltr">{{ r.phone }}</td>
            <td><StateBadge :state="r.state" /></td>
            <td>
              <span :class="['naive', r.naiveStatus]">{{ t(`naive.${r.naiveStatus}`) }}</span>
              <span v-if="r.lastCloseCode && r.naiveStatus === 'disconnected'" class="muted small mono gap-s">{{ r.lastCloseCode }}</span>
            </td>
            <td :class="['num', hbClass(r)]">{{ duration(r.heartbeatAgeMs) }}</td>
            <td class="num">{{ r.reconnectCount }}</td>
            <td :class="['num', r.undelivered > 0 ? 'warn-strong' : 'muted']">{{ r.undelivered }}</td>
            <td class="num muted">{{ duration(sinceMs(r)) }}</td>
            <td>
              <div class="notes">
                <span v-if="r.stuckReason" class="note note-bad">{{ t(`note.${r.stuckReason}`) }}</span>
                <span v-else-if="r.needsRelink" class="note note-bad">{{ t('note.needsRelink') }}</span>
                <span v-if="r.naiveStatus === 'connected' && r.state === 'degraded'" class="note note-warn">{{ t('note.mismatch') }}</span>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="9" class="empty">{{ t('empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
