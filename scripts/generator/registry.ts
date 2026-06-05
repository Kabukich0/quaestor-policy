// Helpers to deterministically pick vendors from @quaestor/vendor-registry
// for the case generator. Seeded RNG so each run is reproducible.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VendorPick } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..', '..');
const VENDORS_PATH = path.resolve(REPO, 'node_modules', '@quaestor', 'vendor-registry', 'data', 'vendors.json');

interface RegistryRecord {
  domain: string;
  name: string;
  categories: string[];
  canonical_for: string[];
  subdomains?: Record<string, { name: string; categories: string[]; canonical_for: string[] }>;
  aliases?: string[];
  source: string;
}

const registry: RegistryRecord[] = JSON.parse(readFileSync(VENDORS_PATH, 'utf8'));

const allTopLevel: VendorPick[] = registry.map((r) => ({
  domain: r.domain,
  name: r.name,
  categories: [...r.categories],
  canonical_for: [...r.canonical_for],
}));

const allSubdomains: VendorPick[] = [];
for (const r of registry) {
  if (!r.subdomains) continue;
  for (const [sub, rec] of Object.entries(r.subdomains)) {
    allSubdomains.push({
      domain: sub,
      name: rec.name,
      categories: [...rec.categories],
      canonical_for: [...rec.canonical_for],
      fallback_parent: r.domain,
    });
  }
}

const allCategories = new Set<string>();
for (const v of allTopLevel) for (const c of v.categories) allCategories.add(c);

export const ALL_CATEGORIES = [...allCategories].sort();
export const REGISTRY_SIZE = allTopLevel.length;

// xorshift32 — fast deterministic RNG
let _state = 0xdeadbeef;
export function seedRng(seed: number): void { _state = seed >>> 0 || 1; }
export function rand(): number {
  let x = _state;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;  x >>>= 0;
  _state = x;
  return (x >>> 0) / 4294967295;
}
export function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
export function pickOne<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error('pickOne on empty array');
  return arr[Math.floor(rand() * arr.length)] as T;
}
export function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < Math.min(n, copy.length); i += 1) {
    const idx = Math.floor(rand() * copy.length);
    out.push(copy[idx] as T);
    copy.splice(idx, 1);
  }
  return out;
}

export function pickVendorByCategories(required: string[]): VendorPick {
  const matches = allTopLevel.filter((v) => required.some((c) => v.categories.includes(c)));
  if (matches.length === 0) throw new Error(`no vendor for categories ${required.join(',')}`);
  return pickOne(matches);
}

export function pickVendorWithSubdomain(): VendorPick {
  const sub = pickOne(allSubdomains);
  return sub;
}

export function pickVendorAvoidingCategories(forbidden: string[]): VendorPick {
  const matches = allTopLevel.filter(
    (v) => !v.categories.some((c) => forbidden.includes(c)),
  );
  return pickOne(matches);
}

export function pickAnyVendor(): VendorPick {
  return pickOne(allTopLevel);
}

export function findParentSubdomainPair(): { parent: VendorPick; child: VendorPick } {
  // Find a (top-level, subdomain) pair where the subdomain has at least one
  // category not in the parent — useful for subdomain_child / subdomain_parent.
  const candidates = allSubdomains.filter((s) => {
    const parent = allTopLevel.find((p) => p.domain === s.fallback_parent);
    if (!parent) return false;
    return s.categories.some((c) => !parent.categories.includes(c));
  });
  const child = pickOne(candidates);
  const parent = allTopLevel.find((p) => p.domain === child.fallback_parent);
  if (!parent) throw new Error(`no parent for ${child.domain}`);
  return { parent, child };
}

// Phishy domain templates for unknown_vendor_phishing. Synthetic.
const PHISH_PATTERNS = [
  'free-iphone-prize-{n}.xyz',
  'casino-online-bet-{n}.tk',
  '{vendor}-verify-payment-{n}.net',
  '{vendor}-login-portal-{n}.org',
  '{vendor}-credentials-update-{n}.io',
  'win-{n}-now.click',
  'crypto-airdrop-{n}.fun',
  'urgent-payment-{n}.shop',
];
export function genPhishingDomain(): { domain: string } {
  const pattern = pickOne(PHISH_PATTERNS);
  const vendor = pickOne(['stripe', 'okta', 'aws', 'paypal', 'github']);
  const n = randInt(1, 9999);
  return { domain: pattern.replace('{vendor}', vendor).replace('{n}', String(n)) };
}

// Clean novel domains for unknown_vendor_legitimate_novel. Synthetic.
const NOVEL_TLDS = ['.io', '.dev', '.app', '.co', '.tech', '.cloud', '.tools'];
const NOVEL_STEMS = [
  'pixelship', 'cloudgrove', 'morpho', 'orbital', 'altpath', 'metabase', 'forgehub',
  'sparklane', 'stratospec', 'narrative', 'beacon-stack', 'helix-data', 'plumb',
  'codereef', 'zedwork', 'mindstack', 'vortex-ops', 'cipher-ground',
];
export function genNovelDomain(): { domain: string; description_hint: string } {
  const tld = pickOne(NOVEL_TLDS);
  const stem = pickOne(NOVEL_STEMS);
  const n = randInt(1, 99);
  return {
    domain: `${stem}-${n}${tld}`,
    description_hint: pickOne([
      'managed inference compute',
      'developer monitoring tooling',
      'cloud cost analytics',
      'feature flag service',
      'data pipeline orchestration',
      'observability platform',
    ]),
  };
}
