/**
 * GitHub → Work & education. `/user` (profile, as `foaf:OnlineAccount`) +
 * `/user/repos` (as `schema:SoftwareSourceCode`). Snapshot semantics — the
 * repos endpoint has no change cursor, so every import rewrites the
 * collection (idempotent by construction).
 *
 * Live-mode honesty: GitHub OAuth apps do NOT support secretless PKCE — the
 * code→token exchange requires the client secret, so live mode needs the
 * maintainer's token proxy as well as the client id.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import { arr, optionalDate, optionalText, SkipCounter } from "../core/safe.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, OnlineAccount, SoftwareSourceCode } from "../core/vocab.js";
import { GITHUB_FIXTURES, type GitHubRepo, type GitHubUser } from "./fixtures.js";

const ID = "github";
const API = "https://api.github.com";
const SCOPES = ["read:user", "repo"] as const;

export const githubAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "GitHub",
    tier: "A",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["work-education"],
    whatYouGet: "Your developer profile and your repositories, filed under Work & education.",
    requirements: [
      "Register an OAuth App at github.com/settings/developers.",
      "Add <app-origin>/oauth-callback.html as the Authorization callback URL.",
      "Set NEXT_PUBLIC_GITHUB_CLIENT_ID.",
      "GitHub's token endpoint requires the client secret (no public PKCE): deploy the token-exchange proxy and set NEXT_PUBLIC_GITHUB_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID,
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_GITHUB_TOKEN_PROXY,
  },
  apiHeaders: { accept: "application/vnd.github+json" },
  fixtures: () => GITHUB_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    const skipped = new SkipCounter();

    ctx.progress({ label: "Fetching your GitHub profile…", done: 0, total: 2 });
    const user = (await getJson<GitHubUser>(ID, ctx.api, `${API}/user`)) ?? {};

    const profileDoc = ctx.resolve("work/profile.ttl");
    const profile = new Store();
    const account = new OnlineAccount(`${profileDoc}#account`, profile, DataFactory).mark();
    const login = optionalText(user.login);
    account.accountName = login;
    account.name = optionalText(user.name) ?? login;
    // description, html_url, bio are all commonly null on the live API.
    account.description = optionalText(user.bio);
    account.sourceUrl = optionalText(user.html_url);
    account.accountServiceHomepage = "https://github.com/";
    account.dateCreated = optionalDate(user.created_at);
    await ctx.write({
      slug: "work/profile.ttl",
      category: "work-education",
      forClass: CLASSES.OnlineAccount,
      dataset: profile,
      // Companion doc: it rides along in the registered work container —
      // registering OnlineAccount would misfile GitHub under Social.
      skipRegistration: true,
    });

    ctx.progress({ label: "Fetching your repositories…", done: 1, total: 2 });
    const repos = await getJson<GitHubRepo[] | null>(
      ID,
      ctx.api,
      `${API}/user/repos?sort=pushed&per_page=100`,
    );

    const reposDoc = ctx.resolve("work/repositories.ttl");
    const dataset = new Store();
    for (const r of arr(repos)) {
      // A repo with no id has no stable fragment IRI — skip it.
      if (!r || r.id === undefined || r.id === null) {
        skipped.skip();
        continue;
      }
      const repo = new SoftwareSourceCode(`${reposDoc}#repo-${r.id}`, dataset, DataFactory).mark();
      repo.name = optionalText(r.full_name) ?? optionalText(r.name);
      repo.identifier = String(r.id);
      // description, homepage, language are null for a large fraction of repos.
      repo.description = optionalText(r.description);
      repo.programmingLanguage = optionalText(r.language);
      repo.codeRepository = optionalText(r.html_url);
      repo.sourceUrl = optionalText(r.html_url);
      repo.dateModified = optionalDate(r.pushed_at);
    }
    await ctx.write({
      slug: "work/repositories.ttl",
      category: "work-education",
      forClass: CLASSES.SoftwareSourceCode,
      dataset,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return { skipped: skipped.value };
  },
};
