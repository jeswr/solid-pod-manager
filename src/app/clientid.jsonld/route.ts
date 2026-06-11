/**
 * Solid Client Identifier Document (solid-client-id skill). Served from a route
 * handler — NOT public/*.jsonld, which `next dev` 404s. The served URL IS the
 * `client_id`, so the document must be self-consistent with the origin the app
 * is deployed at.
 *
 * Under `output: "export"` this handler runs ONCE at build time (force-static)
 * and is written to `out/clientid.jsonld`, so the origin cannot come from the
 * request — it is baked in from `NEXT_PUBLIC_APP_ORIGIN`. The default matches
 * local dev/e2e (`next dev -p 3200` / the static e2e server on :3200); a
 * production build MUST set it to the deployed origin, e.g.
 *
 *   NEXT_PUBLIC_APP_ORIGIN=https://app.solid-test.jeswr.org npm run build
 *
 * (the `build:prod` script does exactly that). The runtime side
 * (session-provider.tsx) derives the client_id it sends from `location.href`,
 * so the two agree iff the site is served at NEXT_PUBLIC_APP_ORIGIN.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const origin = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3200").replace(
    /\/+$/,
    "",
  );
  const clientId = `${origin}/clientid.jsonld`;
  const callback = `${origin}/callback.html`;

  const document = {
    "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
    client_id: clientId,
    client_name: "Pod Manager",
    redirect_uris: [callback],
    scope: "openid webid offline_access",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_uri: `${origin}/`,
  };

  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/ld+json",
      "cache-control": "public, max-age=300",
    },
  });
}
