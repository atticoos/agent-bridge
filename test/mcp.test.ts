import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp';
import type { Env } from '../src/env';

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

function makeEnv(overrides: Partial<Env> = {}) {
  return {
    BRIDGE_KV: memoryKv(),
    HANDOFF_TARGETS: '{"relayrunner":{"routine_id":"trig_013Zz","description":"RelayRunner"}}',
    ROUTINE_TOKEN_RELAYRUNNER: 'sk-ant-oat01-secret-token-value',
    ALLOWED_GITHUB_USER_IDS: '656630',
    ...overrides,
  } as unknown as Env & { BRIDGE_KV: { store: Map<string, string> } };
}

async function connect(env: Env) {
  const server = buildServer(env, { githubUserId: 656630, githubLogin: 'atticoos' }, {
    token: 't',
    audience: 'a',
    scope: ['handoff'],
    clientId: 'chatgpt',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

const handoff = { title: 'Investigate flaky test', objective: 'Find why the e2e suite flakes on CI.', mode: 'research' };

function text(result: any): string {
  return result.content.map((c: any) => c.text).join('\n');
}

afterEach(() => vi.unstubAllGlobals());

describe('MCP tools', () => {
  it('lists tools with ChatGPT-relevant annotations', async () => {
    const client = await connect(makeEnv());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_handoff_targets.annotations?.readOnlyHint).toBe(true);
    expect(byName.handoff_to_claude.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys((byName.handoff_to_claude.inputSchema as any).properties)).toContain('objective');
  });

  it('fires once, then suppresses an identical retry, and never leaks the token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).text).toContain('Find why the e2e suite flakes');
      return Response.json({ claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const client = await connect(env);

    const first = await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    expect(first.isError).toBeFalsy();
    expect(text(first)).toContain('https://claude.ai/code/session_1');

    const second = await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    expect(text(second)).toContain('already sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = [...env.BRIDGE_KV.store.values()].join('\n');
    expect(stored).not.toContain('sk-ant');
    expect(stored).not.toContain('Find why the e2e suite flakes'); // audit keeps metadata, not the payload
    expect([...env.BRIDGE_KV.store.keys()].filter((k) => k.startsWith('audit:'))).toHaveLength(2);
  });

  it('enforces the hourly cap', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ claude_code_session_id: 's', claude_code_session_url: 'https://claude.ai/code/s' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(makeEnv({ MAX_FIRES_PER_HOUR: '1' }));
    await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    const blocked = await client.callTool({ name: 'handoff_to_claude', arguments: { ...handoff, title: 'Another task' } });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toMatch(/limit reached/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown targets and missing tokens without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(makeEnv({ ROUTINE_TOKEN_RELAYRUNNER: undefined }));
    expect(text(await client.callTool({ name: 'handoff_to_claude', arguments: { ...handoff, target: 'nope' } }))).toMatch(/Unknown/);
    expect(text(await client.callTool({ name: 'handoff_to_claude', arguments: handoff }))).toMatch(/no routine token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pickup delivery (workaround for anthropics/claude-code#102874)', () => {
  const paused = () =>
    Response.json(
      { type: 'error', error: { type: 'permission_error', message: 'this project is paused' } },
      { status: 403 }
    );
  const ok = () =>
    Response.json({ claude_code_session_id: 'session_01AbCdEfGhIjKlMnOp', claude_code_session_url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOp' });

  it('falls back to an empty-body fire and stores the text for the session to pick up', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return 'text' in body ? paused() : ok();
    }));
    const env = makeEnv();
    const client = await connect(env);
    const res = await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    expect(res.isError).toBeFalsy();
    expect(bodies).toEqual([expect.objectContaining({ text: expect.any(String) }), {}]);
    const stored = env.BRIDGE_KV.store.get('pickup:01AbCdEfGhIjKlMnOp');
    expect(stored).toContain('Find why the e2e suite flakes');

    // The session fetches it with its own id, which carries the cse_ prefix inside the session.
    const { defaultHandler } = await import('../src/auth');
    const got = await defaultHandler.fetch(new Request('https://bridge.example/handoff/cse_01AbCdEfGhIjKlMnOp'), env as any);
    expect(got.status).toBe(200);
    expect(await got.text()).toContain('Find why the e2e suite flakes');
    const missing = await defaultHandler.fetch(new Request('https://bridge.example/handoff/cse_01Nope0000000000'), env as any);
    expect(missing.status).toBe(404);
  });

  it('does not fall back on other 403s', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ type: 'error', error: { type: 'permission_error', message: 'no access' } }, { status: 403 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(makeEnv());
    const res = await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fires once with an empty body when the target is set to pickup', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv({ HANDOFF_TARGETS: '{"relayrunner":{"routine_id":"trig_013Zz","delivery":"pickup"}}' });
    const client = await connect(env);
    await client.callTool({ name: 'handoff_to_claude', arguments: handoff });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body))).toEqual({});
    expect(env.BRIDGE_KV.store.has('pickup:01AbCdEfGhIjKlMnOp')).toBe(true);
  });
});
