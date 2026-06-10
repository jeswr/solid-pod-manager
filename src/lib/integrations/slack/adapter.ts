/**
 * Slack → Work & education. Your workspace and its channels
 * (`auth.test` + `conversations.list`) as `foaf:Group` — the workspace as the
 * parent group, each channel as a group, with member counts and topics.
 *
 * Tier B: installing a Slack app into a workspace needs workspace-admin
 * approval, and Slack reviews apps before public distribution. Slack uses a
 * confidential OAuth client for code→token, so live mode runs through the
 * maintainer's token proxy. Demoable now against recorded fixtures.
 */
import { DataFactory, Store } from "n3";
import { getJson } from "../core/fixture-fetch.js";
import type { ImportContext, ImportOutcome, IntegrationAdapter } from "../core/types.js";
import { CLASSES, Organisation } from "../core/vocab.js";
import { type SlackAuthTest, type SlackConversationsList, SLACK_FIXTURES } from "./fixtures.js";

const ID = "slack";
const API = "https://slack.com/api";
const SCOPES = ["channels:read", "team:read"] as const;

export const slackAdapter: IntegrationAdapter = {
  metadata: {
    id: ID,
    name: "Slack",
    tier: "B",
    authKind: "oauth-pkce",
    scopes: SCOPES,
    categories: ["work-education"],
    whatYouGet: "Your workspace and its channels, saved into Work & education.",
    requirements: [
      "Workspace-admin install approval: a Slack workspace admin must approve the app before it can read a user's channels, and Slack reviews apps before public distribution.",
      "Create an app at api.slack.com/apps and add <app-origin>/oauth-callback.html as an OAuth redirect URL.",
      "Slack uses a confidential OAuth client, so set NEXT_PUBLIC_SLACK_CLIENT_ID and deploy the token proxy at NEXT_PUBLIC_SLACK_TOKEN_PROXY.",
    ],
  },
  oauth: {
    clientId: process.env.NEXT_PUBLIC_SLACK_CLIENT_ID,
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    scopes: SCOPES,
    tokenExchange: "proxy",
    tokenProxyUrl: process.env.NEXT_PUBLIC_SLACK_TOKEN_PROXY,
    // Slack puts user scopes under `user_scope` rather than `scope`.
    extraAuthParams: { user_scope: SCOPES.join(",") },
  },
  fixtures: () => SLACK_FIXTURES,

  async import(ctx: ImportContext): Promise<ImportOutcome> {
    ctx.progress({ label: "Identifying your workspace…", done: 0, total: 2 });
    const auth = await getJson<SlackAuthTest>(ID, ctx.api, `${API}/auth.test`);

    const doc = ctx.resolve("work/workspace.ttl");
    const store = new Store();

    const team = new Organisation(`${doc}#team-${auth.team_id}`, store, DataFactory).mark();
    team.name = auth.team;
    team.identifier = auth.team_id;
    team.sourceUrl = auth.url;

    ctx.progress({ label: "Fetching your channels…", done: 1, total: 2 });
    const list = await getJson<SlackConversationsList>(
      ID,
      ctx.api,
      `${API}/conversations.list?types=public_channel&exclude_archived=true&limit=1000`,
    );

    for (const c of list.channels) {
      const channel = new Organisation(`${doc}#channel-${c.id}`, store, DataFactory).mark();
      channel.name = `#${c.name}`;
      channel.identifier = c.id;
      channel.description = c.purpose?.value || c.topic?.value || undefined;
      channel.sourceUrl = `${auth.url}archives/${c.id}`;
      if (c.created) channel.dateCreated = new Date(c.created * 1000);
    }

    await ctx.write({
      slug: "work/workspace.ttl",
      category: "work-education",
      forClass: CLASSES.Organization,
      dataset: store,
    });

    ctx.progress({ label: "Done", done: 2, total: 2 });
    return {};
  },
};
