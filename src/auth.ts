import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { allowedUserIds, type AuthProps, type Env } from './env';
import { HANDOFF_SCOPE } from './mcp';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function page(title: string, body: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(extra);
  // Keep the consent helpers' binding cookie; our CSP is a superset of their frame-ancestors rule.
  for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#666;--bg:#fafafa;--card:#fff;--line:#ddd;--accent:#c96442}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#161616;--card:#222;--line:#333}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:48px 16px}
main{max-width:460px;margin:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}.muted{color:var(--muted);font-size:14px}.warn{border-left:3px solid var(--accent);padding-left:10px}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style>
<main>${body}</main></html>`,
    { status, headers }
  );
}

function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escapeHtml(d.clientName || d.clientId);
  const origin = d.clientDomain
    ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return page(
    `Allow ${d.clientName || 'this app'}?`,
    `<h1>Allow ${name} to hand off tasks to Claude?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p class="muted">The app will be able to start new Claude Code sessions through your configured routines. It never sees the routine token. Next, you'll sign in with GitHub to confirm it's you.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><button class="primary" name="decision" value="approve">Continue with GitHub</button> <button name="decision" value="deny">Deny</button></p>
</form>`,
    200,
    headers
  );
}

function errorPage(message: string, status = 400): Response {
  return page('Sign-in problem', `<h1>Sign-in problem</h1><p>${escapeHtml(message)}</p>`, status);
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface UpstreamData {
  verifier: string;
}

async function githubIdentity(env: Env, code: string, verifier: string, redirectUri: string) {
  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`GitHub token exchange failed: ${tokenJson.error ?? tokenRes.status}`);
  }
  const userRes = await fetch(GITHUB_USER, {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-bridge',
    },
  });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string };
  // The GitHub token is used only to learn who signed in; it is not stored.
  return { id: user.id, login: user.login };
}

/** Handles everything outside /mcp: the landing page, /authorize and the GitHub callback. */
export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    const callbackUrl = `${env.PUBLIC_ORIGIN}/callback`;

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response('agent-bridge: MCP endpoint at /mcp\n', { headers: { 'content-type': 'text/plain' } });
      }

      if (url.pathname === '/authorize' && request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return consentPage(details, consent.handle, consent.headers);
      }

      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') ?? '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        // The only scope this server grants; the page doesn't offer a choice.
        const approved = await oauth.approveConsent(request, handle, { scope: [HANDOFF_SCOPE] });
        const verifier = randomVerifier();
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier } satisfies UpstreamData,
          headers: approved.headers,
        });
        const gh = new URL(GITHUB_AUTHORIZE);
        gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        gh.searchParams.set('redirect_uri', callbackUrl);
        gh.searchParams.set('scope', ''); // identity only: public profile, no repo access
        gh.searchParams.set('state', state);
        gh.searchParams.set('code_challenge', await s256(verifier));
        gh.searchParams.set('code_challenge_method', 'S256');
        gh.searchParams.set('allow_signup', 'false');
        headers.set('location', gh.toString());
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/callback' && request.method === 'GET') {
        const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
        const code = url.searchParams.get('code');
        if (url.searchParams.get('error') || !code) {
          headers.set('location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        const user = await githubIdentity(env, code, data.verifier, callbackUrl);
        if (!allowedUserIds(env).has(user.id)) {
          console.warn(JSON.stringify({ event: 'signin_denied', githubUserId: user.id, githubLogin: user.login }));
          headers.set('location', authorizationErrorRedirect(original, 'access_denied', 'This GitHub account is not allowed.'));
          return new Response(null, { status: 302, headers });
        }
        const props: AuthProps = { githubUserId: user.id, githubLogin: user.login };
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: String(user.id),
          metadata: { githubLogin: user.login },
          scope: [HANDOFF_SCOPE],
          props,
        });
        console.log(JSON.stringify({ event: 'signin', githubUserId: user.id, clientId: original.clientId }));
        headers.set('location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError) return errorPage(error.description);
      if (error instanceof CimdFetchError) return errorPage('This app could not be verified.');
      console.error('authorize failed', error);
      return errorPage('Something went wrong while signing in. Start again from ChatGPT.', 500);
    }
  },
};
