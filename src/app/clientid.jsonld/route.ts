/**
 * Solid Client Identifier Document (solid-client-id skill). Served from a route
 * handler — NOT public/*.jsonld, which `next dev` 404s. The served URL IS the
 * `client_id`, derived from the request origin so it is self-consistent across
 * localhost (dev) and the deployed HTTPS origin. Publishing this makes the OIDC
 * consent screen show "Pod Manager" instead of a throwaway registration id.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const clientId = new URL("/clientid.jsonld", request.url).toString();
  const callback = new URL("/callback.html", request.url).toString();
  const origin = new URL("/", request.url).toString();

  const document = {
    "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
    client_id: clientId,
    client_name: "Pod Manager",
    redirect_uris: [callback],
    scope: "openid webid offline_access",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_uri: origin,
  };

  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/ld+json",
      "cache-control": "public, max-age=300",
    },
  });
}
