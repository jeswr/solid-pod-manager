import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { fileImport, memoryFile, TEST_POD_ROOT } from "../core/testing.js";
import { CLASSES, OnlineAccount, VideoGame } from "../core/vocab.js";
import { parseSteamExport, steamFileAdapter } from "./file-adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/steam/`;
const GAMES = `${ROOT}media/steam-games.ttl`;
const ACCT = `${ROOT}social/steam-account.ttl`;

// GetOwnedGames-style export with an account header.
const SAMPLE = JSON.stringify({
  steamid: "76561198000000000",
  personaname: "Gabe",
  response: {
    game_count: 2,
    games: [
      { appid: 570, name: "Dota 2", playtime_forever: 12000 },
      { appid: 730, name: "Counter-Strike 2", playtime_forever: 90 },
    ],
  },
});

describe("steam file adapter", () => {
  it("writes games to Media and the account to Social", async () => {
    const { pod, report } = await fileImport(
      steamFileAdapter,
      memoryFile("games.json", SAMPLE, "application/json"),
    );
    expect(report.categories.sort()).toEqual(["media", "social"]);
    expect(report.written.map((w) => w.url).sort()).toEqual([GAMES, ACCT].sort());

    const games = pod.dataset(GAMES);
    const types = [...games].filter(
      (q) => q.object.value === CLASSES.VideoGame && q.predicate.value.endsWith("type"),
    );
    expect(types).toHaveLength(2);
  });

  it("formats playtime as an ISO duration and links the store page", async () => {
    const { pod } = await fileImport(
      steamFileAdapter,
      memoryFile("g.json", SAMPLE, "application/json"),
    );
    const ds = pod.dataset(GAMES);
    const dota = [...ds].find(
      (q) => q.predicate.value === "https://schema.org/name" && q.object.value === "Dota 2",
    );
    const game = new VideoGame(dota!.subject.value, ds, DataFactory);
    expect(game.timeRequired).toBe("PT200H"); // 12000 minutes
    expect(game.sourceUrl).toBe("https://store.steampowered.com/app/570");
    expect(game.identifier).toBe("570");
  });

  it("writes the account as foaf:OnlineAccount", async () => {
    const { pod } = await fileImport(
      steamFileAdapter,
      memoryFile("g.json", SAMPLE, "application/json"),
    );
    const ds = pod.dataset(ACCT);
    const acct = new OnlineAccount(`${ACCT}#account`, ds, DataFactory);
    expect(acct.types.has(CLASSES.OnlineAccount)).toBe(true);
    expect(acct.accountName).toBe("Gabe");
    expect(acct.identifier).toBe("76561198000000000");
  });

  it("registers both classes in the type index", async () => {
    const { pod, report } = await fileImport(
      steamFileAdapter,
      memoryFile("g.json", SAMPLE, "application/json"),
    );
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.VideoGame);
    expect(index).toContain(CLASSES.OnlineAccount);
  });
});

describe("parseSteamExport", () => {
  it("accepts a bare array of games", () => {
    const parsed = parseSteamExport(JSON.stringify([{ appid: 1, name: "X", playtime_forever: 5 }]));
    expect(parsed.games).toHaveLength(1);
    expect(parsed.account).toBeUndefined();
  });
  it("returns empty for invalid JSON", () => {
    expect(parseSteamExport("nope").games).toEqual([]);
  });
});
