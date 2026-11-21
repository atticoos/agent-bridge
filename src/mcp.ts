import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { allowedUserIds, intVar, parseTargets, tokenSecretName, type AuthProps, type Env } from './env';
import { formatHandoff, fireRoutine, RoutineFireError, MAX_TEXT_LENGTH, type Handoff } from './routine';
import { audit, dedupeKey, findDuplicate, firesInLastHour, recordFire, rememberHandoff, sha256Hex } from './guard';

export const HANDOFF_SCOPE = 'handoff';

const stringList = (what: string) =>
  z.array(z.string().max(2000)).max(30).optional().describe(what);

const handoffInput = {
  target: z
    .string()
    .optional()
    .describe('Which Claude project to hand off to. Call list_handoff_targets for names. Optional when only one target exists.'),
  title: z.string().min(3).max(120).describe('Short name for the task, e.g. "Prototype the onboarding checklist".'),
  objective: z.string().min(10).max(4000).describe('What Claude should accomplish and the desired outcome.'),
  mode: z
    .enum(['research', 'design', 'prototype', 'implementation'])
    .optional()
    .describe('Suggested execution mode. Implementation still requires plan approval in Claude.'),
  background: z.string().max(20000).optional().describe('Product and technical context from the conversation.'),
  decisions: stringList('Decisions already reached that Claude should not reopen.'),
  rejected_alternatives: stringList('Alternatives considered and rejected, each with the reason.'),
  constraints: stringList('Constraints and preferences.'),
  deliverables: stringList('Concrete deliverables requested.'),
  next_steps: stringList('Suggested next steps.'),
  open_questions: stringList('Questions that remain open.'),
  conversation_excerpt: z
    .string()
    .max(30000)
    .optional()
    .describe('Optional verbatim excerpt of the key part of the conversation.'),
};

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function buildServer(env: Env, props: AuthProps, auth: OAuthResourceAuth) {
  const server = new McpServer(
    { name: 'agent-bridge', version: '0.1.0' },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        'Use handoff_to_claude when the user asks to delegate, hand off or send a task to Claude. ' +
        'Summarize the conversation faithfully into the structured fields: objective, background, decisions, ' +
        'rejected alternatives, constraints, deliverables and next steps. Never include secrets, passwords or tokens.',
    }
  );

  server.registerTool(
    'list_handoff_targets',
    {
      title: 'List Claude handoff targets',
      description: 'Lists the Claude projects this connector can hand tasks off to.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const targets = parseTargets(env.HANDOFF_TARGETS);
      if (!targets.length) return textResult('No handoff targets are configured on the server.', true);
      return textResult(
        targets
          .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}${env[tokenSecretName(t.name)] ? '' : ' (not ready: token secret missing)'}`)
          .join('\n')
      );
    }
  );

  server.registerTool(
    'handoff_to_claude',
    {
      title: 'Hand off a task to Claude',
      description:
        'Starts a new Claude Code session in a Claude project with a structured handoff of this conversation. ' +
        'Returns a link to the new session. The user continues the work there; nothing is sent back to ChatGPT.',
      inputSchema: handoffInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const targets = parseTargets(env.HANDOFF_TARGETS);
      const target = args.target
        ? targets.find((t) => t.name === args.target)
        : targets.length === 1
          ? targets[0]
          : undefined;
      if (!target) {
        return textResult(
          targets.length
            ? `Unknown or missing target. Available targets: ${targets.map((t) => t.name).join(', ')}.`
            : 'No handoff targets are configured on the server.',
          true
        );
      }
      const token = env[tokenSecretName(target.name)];
      if (!token) {
        return textResult(`Target "${target.name}" has no routine token configured on the server (secret ${tokenSecretName(target.name)}).`, true);
      }

      const handoff: Handoff = { ...args };
      const now = new Date();
      const handoffId = crypto.randomUUID();
      // Hash the content without per-call metadata, so a retried call with the same content is caught.
      const contentText = formatHandoff(handoff, { requestedBy: props.githubLogin, requestedAt: '-', handoffId: '-' });
      const contentSha256 = await sha256Hex(contentText);
      const text = formatHandoff(handoff, { requestedBy: props.githubLogin, requestedAt: now.toISOString(), handoffId });
      const base = {
        at: now.toISOString(),
        handoffId,
        githubLogin: props.githubLogin,
        githubUserId: props.githubUserId,
        clientId: auth.clientId,
        target: target.name,
        title: args.title,
        contentSha256,
        textLength: text.length,
      };

      if (text.length > MAX_TEXT_LENGTH) {
        await audit(env.BRIDGE_KV, { ...base, outcome: 'error', error: 'too_long' });
        return textResult(`The handoff is ${text.length} characters; the limit is ${MAX_TEXT_LENGTH}. Shorten the background or excerpt.`, true);
      }

      const key = dedupeKey(target.name, contentSha256);
      const dup = await findDuplicate(env.BRIDGE_KV, key);
      if (dup) {
        await audit(env.BRIDGE_KV, { ...base, outcome: 'duplicate', sessionUrl: dup.sessionUrl });
        return textResult(
          `This exact handoff was already sent at ${dup.at}, so no new session was started. Claude session: ${dup.sessionUrl}`
        );
      }

      const limit = intVar(env.MAX_FIRES_PER_HOUR, 20);
      if ((await firesInLastHour(env.BRIDGE_KV)) >= limit) {
        await audit(env.BRIDGE_KV, { ...base, outcome: 'rate_limited' });
        return textResult(`Hand-off limit reached (${limit} per hour). Try again later.`, true);
      }

      try {
        const result = await fireRoutine(target.routineId, token, text);
        await recordFire(env.BRIDGE_KV);
        await rememberHandoff(
          env.BRIDGE_KV,
          key,
          { sessionUrl: result.sessionUrl, sessionId: result.sessionId, handoffId, at: base.at },
          intVar(env.DEDUPE_WINDOW_SECONDS, 600)
        );
        await audit(env.BRIDGE_KV, { ...base, outcome: 'fired', sessionUrl: result.sessionUrl });
        return textResult(
          `Handed off to Claude (${target.name}). Claude session: ${result.sessionUrl}\n` +
            'Share this link with the user. Claude will plan first and ask for approval before changing anything.'
        );
      } catch (err) {
        const message = err instanceof RoutineFireError ? err.message : 'Unexpected error while starting the Claude session.';
        await audit(env.BRIDGE_KV, { ...base, outcome: 'error', error: err instanceof RoutineFireError ? `http_${err.status}` : 'unexpected' });
        if (!(err instanceof RoutineFireError)) console.error('fire failed', err);
        return textResult(message, true);
      }
    }
  );

  return server;
}

/** The protected /mcp handler. OAuthProvider has already validated the bearer token. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: AuthProps; auth: OAuthResourceAuth }) {
    const props = ctx.props;
    // Re-check the allowlist on every request, so removing an id takes effect without revoking grants.
    if (!props || !allowedUserIds(env).has(props.githubUserId)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!ctx.auth.scope.includes(HANDOFF_SCOPE)) {
      return insufficientScope(ctx.auth, [HANDOFF_SCOPE]);
    }
    const server = buildServer(env, props, ctx.auth);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every request is self-contained
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close());
    }
  },
};
