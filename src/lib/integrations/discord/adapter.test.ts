import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
import { CLASSES, Group, OnlineAccount } from "../core/vocab.js";
import { discordAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/discord/`;
const PROFILE_DOC = `${ROOT}social/profile.ttl`;
const GUILDS_DOC = `${ROOT}social/servers.ttl`;

describe("discord adapter contract", () => {
  it("writes the profile as foaf:OnlineAccount", async () => {
    const { pod, report } = await demoImport(discordAdapter);
    expect(report.categories).toEqual(["social"]);

    const ds = pod.dataset(PROFILE_DOC);
    const account = new OnlineAccount(`${PROFILE_DOC}#account`, ds, DataFactory);
    expect(account.types.has(CLASSES.OnlineAccount)).toBe(true);
    expect(account.accountName).toBe("alice_v");
    expect(account.name).toBe("Alice");
    expect(account.accountServiceHomepage).toBe("https://discord.com/");
  });

  it("writes guilds as foaf:Group with member-count description", async () => {
    const { pod } = await demoImport(discordAdapter);
    const ds = pod.dataset(GUILDS_DOC);
    const guild = new Group(`${GUILDS_DOC}#guild-613425648685547541`, ds, DataFactory);
    expect(guild.types.has(CLASSES.Group)).toBe(true);
    expect(guild.name).toBe("Sourdough Bakers");
    expect(guild.description).toBe("312 members — you own this server");
  });

  it("registers OnlineAccount and Group for the social container", async () => {
    const { pod, report } = await demoImport(discordAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.OnlineAccount);
    expect(index).toContain(CLASSES.Group);
    expect(index).toContain(`${ROOT}social/`);
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(discordAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(GUILDS_DOC).size;
    await demoImport(discordAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(GUILDS_DOC).size).toBe(sizeBefore);
  });

  // Robustness: the live API can return a user with no display name and a
  // guilds array that's null, has null entries, or omits member counts.
  it("survives a sparse live response (no display name, null/partial guilds)", async () => {
    const { pod, report } = await sparseImport(discordAdapter, [
      // More-specific URL first: `/users/@me/guilds` also startsWith `/users/@me`.
      {
        url: "https://discord.com/api/v10/users/@me/guilds",
        json: [
          { id: "g1", name: "Has Count", owner: false, approximate_member_count: 10 },
          // No member count, owner present.
          { id: "g2", name: "No Count", owner: true },
          null, // null guild entry
          { name: "No Id" }, // no id ⇒ skipped
        ],
      },
      {
        url: "https://discord.com/api/v10/users/@me",
        json: { id: "u1", username: "bare_user", global_name: null },
      },
    ]);

    expect(report.written.map((w) => w.url).sort()).toEqual([PROFILE_DOC, GUILDS_DOC]);
    // null entry + id-less guild → 2 skipped.
    expect(report.skipped).toBe(2);

    const profile = expectCleanTurtle(pod, PROFILE_DOC);
    expectCleanTurtle(pod, GUILDS_DOC);

    // global_name null fell back to username (no literal "null").
    const account = new OnlineAccount(`${PROFILE_DOC}#account`, profile, DataFactory);
    expect(account.name).toBe("bare_user");

    const g2 = new Group(`${GUILDS_DOC}#guild-g2`, pod.dataset(GUILDS_DOC), DataFactory);
    expect(g2.name).toBe("No Count");
    expect(g2.description).toBeUndefined(); // omitted, not "undefined members"
  });
});
