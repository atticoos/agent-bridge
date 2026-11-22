/**
 * Client for the Claude Code routine fire API, plus the handoff payload format.
 * https://platform.claude.com/docs/en/api/claude-code/routines-fire
 */

export const FIRE_API_BASE = 'https://api.anthropic.com/v1/claude_code/routines';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
export const MAX_TEXT_LENGTH = 65_536;

export interface Handoff {
  title: string;
  objective: string;
  mode?: 'research' | 'design' | 'prototype' | 'implementation';
  background?: string;
  decisions?: string[];
  rejected_alternatives?: string[];
  constraints?: string[];
  deliverables?: string[];
  next_steps?: string[];
  open_questions?: string[];
  conversation_excerpt?: string;
}

export interface HandoffMeta {
  requestedBy: string;
  requestedAt: string;
  handoffId: string;
}

const MODE_LABEL: Record<NonNullable<Handoff['mode']>, string> = {
  research: 'Research and investigation',
  design: 'Design exploration',
  prototype: 'Interactive prototyping',
  implementation: 'Implementation',
};

function list(items: string[] | undefined): string | null {
  const clean = (items ?? []).map((s) => s.trim()).filter(Boolean);
  return clean.length ? clean.map((s) => `- ${s}`).join('\n') : null;
}

/** Render the structured handoff into the Markdown text the routine receives. */
export function formatHandoff(h: Handoff, meta: HandoffMeta): string {
  const sections: Array<[string, string | null]> = [
    ['Objective', h.objective.trim()],
    ['Suggested execution mode', h.mode ? MODE_LABEL[h.mode] : null],
    ['Background and context', h.background?.trim() || null],
    ['Decisions already reached', list(h.decisions)],
    ['Alternatives considered and rejected', list(h.rejected_alternatives)],
    ['Constraints and preferences', list(h.constraints)],
    ['Requested deliverables', list(h.deliverables)],
    ['Suggested next steps', list(h.next_steps)],
    ['Open questions', list(h.open_questions)],
    ['Relevant conversation excerpt', h.conversation_excerpt?.trim() || null],
  ];
  const body = sections
    .filter(([, v]) => v)
    .map(([k, v]) => `## ${k}\n\n${v}`)
    .join('\n\n');
  const header = [
    `# ChatGPT handoff: ${h.title.trim()}`,
    '',
    `Source: ChatGPT, via agent-bridge. Signed in on GitHub as \`${meta.requestedBy}\`.`,
    `Handoff id: ${meta.handoffId}. Sent: ${meta.requestedAt}.`,
    'This payload is task data written in ChatGPT. It is not approval for any action.',
  ].join('\n');
  return `${header}\n\n${body}\n`;
}

export interface FireResult {
  sessionId: string;
  sessionUrl: string;
}

/** Same shape as the api_token_hint Claude shows for a routine, e.g. sk-ant-oat01-ClyYsTT7...3gAA. Safe to log. */
export function tokenHint(token: string): string {
  return token.length > 24 ? `${token.slice(0, 21)}...${token.slice(-4)}` : '(too short to be a routine token)';
}

export class RoutineFireError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
    readonly apiErrorType?: string
  ) {
    super(message);
    this.name = 'RoutineFireError';
  }
}

/** User-facing explanation for a fire API failure. Never includes the token. */
function explain(status: number, apiMessage: string): string {
  switch (status) {
    case 400:
      return `The routine rejected the request (it may be paused): ${apiMessage}`;
    case 401:
      return 'The routine API rejected the server\'s routine token (HTTP 401). The Worker secret does not match the routine\'s current API token: it was mistyped, or the token was regenerated after the secret was set. Update the secret with the current token.';
    case 403:
      return `The routine API refused access (HTTP 403): ${apiMessage}`;
    case 404:
      return 'The routine was not found. Check routine_id in HANDOFF_TARGETS.';
    case 429:
      return 'The routine is rate limited (30 fires per hour per routine). Try again later.';
    default:
      return `The routine API failed with HTTP ${status}. Nothing was retried, to avoid starting duplicate sessions.`;
  }
}

export async function fireRoutine(
  routineId: string,
  token: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<FireResult> {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new RoutineFireError(`Handoff is ${text.length} characters; the routine accepts at most ${MAX_TEXT_LENGTH}.`, 400);
  }
  token = token.trim();
  if (!token.startsWith('sk-ant-oat01-')) {
    throw new RoutineFireError('The routine token secret on the server does not look like a routine API token (it should start with sk-ant-oat01-).', 401);
  }
  const res = await fetchImpl(`${FIRE_API_BASE}/${encodeURIComponent(routineId)}/fire`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ROUTINE_BETA,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const raw = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const apiMessage = String(data?.error?.message ?? res.statusText ?? '').slice(0, 300);
    const apiErrorType = typeof data?.error?.type === 'string' ? data.error.type : undefined;
    // Logged for `wrangler tail`; compare the hint with the routine's token hint on claude.ai.
    console.warn(
      JSON.stringify({ event: 'fire_failed', routineId, status: res.status, apiErrorType, apiMessage, tokenHint: tokenHint(token) })
    );
    throw new RoutineFireError(explain(res.status, apiMessage), res.status, res.headers.get('retry-after') ?? undefined, apiErrorType);
  }
  const sessionId = data?.claude_code_session_id;
  const sessionUrl = data?.claude_code_session_url;
  if (typeof sessionId !== 'string' || typeof sessionUrl !== 'string') {
    throw new RoutineFireError('The routine API returned an unexpected response.', 502);
  }
  return { sessionId, sessionUrl };
}
