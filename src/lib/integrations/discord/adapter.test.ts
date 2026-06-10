import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { demoImport, TEST_POD_ROOT } from "../core/testing.js";
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
});
