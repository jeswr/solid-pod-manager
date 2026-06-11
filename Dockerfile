# Pod Manager — static export served by Caddy.
#
# The image only packages a prebuilt export; build it first with the deployed
# origin baked into /clientid.jsonld (the OIDC client_id must match the origin
# the app is served from):
#
#   npm run build:prod        # NEXT_PUBLIC_APP_ORIGIN=https://app.solid-test.jeswr.org
#   docker build -t solid-pod-manager .
#   docker run --rm -p 8080:8080 solid-pod-manager
#
# Post-deploy smoke check (the security headers exist ONLY here — `next dev`
# and the vitest/e2e suites never exercise them, so verify after CSP changes):
#
#   curl -sI http://localhost:8080/ | grep -i content-security-policy
#
# TLS terminates at the box's edge proxy; this serves plain HTTP on :8080.
FROM caddy:2-alpine

# Strip the file capability the base image sets on the caddy binary
# (cap_net_bind_service=ep). We listen on :8080 so it is unneeded, and its
# *effective* bit makes exec fail with EPERM under the hardened compose
# posture (cap_drop: ALL + no-new-privileges) the server stack runs us with.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy

# The origin the export must have been built for. Override with
# `--build-arg APP_ORIGIN=...` when building for a different deployment.
ARG APP_ORIGIN=https://app.solid-test.jeswr.org

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY out/ /srv/

# Refuse to package an export baked for the wrong origin. A plain `npm run
# build` bakes http://localhost:3200 into the Client Identifier Document; at
# the deployed origin the IdP dereferences a client_id whose document points
# at localhost and OIDC login breaks non-obviously. Fail the build instead.
RUN grep -qF "\"client_id\": \"${APP_ORIGIN}/clientid.jsonld\"" /srv/clientid.jsonld || { \
      echo "ERROR: out/clientid.jsonld is not built for ${APP_ORIGIN}."; \
      echo "  found: $(grep -o '"client_id":[^,]*' /srv/clientid.jsonld)"; \
      echo "  Run 'npm run build:prod' before 'docker build', or pass"; \
      echo "  --build-arg APP_ORIGIN=<origin> matching the export."; \
      exit 1; \
    }

EXPOSE 8080
