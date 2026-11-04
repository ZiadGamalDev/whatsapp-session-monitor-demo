import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerExtensions } from '../src/extensions.js';
import { buildApp } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

describe('docs/api.http', () => {
  it('has a request for every route the app registers', async () => {
    const rt = await testRuntime({ virtualTimeMs: 0, syntheticTraffic: false, demoAlertSink: true });
    const routes: string[] = [];
    const app = await buildApp(rt, {
      register: (a) => registerExtensions(a, rt),
      onRoute: (method, url) => {
        if (method !== 'HEAD') routes.push(`${method} ${url}`);
      },
    });
    await app.ready();
    await app.close();
    await rt.stop();
    const doc = readFileSync(new URL('../docs/api.http', import.meta.url), 'utf8');
    const documented = new Set(
      [...doc.matchAll(/^(GET|POST|PUT|PATCH|DELETE) \{\{base\}\}([^?\s]*)/gm)].map(
        (m) => `${m[1]} ${m[2]!.replace('{{session}}', ':id').replace('{{waId}}', ':waId')}`,
      ),
    );
    const api = routes.filter((r) => r.includes('/api/') || r.includes('/webhooks/') || r.includes('/demo/'));
    expect(api.length).toBeGreaterThan(15);
    const missing = api.filter((r) => !documented.has(r));
    expect(missing).toEqual([]);
  });
});
