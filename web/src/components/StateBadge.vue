<script setup lang="ts">
import { t } from '../i18n';
defineProps<{ state: string; size?: 'lg' }>();
</script>

<template>
  <span :class="['badge', `st-${state}`, size === 'lg' ? 'badge-lg' : '']">
    <span class="badge-dot"></span>{{ t(`state.${state}`) }}
  </span>
</template>
