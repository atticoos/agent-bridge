import { describe, expect, it } from 'vitest';
import { allowedUserIds, parseTargets, tokenSecretName } from '../src/env';

describe('config', () => {
  it('parses targets and validates routine ids', () => {
    expect(parseTargets('{"relayrunner":{"routine_id":"trig_013Zz","description":"RR"}}')).toEqual([
      { name: 'relayrunner', routineId: 'trig_013Zz', description: 'RR', delivery: 'auto' },
    ]);
    expect(() => parseTargets('{"x":{"routine_id":"nope"}}')).toThrow(/trig_/);
    expect(() => parseTargets('{"Bad Name":{"routine_id":"trig_1"}}')).toThrow(/invalid target name/);
    expect(parseTargets(undefined)).toEqual([]);
    expect(parseTargets('{"x":{"routine_id":"trig_1","delivery":"pickup"}}')[0].delivery).toBe('pickup');
    expect(() => parseTargets('{"x":{"routine_id":"trig_1","delivery":"email"}}')).toThrow(/delivery/);
  });

  it('derives token secret names', () => {
    expect(tokenSecretName('relay-runner')).toBe('ROUTINE_TOKEN_RELAY_RUNNER');
  });

  it('parses the GitHub id allowlist strictly', () => {
    expect([...allowedUserIds({ ALLOWED_GITHUB_USER_IDS: '656630, 12 ,abc,,-1' })]).toEqual([656630, 12]);
    expect(allowedUserIds({ ALLOWED_GITHUB_USER_IDS: '' }).size).toBe(0);
  });
});
