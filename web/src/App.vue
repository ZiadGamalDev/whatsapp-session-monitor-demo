<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { applyLang, lang, t } from './i18n';
import { connectLive, live, loadToken, saveToken } from './api';
import FleetView from './components/FleetView.vue';
import SessionView from './components/SessionView.vue';
import MessagesView from './components/MessagesView.vue';
import AlertsView from './components/AlertsView.vue';
import InboxView from './components/InboxView.vue';
import ReportView from './components/ReportView.vue';

const hash = ref(location.hash || '#/');
window.addEventListener('hashchange', () => {
  hash.value = location.hash || '#/';
  window.scrollTo(0, 0);
});

const route = computed(() => {
  const h = hash.value.replace(/^#/, '');
  const m = h.match(/^\/sessions\/([\w-]+)/);
  if (m) return { name: 'session' as const, id: m[1]! };
  const inbox = h.match(/^\/inbox(?:\/(\d+))?/);
  if (inbox) return { name: 'inbox' as const, waId: inbox[1] ?? null };
  if (h.startsWith('/report')) return { name: 'report' as const };
  if (h.startsWith('/messages')) return { name: 'messages' as const };
  if (h.startsWith('/alerts')) return { name: 'alerts' as const };
  return { name: 'fleet' as const };
});

const tokenInput = ref('');
const isActive = (name: string) => route.value.name === name || (name === 'fleet' && route.value.name === 'session');
const ready = ref(false);

async function start(): Promise<void> {
  try {
    await connectLive();
    ready.value = true;
  } catch {
    ready.value = false;
  }
}

async function submitToken(): Promise<void> {
  saveToken(tokenInput.value.trim());
  await start();
}

function toggleLang(): void {
  applyLang(lang.value === 'ar' ? 'en' : 'ar');
}

onMounted(async () => {
  applyLang(lang.value);
  live.token = loadToken();
  if (live.token) await start();
});

const tabs = computed(() => [
  { href: '#/', name: 'fleet', label: t('tab.fleet') },
  { href: '#/inbox', name: 'inbox', label: t('tab.inbox') },
  { href: '#/messages', name: 'messages', label: t('tab.messages'), count: live.fleet?.undeliveredMessages },
  { href: '#/report', name: 'report', label: t('tab.report') },
  { href: '#/alerts', name: 'alerts', label: t('tab.alerts') },
]);
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 12a9 9 0 1 1 4.2 7.6L3 21l1.4-4.1A9 9 0 0 1 3 12Zm5-1h2v6H8v-6Zm3-3h2v9h-2V8Zm3 5h2v4h-2v-4Z"/></svg>
        </span>
        <div>
          <div class="title">{{ t('appTitle') }}</div>
          <div class="subtitle">{{ t('simBanner') }}</div>
        </div>
        <span class="sim-badge">{{ t('simBadge') }}</span>
      </div>
      <nav class="tabs" v-if="ready">
        <a
          v-for="tab in tabs"
          :key="tab.name"
          :href="tab.href"
          :class="['tab', { active: isActive(tab.name) }]"
          :aria-current="isActive(tab.name) ? 'page' : undefined"
        >
          {{ tab.label }}
          <span v-if="tab.count" class="tab-count">{{ tab.count }}</span>
        </a>
      </nav>
      <div class="top-actions">
        <span v-if="ready" :class="['live', { on: live.connected }]" role="status">
          <span class="dot"></span>
          {{ live.health?.clock === 'virtual' ? t('frozen') : live.connected ? t('live') : t('offline') }}
        </span>
        <button class="btn ghost" type="button" :lang="lang === 'ar' ? 'en' : 'ar'" @click="toggleLang">
          {{ t('langToggle') }}
        </button>
      </div>
    </header>

    <main class="content">
      <form v-if="!ready" class="token-card card" @submit.prevent="submitToken">
        <h2>{{ t('token.title') }}</h2>
        <p class="muted">{{ t('token.lead') }}</p>
        <label for="token-input" class="field-label">{{ t('token.title') }}</label>
        <input id="token-input" v-model="tokenInput" class="input" type="password" autocomplete="off" dir="ltr" />
        <p v-if="live.authFailed" class="error-text">{{ t('token.invalid') }}</p>
        <button class="btn primary" type="submit">{{ t('token.submit') }}</button>
      </form>
      <template v-else>
        <FleetView v-if="route.name === 'fleet'" />
        <SessionView v-else-if="route.name === 'session'" :id="route.id" :key="route.id" />
        <MessagesView v-else-if="route.name === 'messages'" />
        <AlertsView v-else-if="route.name === 'alerts'" />
        <InboxView v-else-if="route.name === 'inbox'" :wa-id="route.waId" />
        <ReportView v-else-if="route.name === 'report'" />
      </template>
    </main>
  </div>
</template>
