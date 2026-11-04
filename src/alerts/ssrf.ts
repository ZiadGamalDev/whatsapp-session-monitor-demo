import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound alert webhooks are operator-configured (ALERT_WEBHOOK_URL), never
 * taken from API input. Still, a monitor usually runs next to things that
 * must not receive requests from it, so the target host is resolved before
 * each delivery and refused when any address is loopback, private,
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast or
 * reserved, unless ALERT_WEBHOOK_ALLOW_PRIVATE=true.
 *
 * Known limit: resolution and connection are separate steps, so a hostile
 * DNS server could answer differently the second time (rebinding). Pinning
 * the resolved address would need a custom HTTP agent; out of scope here.
 */

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4ToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

function v4BlockedInt(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function v4Blocked(ip: string): boolean {
  return v4BlockedInt(v4ToInt(ip));
}

/**
 * Parses an IPv6 literal (compressed, expanded, or with a trailing IPv4
 * dotted-quad) into 8 16-bit words. Returns null on any malformed input.
 */
function parseIPv6(raw: string): number[] | null {
  if (!raw || raw.includes('%')) return null;
  let addr = raw.toLowerCase();

  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4Part = addr.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return null;
    const v4Int = v4ToInt(v4Part);
    const hi = (v4Int >>> 16) & 0xffff;
    const lo = v4Int & 0xffff;
    addr = `${addr.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const parts = addr.split('::');
  if (parts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const t of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(t)) return null;
      out.push(parseInt(t, 16));
    }
    return out;
  };

  if (parts.length === 1) {
    const words = parseSide(parts[0]!);
    return words && words.length === 8 ? words : null;
  }

  const left = parseSide(parts[0]!);
  const right = parseSide(parts[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true; // not an address: refuse
  const words = parseIPv6(ip);
  if (!words) return true; // fail closed on unparseable input

  const isZeroPrefix = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0;
  if (isZeroPrefix && words[5] === 0xffff) {
    const mappedV4 = ((words[6]! << 16) | words[7]!) >>> 0;
    return v4BlockedInt(mappedV4);
  }
  if (isZeroPrefix && words[5] === 0) {
    // Covers ::/128 (unspecified), ::1/128 (loopback) in any compressed or
    // expanded spelling, and deprecated ::/96 IPv4-compatible addresses.
    return true;
  }

  const first = words[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0064 && words[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 can reach IPv4 private space
  return false;
}

export type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export async function assertPublicTarget(url: string, opts: { allowPrivate: boolean; lookup?: Lookup }): Promise<void> {
  if (opts.allowPrivate) return;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`blocked: ${u.protocol} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new Error(`blocked: ${host} did not resolve`);
  const bad = addresses.filter(isPrivateAddress);
  if (bad.length) {
    throw new Error(`blocked: ${host} resolves to a private/reserved address (${bad.join(', ')}); set ALERT_WEBHOOK_ALLOW_PRIVATE=true to allow`);
  }
}
