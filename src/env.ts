import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  /** KV used by the OAuth provider (grants, clients, tokens; hashed/encrypted at rest). */
  OAUTH_KV: KVNamespace;
  /** KV used by agent-bridge for rate limiting, duplicate suppression and the audit log. */
  BRIDGE_KV: KVNamespace;
  /** Injected by OAuthProvider for the default (non-API) handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  /** Public origin of this Worker, e.g. https://agent-bridge.example.workers.dev (no trailing slash). */
  PUBLIC_ORIGIN: string;

  /** GitHub OAuth App used only to identify who is signing in. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Comma-separated numeric GitHub user ids allowed to sign in. Ids, not logins: logins can be renamed. */
  ALLOWED_GITHUB_USER_IDS: string;

  /**
   * JSON object describing the routines ChatGPT may fire, keyed by a short target name:
   * {"relayrunner": {"routine_id": "trig_...", "description": "RelayRunner project"}}
   * Each target's token is read from the secret ROUTINE_TOKEN_<NAME> (upper-cased, non-alphanumerics -> _).
   */
  HANDOFF_TARGETS: string;

  /** Max fires per rolling hour across all targets (default 20; the routine itself caps at 30). */
  MAX_FIRES_PER_HOUR?: string;
  /** Seconds during which an identical handoff is answered with the earlier session instead of firing again (default 600). */
  DEDUPE_WINDOW_SECONDS?: string;

  /** Routine tokens, one per target: ROUTINE_TOKEN_RELAYRUNNER etc. */
  [key: `ROUTINE_TOKEN_${string}`]: string | undefined;
}

/** What completeAuthorization() stores in the grant; handlers see it as ctx.props. */
export interface AuthProps {
  githubUserId: number;
  githubLogin: string;
}

export interface HandoffTarget {
  name: string;
  routineId: string;
  description: string;
}

export function parseTargets(raw: string | undefined): HandoffTarget[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HANDOFF_TARGETS is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HANDOFF_TARGETS must be a JSON object keyed by target name');
  }
  return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => {
    const v = (value ?? {}) as Record<string, unknown>;
    const routineId = String(v.routine_id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
      throw new Error(`HANDOFF_TARGETS: invalid target name "${name}" (lowercase letters, digits, - and _)`);
    }
    if (!/^trig_[A-Za-z0-9]+$/.test(routineId)) {
      throw new Error(`HANDOFF_TARGETS: target "${name}" needs a routine_id starting with trig_`);
    }
    return { name, routineId, description: String(v.description ?? '') };
  });
}

export function tokenSecretName(targetName: string): `ROUTINE_TOKEN_${string}` {
  return `ROUTINE_TOKEN_${targetName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function allowedUserIds(env: Pick<Env, 'ALLOWED_GITHUB_USER_IDS'>): Set<number> {
  return new Set(
    (env.ALLOWED_GITHUB_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0)
  );
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
