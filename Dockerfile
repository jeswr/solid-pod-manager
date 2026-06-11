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
# TLS terminates at the box's edge proxy; this serves plain HTTP on :8080.
FROM caddy:2-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY out/ /srv/

EXPOSE 8080
