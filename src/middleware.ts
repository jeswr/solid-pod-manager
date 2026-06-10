import { NextResponse } from "next/server";

/**
 * Security headers, including a Content-Security-Policy (review SEC-4).
 *
 * Why not a nonce/`strict-dynamic` CSP: this app is mostly statically prerendered,
 * and a per-request nonce cannot be embedded in static HTML — it would block Next's
 * own inline bootstrap scripts and the client would never hydrate (caught by the e2e).
 * So `script-src` allows `'self' 'unsafe-inline'`, which is the compatible choice for
 * a static Next deployment. That intentionally makes the CSP *not* the primary XSS
 * control — the real defences are at the app layer: the same-origin/pod-scope fetch
 * guard (SEC-1, src/lib/pod-scope.ts) and the href scheme allowlist (SEC-2,
 * src/components/resource-viewer.tsx). The CSP still earns its keep via
 * `frame-ancestors 'none'` (clickjacking — compounds the OAuth popup SEC-5),
 * `object-src 'none'`, `base-uri`/`form-action 'self'`, and by constraining where
 * images/media/connections may go.
 *
 * A Solid client necessarily talks to the user's chosen pod + IdP on ANY https origin,
 * so `connect-src`/`img-src`/`media-src` allow `https:` (+ loopback for local CSS).
 * `'unsafe-eval'` is added in development only (React Refresh needs it).
 *
 * Hardening follow-up: a nonce-based `script-src` would require opting pages into
 * dynamic rendering; tracked, not done here.
 */
export function middleware(): NextResponse {
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev ? `'self' 'unsafe-inline' 'unsafe-eval'` : `'self' 'unsafe-inline'`;

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' https: data: blob:`,
    `media-src 'self' https: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*`,
    `frame-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");

  const response = NextResponse.next();
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  return response;
}

export const config = {
  // App routes only; skip Next's static assets, the OAuth callback popup (a static
  // .html that posts back to its opener), and the client-id document.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|callback.html|clientid.jsonld).*)"],
};
