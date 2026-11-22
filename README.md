# agent-bridge

A remote MCP server that lets ChatGPT hand off a task to a Claude project by firing a Claude Code routine's API trigger. ChatGPT never sees the routine token.

```
ChatGPT ──(OAuth access token, 1h)──▶ agent-bridge on Cloudflare Workers ──(routine token, Worker secret)──▶ Claude routine fire API
             │                                     │
             └── you sign in with GitHub ◀─────────┘ only allowlisted GitHub user ids get a grant
```

## Why this shape

ChatGPT can't hold a credential safely. So the routine token (`sk-ant-oat01-…`) lives only as a Worker secret. ChatGPT connects to this server as a custom MCP connector over OAuth 2.1. The authorization flow sends you through GitHub sign-in and grants access only to the GitHub user ids listed in `ALLOWED_GITHUB_USER_IDS`. ChatGPT gets a one-hour access token that you can revoke, scoped to this server, and nothing else.

Alternatives considered:

- **Paste the routine token into ChatGPT.** Rejected, because that's the exposure this project exists to avoid.
- **Custom GPT Action with OAuth.** This also keeps the token server-side. But it only works inside one GPT and still needs this backend. An MCP connector works in any chat.

## What it exposes

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_handoff_targets` | read-only | Lists the configured Claude projects (routines). |
| `handoff_to_claude` | write | Takes a structured handoff: `title`, `objective`, `mode`, `background`, `decisions`, `rejected_alternatives`, `constraints`, `deliverables`, `next_steps`, `open_questions`, `conversation_excerpt`. It renders these as Markdown in the shape the "ChatGPT Handoff" routine prompt expects, fires the routine, and returns the Claude session link. ChatGPT asks you to confirm before each call. |

## Safeguards

- **Token stays server-side.** It is never returned in tool output or error messages and never written to logs or KV.
- **Identity.** GitHub sign-in is checked against numeric user ids, not logins, because logins can be renamed. The check runs again on every MCP request, so removing an id cuts off access at once. No GitHub scopes are requested, so the server sees only your public profile, and the GitHub token is discarded after the lookup.
- **Confused-deputy protection.** The library's consent page does the heavy lifting. It can't be framed, it is bound to your browser by a cookie, and it shows the client name and redirect host. The GitHub `state` is created only after consent.
- **Duplicate suppression.** The fire API has no idempotency, so a retried tool call would start a second session. An identical handoff within `DEDUPE_WINDOW_SECONDS` (default 10 minutes) returns the earlier session instead.
- **Rate limit.** `MAX_FIRES_PER_HOUR` (default 20) sits below the routine's own cap of 30 per hour.
- **Audit log.** Every attempt is written to `BRIDGE_KV` under `audit:` for 90 days and to Workers logs. Each entry records who, which client, the target, the title, a content hash, the outcome and the session URL. Payload text is not stored.
- **Payload framing.** The payload is marked as task data that is not approval. The routine prompt already treats it that way.

KV is eventually consistent, so the rate limit and duplicate check are best-effort. That's fine for a single-user server.

## Setup

### 1. Cloudflare resources

```sh
npm install
npx wrangler login
npx wrangler kv namespace create agent-bridge-oauth-kv
npx wrangler kv namespace create agent-bridge-bridge-kv
```

Paste both ids into `wrangler.jsonc` under the `OAUTH_KV` and `BRIDGE_KV` bindings (keep those binding names; the code depends on them). Set `account_id` there too if your login can reach more than one Cloudflare account. Then set `PUBLIC_ORIGIN` to the Worker's URL, for example `https://agent-bridge.<your-subdomain>.workers.dev`. A custom domain also works.

### 2. GitHub OAuth App (sign-in only)

Go to GitHub, then Settings → Developer settings → OAuth Apps → New OAuth App.

- **Homepage URL:** your `PUBLIC_ORIGIN`
- **Authorization callback URL:** `<PUBLIC_ORIGIN>/callback`

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

### 3. Routine token

At [claude.ai/code/routines](https://claude.ai/code/routines), open **ChatGPT Handoff**. Choose **Add another trigger** → **API** → **Generate token**. The token is shown once, so store it straight away:

```sh
npx wrangler secret put ROUTINE_TOKEN_RELAYRUNNER
```

To rotate it, generate a new token, which revokes the old one, and run the same command again.

### 4. Deploy

```sh
npm run check   # type check, tests, bundle
npm run deploy
```

### 5. Connect ChatGPT

1. In ChatGPT on the web, turn on developer mode: Settings → Apps & Connectors → Advanced settings → Developer mode.
2. Add a custom MCP server (in the current UI: chatgpt.com/plugins → **+** → **Add custom MCP server**).
3. Set the server URL to `<PUBLIC_ORIGIN>/mcp` and the authentication to **OAuth**. ChatGPT registers itself through the discovery and dynamic registration endpoints, so you don't need to enter a client id or secret.
4. On the consent page, choose **Continue with GitHub** and sign in as an allowlisted account.
5. In a chat, ask ChatGPT to "hand this off to Claude". It shows a confirmation, then replies with the Claude session link.

## Adding more Claude projects

Add an entry to `HANDOFF_TARGETS` in `wrangler.jsonc`, then set its token:

```jsonc
"HANDOFF_TARGETS": "{\"relayrunner\":{\"routine_id\":\"trig_…\",\"description\":\"RelayRunner\"},\"agent-bridge\":{\"routine_id\":\"trig_…\",\"description\":\"This repo\"}}"
```

```sh
npx wrangler secret put ROUTINE_TOKEN_AGENT_BRIDGE
```

The secret name is `ROUTINE_TOKEN_` followed by the target name in upper case, with non-alphanumerics turned into `_`.

## Revoking access

- **To cut off one ChatGPT connection,** remove the connector in ChatGPT. Its grant expires with its refresh token, after 30 days at most.
- **To cut off everyone at once,** empty `ALLOWED_GITHUB_USER_IDS` and redeploy. The check runs on every request.
- **To stop routine fires even if the Worker is compromised,** regenerate the routine token in Claude.

## Troubleshooting

**The handoff fails with HTTP 401.** The `ROUTINE_TOKEN_<NAME>` secret doesn't match the routine's current API token. Generating a token revokes the previous one, so a secret you set before regenerating stops working. To fix it:

1. Run `npx wrangler tail` and retry the handoff. The `fire_failed` log line includes a `tokenHint` such as `sk-ant-oat01-ClyYsTT7...3gAA`.
2. Compare that hint with the one claude.ai shows for the routine.
3. If they differ, put the current token in the secret with `npx wrangler secret put ROUTINE_TOKEN_RELAYRUNNER`, or generate a new token and set it straight away.

**ChatGPT lists targets, but a target says "not ready".** Its token secret is missing.

## Development

```sh
cp .dev.vars.example .dev.vars
npm run dev        # http://localhost:8787 with local KV
npm test
```

## Layout

- `src/index.ts`: the OAuth provider wiring (`@cloudflare/workers-oauth-provider`), covering discovery, DCR, CIMD, token and revocation.
- `src/auth.ts`: the consent page, the GitHub sign-in and the allowlist.
- `src/mcp.ts`: the stateless Streamable HTTP MCP server and its tools.
- `src/routine.ts`: the payload format and the fire API client.
- `src/guard.ts`: the rate limit, duplicate suppression and audit log.
