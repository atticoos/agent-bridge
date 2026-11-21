import { describe, expect, it } from 'vitest';
import { dedupeKey, findDuplicate, firesInLastHour, recordFire, rememberHandoff } from '../src/guard';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('guards', () => {
  it('counts fires in a rolling hour', async () => {
    const kv = memoryKv();
    const t = Date.UTC(2026, 10, 21, 10, 0, 0);
    await recordFire(kv, t);
    await recordFire(kv, t + 1000);
    expect(await firesInLastHour(kv, t + 2000)).toBe(2);
    // Half way through the next hour, about half the previous bucket still counts.
    expect(await firesInLastHour(kv, t + 90 * 60 * 1000)).toBe(1);
    expect(await firesInLastHour(kv, t + 3 * 3600 * 1000)).toBe(0);
  });

  it('remembers handoffs for duplicate suppression', async () => {
    const kv = memoryKv();
    const key = dedupeKey('relayrunner', 'abc');
    expect(await findDuplicate(kv, key)).toBeNull();
    await rememberHandoff(kv, key, { sessionUrl: 'u', sessionId: 's', handoffId: 'h', at: 'now' }, 600);
    expect((await findDuplicate(kv, key))?.sessionUrl).toBe('u');
  });
});
