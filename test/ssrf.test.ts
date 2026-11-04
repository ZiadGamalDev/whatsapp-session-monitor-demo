import { describe, expect, it, vi } from 'vitest';
import { assertPublicTarget, isPrivateAddress } from '../src/alerts/ssrf.js';
import { WebhookSender } from '../src/alerts/webhook.js';
import { loadConfig, validateConfig } from '../src/config.js';

describe('isPrivateAddress', () => {
  it('blocks loopback, private, link-local, metadata, CGNAT, multicast and reserved ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '198.51.100.7',
      '::1',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:7f00:0001',
      '0:0:0:0:0:ffff:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '::ffff:192.168.1.10',
      '::ffff:c0a8:10a',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '0064:ff9b::10.0.0.1',
      'not-an-ip',
      '',
      '::ffff:999.999.999.999',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses including mapped public IPv4', () => {
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:1.1.1.1',
      '::ffff:101:101',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '0:0:0:0:0:ffff:8.8.8.8',
      '0:0:0:0:0:ffff:808:808',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicTarget', () => {
  const lookup = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];

  it('resolves the host and refuses if ANY address is private (including canonicalized URL and DNS hex/expanded forms)', async () => {
    await expect(assertPublicTarget('https://hooks.example.test/x', { allowPrivate: false, lookup: lookup({ 'hooks.example.test': ['1.1.1.1'] }) })).resolves.toBeUndefined();
    await expect(
      assertPublicTarget('https://hooks-v6.example.test/x', { allowPrivate: false, lookup: lookup({ 'hooks-v6.example.test': ['::ffff:8.8.8.8'] }) }),
    ).resolves.toBeUndefined();
    await expect(assertPublicTarget('http://[::ffff:8.8.8.8]:8080/x', { allowPrivate: false })).resolves.toBeUndefined();
    await expect(
      assertPublicTarget('https://rebind.example.test/x', { allowPrivate: false, lookup: lookup({ 'rebind.example.test': ['1.1.1.1', '10.0.0.5'] }) }),
    ).rejects.toThrow(/private/);
    await expect(
      assertPublicTarget('https://mapped-dns.example.test/x', { allowPrivate: false, lookup: lookup({ 'mapped-dns.example.test': ['::ffff:7f00:1'] }) }),
    ).rejects.toThrow(/private/);
    await expect(
      assertPublicTarget('https://expanded-dns.example.test/x', { allowPrivate: false, lookup: lookup({ 'expanded-dns.example.test': ['0:0:0:0:0:0:0:1'] }) }),
    ).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://169.254.169.254/latest/meta-data', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://[::1]:3000/', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://[0:0:0:0:0:0:0:1]:3000/', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://[::ffff:127.0.0.1]:3000/', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://[::ffff:7f00:1]:3000/', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('http://[::ffff:169.254.169.254]/latest/meta-data', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(assertPublicTarget('https://nowhere.example.test/', { allowPrivate: false, lookup: lookup({}) })).rejects.toThrow(/did not resolve/);
  });

  it('can be explicitly allowed by the operator', async () => {
    await expect(assertPublicTarget('http://127.0.0.1:9/x', { allowPrivate: true })).resolves.toBeUndefined();
    await expect(assertPublicTarget('http://[::ffff:127.0.0.1]:9/x', { allowPrivate: true })).resolves.toBeUndefined();
  });
});

describe('alert sender with the guard', () => {
  it('refuses a private target without sending anything and without retrying', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const s = new WebhookSender({
      url: 'http://10.0.0.5/hook',
      secret: 'k',
      fetchImpl,
      guard: (u) => assertPublicTarget(u, { allowPrivate: false }),
    });
    const res = await s.deliver('alert-1', {});
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.lastError).toMatch(/^blocked/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('config', () => {
  it('fails fast on a literal private webhook address unless allowed', () => {
    const base = { ALERT_WEBHOOK_SECRET: 'long-secret' };
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://127.0.0.1:9000/x' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://localhost:9000/x' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://169.254.169.254/' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://[::ffff:127.0.0.1]:9000/x' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://[::ffff:7f00:1]:9000/x' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://[0:0:0:0:0:0:0:1]:9000/x' }))).toThrow(/private/);
    expect(() => validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://[::ffff:8.8.8.8]:9000/x' }))).not.toThrow();
    expect(() =>
      validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://127.0.0.1:9000/x', ALERT_WEBHOOK_ALLOW_PRIVATE: 'true' })),
    ).not.toThrow();
    expect(() =>
      validateConfig(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'http://[::ffff:127.0.0.1]:9000/x', ALERT_WEBHOOK_ALLOW_PRIVATE: 'true' })),
    ).not.toThrow();
    // The built-in demo sink is not an operator URL and needs no allowance.
    expect(() => validateConfig(loadConfig({ DEMO_ALERT_SINK: 'true' }))).not.toThrow();
  });
});
