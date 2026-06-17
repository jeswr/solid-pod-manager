/**
 * Seed MANY children into a container on the seeded `alice` pod, via a
 * client-credentials DPoP grant (the solid-test-infrastructure pattern, same as
 * global-setup.ts). Used by auth-401-budget.spec.ts to make the per-resource "401
 * dance" observable: a container with N children gives N distinct resource URLs, so a
 * dancing client would pay ≈N 401s — the budget test asserts it does NOT.
 *
 * Self-contained (no cross-file import from global-setup, which must stay transpiler-
 * safe); a spec file MAY import this.
 */
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";

const PASSWORD = "test-password-123";
const EMAIL = "alice@example.com";

interface Jar {
  cookie?: string;
}

async function jsonPost(url: string, body: unknown, jar: Jar) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  const sc = res.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json() };
}

async function controls(base: string, jar: Jar) {
  const res = await fetch(`${base}/.account/`, {
    headers: jar.cookie ? { cookie: jar.cookie } : {},
  });
  return (await res.json()).controls;
}

/** Mint a client-credentials token (DPoP-bound) for alice's WebID. */
async function mintToken(
  base: string,
  webId: string,
): Promise<{ accessToken: string; proof: (m: string, u: string, ath?: string) => Promise<string> }> {
  const jar: Jar = {};
  const c = await controls(base, jar);
  const login = await jsonPost(c.password.login, { email: EMAIL, password: PASSWORD }, jar);
  if (login.status >= 400) throw new Error(`login failed: ${JSON.stringify(login.json)}`);
  const c2 = await controls(base, jar);
  const cc = await jsonPost(c2.account.clientCredentials, { name: `seed-${randomUUID()}`, webId }, jar);

  const tokenEndpoint = `${base}/.oidc/token`;
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "ES256";
  const proof = (method: string, url: string, ath?: string) =>
    new SignJWT({ htu: url, htm: method, jti: randomUUID(), ...(ath ? { ath } : {}) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(privateKey);

  const basic = Buffer.from(
    `${encodeURIComponent(cc.json.id)}:${encodeURIComponent(cc.json.secret)}`,
  ).toString("base64");
  const tr = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await proof("POST", tokenEndpoint),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!tr.ok) throw new Error(`token ${tr.status}: ${await tr.text()}`);
  const { access_token } = await tr.json();
  return { accessToken: access_token, proof };
}

/**
 * Create `count` text resources under `<base>/<pod>/<container>/`. Idempotent enough for a
 * fresh in-memory CSS (a re-PUT just overwrites). Returns the container URL.
 */
export async function seedManyChildren(
  base: string,
  pod: string,
  container: string,
  count: number,
): Promise<string> {
  const webId = `${base}/${pod}/profile/card#me`;
  const { accessToken, proof } = await mintToken(base, webId);
  const ath = createHash("sha256").update(accessToken).digest("base64url");
  const containerUrl = `${base}/${pod}/${container}/`;

  // Create the LDP container FIRST. CSS often auto-creates intermediate containers on a
  // deep child PUT, but that is not guaranteed across servers/configs — an explicit
  // container PUT makes the seeding deterministic on a fresh pod (the roborev finding).
  const mkContainer = await fetch(containerUrl, {
    method: "PUT",
    headers: {
      authorization: `DPoP ${accessToken}`,
      dpop: await proof("PUT", containerUrl, ath),
      "content-type": "text/turtle",
      link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
  });
  if (!mkContainer.ok && mkContainer.status !== 205 && mkContainer.status !== 409) {
    throw new Error(`seed container PUT ${mkContainer.status}: ${await mkContainer.text()}`);
  }

  for (let i = 0; i < count; i++) {
    const url = `${containerUrl}item-${i}.txt`;
    const put = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: await proof("PUT", url, ath),
        "content-type": "text/plain",
      },
      body: `child ${i}`,
    });
    if (!put.ok && put.status !== 205) {
      throw new Error(`seed child ${i} PUT ${put.status}: ${await put.text()}`);
    }
  }
  return containerUrl;
}
