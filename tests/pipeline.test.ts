// tests/pipeline.test.ts — golden-path integration: real local git fixtures, real blobless
// clones, real solver; only the LLM (and the PR comment store) are fake. The first five
// tests pin the runPipeline contract; the sixth pins the temp-workdir security cleanup
// (clones carry the access token in .git/config and must never outlive the run).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bloblessClone } from "../src/git";
import { runPipeline, type PipelineDeps } from "../src/pipeline";
import type { Claim } from "../src/extract";

let fixtureDir: string;

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

  fixtureDir = mkdtempSync(join(tmpdir(), "skein-pipe-"));
  // provider api-a: tag a1 serves /v1/orders only; tag a2 adds /v2/orders.
  git(fixtureDir, "init", "-b", "main", "api-a");
  const apiADir = join(fixtureDir, "api-a");
  writeFileSync(join(apiADir, "routes.ts"), 'export const routes = ["/v1/orders"];\n');
  git(apiADir, "add", "-A"); git(apiADir, "commit", "-m", "1"); git(apiADir, "tag", "a1");
  writeFileSync(join(apiADir, "routes.ts"), 'export const routes = ["/v1/orders", "/v2/orders"];\n');
  git(apiADir, "add", "-A"); git(apiADir, "commit", "-m", "2"); git(apiADir, "tag", "a2");
  // twin tag on an existing tree: a bump a1 → a1-twin diffs to empty
  git(apiADir, "tag", "a1-twin", "a1");
  // consumer api-b: b3 does not call /v2/orders; b5 adds the call (cited at src/client.ts:3).
  git(fixtureDir, "init", "-b", "main", "api-b");
  const apiBDir = join(fixtureDir, "api-b");
  writeFileSync(join(apiBDir, "client.ts"), "const base = '/v1/orders';\n");
  git(apiBDir, "add", "-A"); git(apiBDir, "commit", "-m", "1"); git(apiBDir, "tag", "b3");
  mkdirSync(join(apiBDir, "src"), { recursive: true });
  writeFileSync(
    join(apiBDir, "src/client.ts"),
    "const url = '/v1/orders';\nawait fetch(url);\nconst next = '/v2/orders';\nawait fetch(next);\n",
  );
  git(apiBDir, "add", "-A"); git(apiBDir, "commit", "-m", "2"); git(apiBDir, "tag", "b5");
  // api-c exists only in the head commit's config: its values file appears with the bump —
  // the first-time-pin shape (base ref present, file absent at base).
  git(fixtureDir, "init", "-b", "main", "api-c");
  const apiCDir = join(fixtureDir, "api-c");
  writeFileSync(join(apiCDir, "client.ts"), "const base = '/v0/ping';\n");
  git(apiCDir, "add", "-A"); git(apiCDir, "commit", "-m", "1"); git(apiCDir, "tag", "c1");
  // values repo: a pinned a1, b pinned b3 → head bumps b to b5 and first-pins c.
  git(fixtureDir, "init", "-b", "main", "values");
  const valuesDir = join(fixtureDir, "values");
  mkdirSync(join(valuesDir, "env/prod"), { recursive: true });
  writeFileSync(join(valuesDir, "env/prod/a.yaml"), "tag: a1\n");
  writeFileSync(join(valuesDir, "env/prod/b.yaml"), "tag: b3\n");
  writeFileSync(join(valuesDir, "skein.yaml"), [
    "services:",
    "  api-a:",
    "    repo: local/api-a",
    "    file: env/prod/a.yaml",
    "    path: tag",
    "  api-b:",
    "    repo: local/api-b",
    "    file: env/prod/b.yaml",
    "    path: tag",
    "",
  ].join("\n"));
  git(valuesDir, "add", "-A"); git(valuesDir, "commit", "-m", "pins");
  writeFileSync(join(valuesDir, "env/prod/b.yaml"), "tag: b5\n");
  writeFileSync(join(valuesDir, "env/prod/c.yaml"), "tag: c1\n");
  writeFileSync(join(valuesDir, "skein.yaml"), [
    "services:",
    "  api-a:",
    "    repo: local/api-a",
    "    file: env/prod/a.yaml",
    "    path: tag",
    "  api-b:",
    "    repo: local/api-b",
    "    file: env/prod/b.yaml",
    "    path: tag",
    "  api-c:",
    "    repo: local/api-c",
    "    file: env/prod/c.yaml",
    "    path: tag",
    "",
  ].join("\n"));
  git(valuesDir, "add", "-A"); git(valuesDir, "commit", "-m", "bump b, first-pin c");
});

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

const citedCallClaim: Claim = {
  kind: "endpoint", detail: "/v2/orders", direction: "calls",
  citation: { file: "src/client.ts", line: 3 },
};

type FakeDeps = PipelineDeps & { comments: Array<{ id: number; body: string }> };

function buildDeps(mode: "advisory" | "enforcing", valuesDir = join(fixtureDir, "values")): FakeDeps {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: valuesDir }).toString().trim();
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: valuesDir }).toString().trim();
  const comments: Array<{ id: number; body: string }> = [];
  const deps: FakeDeps = {
    settings: { mode, model: "claude-sonnet-5", concurrency: 2, maxCostUsd: 5, configPath: "skein.yaml" },
    gitToken: "",
    readConfigFile: () => Promise.resolve(readFileSync(join(valuesDir, "skein.yaml"), "utf8")),
    valuesDir,
    baseSha: baseCommit,
    headSha: headCommit,
    prNumber: 1,
    repoUrlFor: (repoSpec) => join(fixtureDir, repoSpec.replace("local/", "")),
    cloneFactory: (repoUrl, token, targetDir) => bloblessClone(repoUrl, token, targetDir),
    anthropicFactory: () => ({
      createMessage: async () => ({
        content: [{ type: "text", text: JSON.stringify([citedCallClaim]) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    }),
    commentApi: {
      listComments: async () => comments,
      updateComment: async (id, body) => {
        const found = comments.find((comment) => comment.id === id);
        if (found) found.body = body;
      },
      createComment: async (prNumber, body) => {
        void prNumber;
        comments.push({ id: comments.length + 1, body });
      },
    },
    comments,
  };
  return deps;
}

describe("runPipeline golden path", () => {
  it("bump b3→b5 requiring /v2/orders recommends minimal a1→a2, advisory exits 0", async () => {
    const deps = buildDeps("advisory");
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("pass"); // satisfiable with the co-bump
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain("api-a");
    // Brief pinned "a1 → **a2**"; merged renderReport (task 9, its own test-pinned format)
    // renders bump rows without bold tags — the pinned row format is `service: from → to`.
    expect(outcome.report).toContain("api-a: a1 → a2");
    expect(outcome.report).toContain("/v2/orders");
    expect(deps.comments).toHaveLength(1); // the upserted PR comment carries the report
  });

  it("enforcing mode with unsatisfiable requirement exits 1", async () => {
    const deps = buildDeps("enforcing");
    deps.anthropicFactory = () => ({
      createMessage: async () => ({
        content: [{ type: "text", text: JSON.stringify([{ ...citedCallClaim, detail: "/v9/ghost" }]) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.exitCode).toBe(1);
  });

  it("advisory mode with unsatisfiable requirement exits 0 but reports fail", async () => {
    const deps = buildDeps("advisory");
    deps.anthropicFactory = () => ({
      createMessage: async () => ({
        content: [{ type: "text", text: JSON.stringify([{ ...citedCallClaim, detail: "/v9/ghost" }]) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.exitCode).toBe(0);
  });

  it("malfunction (bad config) exits 1 even in advisory", async () => {
    const deps = buildDeps("advisory");
    deps.readConfigFile = () => Promise.resolve("services: {}");
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("error");
    expect(outcome.exitCode).toBe(1);
  });

  it("cost ceiling abort exits 0 advisory with warning report", async () => {
    const deps = buildDeps("advisory");
    deps.settings = { ...deps.settings, maxCostUsd: 0.0000001 };
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("error");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain("cost");
  });

  it("zero bumps → pass report, exit 0, and no LLM call", async () => {
    const deps = buildDeps("enforcing");
    deps.baseSha = deps.headSha; // same commit at both refs → identical snapshots, no bumps
    deps.anthropicFactory = () => {
      throw new Error("LLM must not be called for a bumpless PR");
    };
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain("- none");
  });

  it("base ref absent from the checkout (shallow clone) errors instead of silently passing", async () => {
    const deps = buildDeps("advisory");
    deps.baseSha = "0".repeat(40); // what a fetch-depth: 1 checkout does to pull_request.base.sha
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("error");
    expect(outcome.exitCode).toBe(1); // both modes — refusing to guess is never advisory
    expect(outcome.report).toContain("fetch-depth");
    expect(outcome.report).toContain("refusing to guess");
  });

  it("first-time pin (base ref present, file absent at base) skips extraction without error", async () => {
    const deps = buildDeps("advisory");
    let llmCalls = 0;
    deps.anthropicFactory = () => {
      llmCalls += 1;
      return {
        createMessage: async () => ({
          content: [{ type: "text", text: JSON.stringify([citedCallClaim]) }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      };
    };
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.exitCode).toBe(0);
    expect(llmCalls).toBe(1); // only api-b's diff — api-c is newly pinned, no paid call, no error
    expect(outcome.report).not.toContain("api-c"); // first-time pins render nothing (no base to compare)
  });

  it("identical-tree tag bump extracts nothing and makes no LLM call", async () => {
    const twinValuesDir = join(fixtureDir, "values-twin");
    git(fixtureDir, "init", "-b", "main", "values-twin");
    mkdirSync(join(twinValuesDir, "env/prod"), { recursive: true });
    writeFileSync(join(twinValuesDir, "skein.yaml"), [
      "services:",
      "  api-a:",
      "    repo: local/api-a",
      "    file: env/prod/a.yaml",
      "    path: tag",
      "",
    ].join("\n"));
    writeFileSync(join(twinValuesDir, "env/prod/a.yaml"), "tag: a1\n");
    git(twinValuesDir, "add", "-A"); git(twinValuesDir, "commit", "-m", "pins");
    writeFileSync(join(twinValuesDir, "env/prod/a.yaml"), "tag: a1-twin\n");
    git(twinValuesDir, "add", "-A"); git(twinValuesDir, "commit", "-m", "twin bump");
    const deps = buildDeps("enforcing", twinValuesDir);
    deps.anthropicFactory = () => {
      throw new Error("LLM must not be called for an identical-tree bump");
    };
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain("a1 → a1-twin");
  });

  it("removes every temporary clone dir even when the pipeline fails mid-run", async () => {
    const deps = buildDeps("advisory");
    const cloneDirs: string[] = [];
    deps.cloneFactory = (repoUrl, token, targetDir) => {
      cloneDirs.push(targetDir);
      return bloblessClone(repoUrl, token, targetDir);
    };
    deps.anthropicFactory = () => {
      throw new Error("LLM unavailable");
    };
    const outcome = await runPipeline(deps);
    expect(outcome.verdict).toBe("error");
    expect(outcome.exitCode).toBe(1);
    expect(cloneDirs.length).toBeGreaterThan(0);
    for (const dir of cloneDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });
});
