/**
 * Deterministic dashboard screenshots.
 *
 * Starts the app in-process on a virtual clock, fast-forwards the seeded
 * fleet by VIRTUAL_TIME_MS (default 8 simulated minutes), freezes time and
 * captures 1440x900 PNGs into docs/screenshots/.
 *
 *   npm run screenshots
 */
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { registerExtensions } from '../src/extensions.js';
import { createRuntime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { MonitorDb } from '../src/store/db.js';

const OUT = resolve('docs/screenshots');
const MAX_BYTES = 300 * 1024;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const config = {
    ...loadConfig({
      ...process.env,
      VIRTUAL_TIME_MS: process.env.VIRTUAL_TIME_MS || String(8 * 60_000),
      DEMO_ALERT_SINK: 'true',
      REDIS_URL: '',
    }),
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
  };
  const rt = await createRuntime(config, { db: new MonitorDb(':memory:') });
  const app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  rt.selfUrl = base;
  // Alert webhooks need a listening server, so start the fleet after listen.
  await rt.start();
  await new Promise((r) => setTimeout(r, 1_500)); // let webhook deliveries settle
  await rt.flush();

  const fleet = await rt.fleet();
  const pick = (scenario: string, pref: (s: (typeof fleet.sessions)[number]) => boolean) => {
    const of = fleet.sessions.filter((s) => rt.provider.scenarioOf(s.id) === scenario);
    return (of.find(pref) ?? of[0])!.id;
  };
  const silent = pick('silent_drop', (s) => s.state === 'degraded');
  const stuck = pick('stuck_reconnecting', (s) => s.state === 'stuck');

  const token = encodeURIComponent(config.demoToken);
  // Any console error (including a CSP violation) fails the run.
  const problems: string[] = [];
  // A fresh browser per capture: Chromium's glyph cache is shared across
  // pages, and a warm cache can change anti-aliasing of small text by a few
  // pixels, which would make the PNGs differ between runs.
  const openPage = async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      timezoneId: 'UTC',
      locale: 'ar-EG',
    });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(String(e)));
    return { browser, page };
  };

  const shots: Array<{ name: string; lang: 'ar' | 'en'; hash: string; ready: string }> = [
    { name: '01-fleet-overview', lang: 'ar', hash: '#/', ready: '.fleet-table tbody tr' },
    { name: '02-session-detail-timeline', lang: 'ar', hash: `#/sessions/${silent}`, ready: '.timeline .tl' },
    { name: '03-stuck-session', lang: 'ar', hash: `#/sessions/${stuck}`, ready: '.timeline .tl' },
    { name: '04-undelivered-messages', lang: 'ar', hash: '#/messages', ready: '.bars li' },
    { name: '05-alerts', lang: 'ar', hash: '#/alerts', ready: '.change' },
    { name: '06-fleet-overview-en', lang: 'en', hash: '#/', ready: '.fleet-table tbody tr' },
  ];
  const cloudShots: typeof shots = [
    { name: '07-inbox', lang: 'ar', hash: '#/inbox/99971000003', ready: '.bubble' },
    { name: '08-delivery-gap', lang: 'ar', hash: '#/report', ready: '.stack' },
    { name: '09-inbox-template-only', lang: 'ar', hash: '#/inbox/99971000007', ready: '.tpl-preview' },
  ];

  const capture = async (shot: (typeof shots)[number]) => {
    const { browser, page } = await openPage();
    await page.goto(`${base}/?token=${token}&lang=${shot.lang}${shot.hash}`);
    await page.waitForSelector(shot.ready);
    // Wait until every font face is loaded and two frames have painted, so
    // glyph rasterisation cannot race the capture.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined)));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await page.waitForTimeout(600);
    const file = `${OUT}/${shot.name}.png`;
    await page.screenshot({ path: file });
    const size = statSync(file).size;
    console.log(`${shot.name}.png ${(size / 1024).toFixed(0)} KB${size > MAX_BYTES ? '  <-- over 300 KB' : ''}`);
    if (size > MAX_BYTES) process.exitCode = 1;
    await browser.close();
  };
  for (const shot of shots) await capture(shot);

  // Inbox: two live sends through the simulated Cloud API, then 75 simulated
  // seconds so receipts (or their absence) arrive by signed webhook.
  const send = (to: string, body: string) => rt.cloud!.send({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
  send('+999 7100 0003', 'تم تأكيد موعد التوصيل غداً.');
  send('+999 7100 0001', 'شكراً لتواصلك، الطلب في الطريق.');
  for (let t = 0; t < 75_000; t += 500) {
    rt.virtualClock!.advance(500);
    await rt.flush();
  }
  for (const shot of cloudShots) await capture(shot);

  const { browser, page } = await openPage();
  // Smoke checks on the real page: token stripped from the URL, keyboard
  // navigation to a session works.
  await page.goto(`${base}/?token=${token}&lang=ar#/`);
  await page.waitForSelector('.fleet-table tbody tr');
  if (new URL(page.url()).searchParams.has('token')) problems.push('token left in the address bar');
  await page.focus('.fleet-table .row-anchor');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.timeline');
  if (!page.url().includes('#/sessions/')) problems.push('keyboard navigation to a session failed');
  // Cloud API rows on the messages page link to the inbox, not to a session page.
  await page.goto(`${base}/?lang=ar#/messages`);
  await page.waitForSelector('.table tbody tr');
  const hrefs = await page.$$eval('.table tbody a.link', (as) => as.map((a) => a.getAttribute('href') ?? ''));
  if (hrefs.some((h) => h === '#/sessions/cloud')) problems.push('a Cloud API row links to a session page');
  // Closed window: the text option is disabled and the template form is shown.
  await page.goto(`${base}/?lang=en#/inbox/99971000007`);
  await page.waitForSelector('.tpl-preview');
  const textDisabled = await page.$eval('.composer-modes button', (b) => (b as HTMLButtonElement).disabled);
  if (!textDisabled) problems.push('text mode is available while the window is closed');
  if (problems.length) {
    console.error(`Page problems:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('page checks: no console errors, token stripped, keyboard navigation ok');
  }

  await browser.close();
  await app.close();
  await rt.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
