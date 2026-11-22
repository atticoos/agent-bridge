import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { defaultHandler } from './auth';
import type { Env } from './env';
import { HANDOFF_SCOPE, mcpApiHandler } from './mcp';

// The resource URL depends on where the Worker is deployed, so build the provider per origin.
let cached: { origin: string; provider: OAuthProvider<Env> } | undefined;

export function providerFor(origin: string): OAuthProvider<Env> {
  if (cached?.origin === origin) return cached.provider;
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler as any,
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [HANDOFF_SCOPE],
    requiredScopes: [HANDOFF_SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
  });
  cached = { origin, provider };
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!env.PUBLIC_ORIGIN || !/^(https:\/\/[a-z0-9.-]+|http:\/\/localhost:\d+)$/.test(env.PUBLIC_ORIGIN)) {
      return new Response('PUBLIC_ORIGIN must be set to this Worker\'s https origin, lowercase, no trailing slash.', { status: 500 });
    }
    return providerFor(env.PUBLIC_ORIGIN).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
