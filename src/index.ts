import { loadConfig, validateConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './server/app.js';
import { registerExtensions } from './extensions.js';

const config = loadConfig();
let warnings: string[];
try {
  warnings = validateConfig(config);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const rt = await createRuntime(config);
const app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
await app.listen({ host: config.host, port: config.port });
rt.selfUrl = `http://127.0.0.1:${config.port}`;
await rt.start();

const base = `http://localhost:${config.port}`;
console.log('Simulated fleet. No real WhatsApp accounts.');
for (const w of warnings) console.warn(`WARNING: ${w}`);
console.log(`Sessions: ${config.sessionCount} (seed ${config.seed}), state store: ${rt.store.kind}`);
if (rt.webhook) console.log(`Alert webhook: ${config.alertWebhookUrl ?? 'built-in demo sink (/demo/alert-sink)'}`);
if (config.telegramNotifierEnabled) console.log('Telegram notifier: stub enabled (logs only, no network)');
if (rt.virtualClock) console.log(`Virtual clock frozen at ${new Date(rt.clock.now()).toISOString()}`);
console.log(`Dashboard: ${base}/?token=${encodeURIComponent(config.demoToken)}`);
console.log(`API:       ${base}/api/sessions  (Authorization: Bearer <DEMO_TOKEN>)`);

const shutdown = async () => {
  await app.close();
  await rt.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
