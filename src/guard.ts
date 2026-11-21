/**
 * Abuse and accident controls around firing a routine:
 * - a rolling hourly cap, under the routine's own limit,
 * - duplicate suppression (the fire API has no idempotency, so a retried tool call would start a second session),
 * - an audit log of every handoff attempt.
 *
 * KV is eventually consistent, so these are best-effort guards for a single-user server, not hard guarantees.
 */

const HOUR = 3600;
const AUDIT_TTL = 90 * 24 * HOUR;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hourBucket(now: number): number {
  return Math.floor(now / 1000 / HOUR);
}

/** Fires counted in the current and previous hour bucket, weighted for a rolling window. */
export async function firesInLastHour(kv: KVNamespace, now = Date.now()): Promise<number> {
  const bucket = hourBucket(now);
  const [cur, prev] = await Promise.all([kv.get(`rate:${bucket}`), kv.get(`rate:${bucket - 1}`)]);
  const elapsed = (now / 1000 / HOUR) % 1;
  return Number(cur ?? 0) + Math.ceil(Number(prev ?? 0) * (1 - elapsed));
}

export async function recordFire(kv: KVNamespace, now = Date.now()): Promise<void> {
  const key = `rate:${hourBucket(now)}`;
  const cur = Number((await kv.get(key)) ?? 0);
  await kv.put(key, String(cur + 1), { expirationTtl: 3 * HOUR });
}

export interface DedupeRecord {
  sessionUrl: string;
  sessionId: string;
  handoffId: string;
  at: string;
}

export function dedupeKey(target: string, contentHash: string): string {
  return `dedupe:${target}:${contentHash}`;
}

export async function findDuplicate(kv: KVNamespace, key: string): Promise<DedupeRecord | null> {
  return kv.get<DedupeRecord>(key, 'json');
}

export async function rememberHandoff(kv: KVNamespace, key: string, record: DedupeRecord, windowSeconds: number) {
  // KV's minimum TTL is 60 seconds.
  await kv.put(key, JSON.stringify(record), { expirationTtl: Math.max(60, windowSeconds) });
}

export interface AuditEntry {
  at: string;
  handoffId: string;
  githubLogin: string;
  githubUserId: number;
  clientId?: string;
  target: string;
  title: string;
  contentSha256: string;
  textLength: number;
  outcome: 'fired' | 'duplicate' | 'rate_limited' | 'error';
  sessionUrl?: string;
  error?: string;
}

/** Stores metadata only, never the payload text or any token. */
export async function audit(kv: KVNamespace, entry: AuditEntry): Promise<void> {
  console.log(JSON.stringify({ event: 'handoff', ...entry }));
  // Reverse-chronological keys so `wrangler kv key list --prefix audit:` shows newest first.
  const reverse = String(9_999_999_999_999 - Date.parse(entry.at)).padStart(13, '0');
  await kv.put(`audit:${reverse}:${entry.handoffId}`, JSON.stringify(entry), { expirationTtl: AUDIT_TTL });
}
