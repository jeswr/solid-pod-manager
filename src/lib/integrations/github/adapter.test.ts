import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import {
  demoImport,
  expectCleanTurtle,
  sparseImport,
  TEST_POD_ROOT,
} from "../core/testing.js";
import { CLASSES, OnlineAccount, SoftwareSourceCode } from "../core/vocab.js";
import { githubAdapter } from "./adapter.js";

const ROOT = `${TEST_POD_ROOT}integrations/github/`;
const PROFILE_DOC = `${ROOT}work/profile.ttl`;
const REPOS_DOC = `${ROOT}work/repositories.ttl`;

describe("github adapter contract", () => {
  it("writes repositories as typed schema:SoftwareSourceCode", async () => {
    const { pod, report } = await demoImport(githubAdapter);

    expect(report.written.map((w) => w.url).sort()).toEqual([PROFILE_DOC, REPOS_DOC]);
    expect(report.categories).toEqual(["work-education"]);

    const ds = pod.dataset(REPOS_DOC);
    const repo = new SoftwareSourceCode(`${REPOS_DOC}#repo-901234`, ds, DataFactory);
    expect(repo.types.has(CLASSES.SoftwareSourceCode)).toBe(true);
    expect(repo.name).toBe("alice-dev/solid-pod-manager");
    expect(repo.programmingLanguage).toBe("TypeScript");
    expect(repo.codeRepository).toBe("https://github.com/alice-dev/solid-pod-manager");
    expect(repo.dateModified?.toISOString()).toBe("2026-06-01T17:40:00.000Z");
  });

  it("writes the profile as foaf:OnlineAccount riding along in the work container", async () => {
    const { pod } = await demoImport(githubAdapter);
    const ds = pod.dataset(PROFILE_DOC);
    const account = new OnlineAccount(`${PROFILE_DOC}#account`, ds, DataFactory);
    expect(account.types.has(CLASSES.OnlineAccount)).toBe(true);
    expect(account.accountName).toBe("alice-dev");
    expect(account.accountServiceHomepage).toBe("https://github.com/");
  });

  it("registers ONLY SoftwareSourceCode (profile doc must not misfile under Social)", async () => {
    const { pod, report } = await demoImport(githubAdapter);
    const index = pod.get(report.indexUrl) ?? "";
    expect(index).toContain(CLASSES.SoftwareSourceCode);
    expect(index).toContain(`${ROOT}work/`);
    expect(index).not.toContain(CLASSES.OnlineAccount);
  });

  it("re-import is idempotent", async () => {
    const { pod } = await demoImport(githubAdapter);
    const before = pod.urls();
    const sizeBefore = pod.dataset(REPOS_DOC).size;
    await demoImport(githubAdapter, { pod });
    expect(pod.urls()).toEqual(before);
    expect(pod.dataset(REPOS_DOC).size).toBe(sizeBefore);
  });

  // Robustness: null description/homepage/language are common on the live API,
  // the profile name/bio can be null, and the repos array may carry a null.
  it("survives a sparse live response (null repo fields, null profile fields)", async () => {
    const { pod, report } = await sparseImport(githubAdapter, [
      // More-specific URL first: `/user/repos` also startsWith `/user`.
      {
        url: "https://api.github.com/user/repos",
        json: [
          {
            id: 1,
            name: "bare",
            full_name: "octo/bare",
            description: null,
            language: null,
            html_url: "https://github.com/octo/bare",
            pushed_at: null,
          },
          null, // null repo entry
        ],
      },
      {
        url: "https://api.github.com/user",
        json: {
          login: "octo",
          name: null,
          bio: null,
          html_url: "https://github.com/octo",
          created_at: null, // malformed/absent date must not crash
        },
      },
    ]);

    expect(report.written.map((w) => w.url).sort()).toEqual([PROFILE_DOC, REPOS_DOC]);
    expect(report.skipped).toBe(1); // the null repo

    const profile = expectCleanTurtle(pod, PROFILE_DOC);
    const repos = expectCleanTurtle(pod, REPOS_DOC);

    const account = new OnlineAccount(`${PROFILE_DOC}#account`, profile, DataFactory);
    expect(account.name).toBe("octo"); // null name fell back to login
    expect(account.description).toBeUndefined(); // null bio omitted, not "null"
    expect(account.dateCreated).toBeUndefined(); // null date omitted, no crash

    const repo = new SoftwareSourceCode(`${REPOS_DOC}#repo-1`, repos, DataFactory);
    expect(repo.name).toBe("octo/bare");
    expect(repo.description).toBeUndefined();
    expect(repo.programmingLanguage).toBeUndefined();
    expect(repo.dateModified).toBeUndefined();
  });
});
