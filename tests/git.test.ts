import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bloblessClone, GitRepoError, redactSecrets, valuesFileAtRef } from "../src/git";

let fixtureDir: string;
let svcOrigin: string;
let valuesDir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      HOME: fixtureDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

beforeAll(() => {
  // Isolate git config for simple-git-spawned commands too (they inherit process.env).
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";

  fixtureDir = mkdtempSync(join(tmpdir(), "skein-git-"));

  git(fixtureDir, "init", "-b", "main", "svc");
  svcOrigin = join(fixtureDir, "svc");
  writeFileSync(join(svcOrigin, "routes.ts"), 'export const routes = ["/v1/orders"];\n');
  git(svcOrigin, "add", "-A", "-f");
  git(svcOrigin, "commit", "-m", "v1");
  git(svcOrigin, "tag", "a1");
  writeFileSync(join(svcOrigin, "routes.ts"), 'export const routes = ["/v1/orders", "/v2/orders"];\n');
  git(svcOrigin, "add", "-A");
  git(svcOrigin, "commit", "-m", "v2");
  git(svcOrigin, "tag", "a2");

  // values-repo-shaped fixture for valuesFileAtRef
  git(fixtureDir, "init", "-b", "main", "values");
  valuesDir = join(fixtureDir, "values");
  mkdirSync(join(valuesDir, "env", "prod"), { recursive: true });
  writeFileSync(join(valuesDir, "env", "prod", "b.yaml"), "tag: b3\n");
  git(valuesDir, "add", "-A");
  git(valuesDir, "commit", "-m", "pins");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("GitWorkdir", () => {
  it("diffs changed routes between two tags", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone"));
    const diff = await workdir.diffTags("a1", "a2");
    expect(diff).toMatch(/^-.*\/v1\/orders/m);
    expect(diff).toMatch(/^\+.*\/v2\/orders/m);
  });

  it("lists tags ascending starting at current", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone2"));
    expect(await workdir.listTagsAsc("a1")).toEqual(["a1", "a2"]);
  });

  it("lists all tags when current tag is absent from the repo", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone3"));
    expect(await workdir.listTagsAsc("never-tagged")).toEqual(["a1", "a2"]);
  });

  it("lists files at a ref", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone4"));
    expect(await workdir.listFiles("a1")).toContain("routes.ts");
  });

  it("reads a file at a ref", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone5"));
    expect(await workdir.readFile("a1", "routes.ts")).toContain("/v1/orders");
  });

  it("shows a file at a ref", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone6"));
    expect(await workdir.showFile("a2", "routes.ts")).toContain("/v2/orders");
  });

  it("throws GitRepoError naming repo and tag for a missing tag", async () => {
    const workdir = await bloblessClone(svcOrigin, "", join(fixtureDir, "clone7"));
    await expect(workdir.diffTags("a1", "nope")).rejects.toThrow(GitRepoError);
    await expect(workdir.diffTags("a1", "nope")).rejects.toThrow(/svc.*nope/);
  });
});

describe("token redaction", () => {
  const FAKE_TOKEN = "sekret-token-xyz";

  it("clone failures never leak the raw token", async () => {
    // The dir name embeds the token pattern so git's URL echo in the failure genuinely contains
    // the secret substring — this git strips userinfo, so the path carries it instead.
    const tokenBearingUrl = join(fixtureDir, "svc-sekret-token-xyz");
    let message = "";
    try {
      await bloblessClone(tokenBearingUrl, FAKE_TOKEN, join(fixtureDir, "leaky-clone"));
      expect.unreachable("cloning through an authenticated https URL against a local path must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitRepoError);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("clone failed for");
    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).toContain("***");
  });

  it("redactSecrets masks the token in promisor fetch failure stderr", () => {
    const stderrLine =
      "error: failed to fetch some objects from 'https://x-access-token:sekret-token-xyz@github.com/org/svc.git'";
    const redacted = redactSecrets(stderrLine, [FAKE_TOKEN]);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain("https://x-access-token:***@github.com/org/svc.git");
  });

  it("redactSecrets masks every occurrence and ignores empty secrets", () => {
    const twice = "url one: sekret-token-xyz and url two: sekret-token-xyz";
    expect(redactSecrets(twice, [FAKE_TOKEN])).toBe("url one: *** and url two: ***");
    expect(redactSecrets(twice, [""])).toBe(twice);
  });
});

describe("valuesFileAtRef", () => {
  it("reads file content from the checked-out values repo at HEAD", async () => {
    const content = await valuesFileAtRef(valuesDir, "env/prod/b.yaml", "HEAD");
    expect(content).toContain("b3");
  });

  it("throws GitRepoError naming the values repo for a missing file", async () => {
    await expect(valuesFileAtRef(valuesDir, "env/prod/missing.yaml", "HEAD")).rejects.toThrow(GitRepoError);
    await expect(valuesFileAtRef(valuesDir, "env/prod/missing.yaml", "HEAD")).rejects.toThrow(/values repo/);
  });
});
