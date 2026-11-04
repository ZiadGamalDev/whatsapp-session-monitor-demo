import { loadConfig, type AppConfig } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { MonitorDb } from '../src/store/db.js';

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({}),
    dbPath: ':memory:',
    virtualTimeMs: 6 * 60_000,
    webDir: '/nonexistent',
    demoAlertSink: false,
    ...over,
  };
}

export async function testRuntime(over: Partial<AppConfig> = {}) {
  const config = testConfig(over);
  return createRuntime(config, { db: new MonitorDb(':memory:') });
}
