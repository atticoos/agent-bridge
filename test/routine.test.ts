import { describe, expect, it, vi } from 'vitest';
import { fireRoutine, formatHandoff, RoutineFireError, FIRE_API_BASE } from '../src/routine';

const meta = { requestedBy: 'atticoos', requestedAt: '2026-11-21T00:00:00.000Z', handoffId: 'h1' };

describe('formatHandoff', () => {
  it('renders only the sections that were provided, in routine order', () => {
    const text = formatHandoff(
      {
        title: 'Prototype onboarding',
        objective: 'Build a clickable onboarding prototype.',
        mode: 'prototype',
        decisions: ['Use a checklist, not a wizard', '  '],
        constraints: [],
      },
      meta
    );
    expect(text).toContain('# ChatGPT handoff: Prototype onboarding');
    expect(text).toContain('## Objective\n\nBuild a clickable onboarding prototype.');
    expect(text).toContain('## Suggested execution mode\n\nInteractive prototyping');
    expect(text).toContain('## Decisions already reached\n\n- Use a checklist, not a wizard');
    expect(text).not.toContain('Constraints');
    expect(text).toContain('not approval');
    expect(text.indexOf('Objective')).toBeLessThan(text.indexOf('Decisions'));
  });
});

describe('fireRoutine', () => {
  it('posts text with the bearer token and returns the session', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' })
    );
    const out = await fireRoutine('trig_abc', 'sk-ant-oat01-secret-token-value', 'hello', fetchMock as any);
    expect(out).toEqual({ sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1' });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe(`${FIRE_API_BASE}/trig_abc/fire`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer sk-ant-oat01-secret-token-value');
    expect(init.headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({ text: 'hello' });
  });

  it('maps a 401 to a message that never contains the token', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token sk-ant-oat01-secret' } }, { status: 401 })
    );
    const err = await fireRoutine('trig_abc', 'sk-ant-oat01-secret-token-value', 'x', fetchMock as any).catch((e) => e);
    expect(err).toBeInstanceOf(RoutineFireError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('sk-ant');
  });

  it('refuses text over the API limit without calling the API', async () => {
    const fetchMock = vi.fn();
    await expect(fireRoutine('trig_abc', 'sk-ant-oat01-secret-token-value', 'x'.repeat(70000), fetchMock as any)).rejects.toThrow(/at most/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('token handling', () => {
  it('trims whitespace around the secret before sending it', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ claude_code_session_id: 's', claude_code_session_url: 'https://claude.ai/code/s' })
    );
    await fireRoutine('trig_abc', '  sk-ant-oat01-secretvalue1234\n', 'x', fetchMock as any);
    expect((fetchMock.mock.calls[0] as any)[1].headers.authorization).toBe('Bearer sk-ant-oat01-secretvalue1234');
  });

  it('refuses a secret that is not a routine token without calling the API', async () => {
    const fetchMock = vi.fn();
    const err = await fireRoutine('trig_abc', 'trig_013Zz', 'x', fetchMock as any).catch((e) => e);
    expect(err.message).toMatch(/sk-ant-oat01-/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats a token hint like the one claude.ai shows', async () => {
    const { tokenHint } = await import('../src/routine');
    expect(tokenHint('sk-ant-oat01-ClyYsTT7abcdefghijklmnop3gAA')).toBe('sk-ant-oat01-ClyYsTT7...3gAA');
  });
});
