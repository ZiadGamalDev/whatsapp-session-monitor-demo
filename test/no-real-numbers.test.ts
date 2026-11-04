import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guard: every phone-like value in the repository must be in the unassigned
 * +999 range. Catches real-looking numbers sneaking into tests, fixtures,
 * docs or seed data.
 */
const TEXT = /\.(ts|vue|js|json|md|txt|http|yml|yaml|html|css|example)$|^\.env\.example$|Dockerfile$/;
const SKIP = new Set(['package-lock.json']);

// International format: "+" then 8+ digits, optionally separated.
const INTERNATIONAL = /\+\s?\d[\d\s().-]{6,}\d/g;
// Local mobile formats starting with 0 (e.g. 01X XXXX XXXX, 05X XXX XXXX).
const LOCAL = /(?<![\w.:#-])0\d{2,4}[\s-]?\d{3}[\s-]?\d{3,4}(?![\w.-])/g;

function files(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !SKIP.has(f) && TEXT.test(f));
}

export function findPhoneLike(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(INTERNATIONAL)) {
    const digits = m[0].replace(/\D/g, '');
    if (!digits.startsWith('999')) hits.push(m[0]);
  }
  for (const m of text.matchAll(LOCAL)) hits.push(m[0]);
  return hits;
}

describe('no real-looking phone numbers in the repo', () => {
  it('detects international and local formats but allows +999', () => {
    // Vectors are assembled at runtime so this file passes its own scan.
    // UK 07700 900xxx is a range reserved for fiction.
    const intl = ['+44', '7700', '900123'].join(' ');
    const local = ['07700', '900', '123'].join(' ');
    const arithmetic = ['a +', '1767258000'].join(' ');
    expect(findPhoneLike(`call ${intl} now`)).toHaveLength(1);
    expect(findPhoneLike(intl.replace(/ /g, ''))).toHaveLength(1);
    expect(findPhoneLike(`local ${local}`)).toHaveLength(1);
    expect(findPhoneLike(arithmetic)).toHaveLength(1);
    expect(findPhoneLike('+999 7100 0001 and +999 0000 0040')).toEqual([]);
    expect(findPhoneLike('2026-01-05 10:30 #A1001 wamid.SIM.CLOUD.000001')).toEqual([]);
  });

  it('every tracked text file passes', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      for (const hit of findPhoneLike(readFileSync(f, 'utf8'))) offenders.push(`${f}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
