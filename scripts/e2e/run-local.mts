// Skein e2e local harness — drives the REAL pipeline (real git fixtures, real
// blobless clones, real fact harvest, real Anthropic extraction) through four
// scenarios and asserts each verdict against the expected outcome. Output lands
// in scripts/e2e/.e2e-output/ for the kind reality layer to compare against.
//
// Requires: ANTHROPIC_API_KEY in the environment. No GitHub, no network beyond
// the Anthropic API — commentApi captures the PR comment to disk instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runPipeline, type PipelineDeps } from "../../src/pipeline";
import { bloblessClone } from "../../src/git";

const OUTPUT_DIR = join(import.meta.dirname, ".e2e-output");
const GIT_ISOLATION = {
  ...process.env,
  GIT_AUTHOR_NAME: "skein-rig",
  GIT_AUTHOR_EMAIL: "rig@skein.local",
  GIT_COMMITTER_NAME: "skein-rig",
  GIT_COMMITTER_EMAIL: "rig@skein.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  HOME: tmpdir(),
};
const MODEL = process.env.SKEIN_E2E_MODEL ?? "claude-sonnet-5";

type ServiceVariant = { tag: string; files: Record<string, string> };

const API_A_VARIANTS: ServiceVariant[] = [
  {
    tag: "a1",
    files: { "src/routes.ts": 'export const routes = ["/v1/orders"];\n' },
  },
  {
    tag: "a2",
    files: { "src/routes.ts": 'export const routes = ["/v1/orders", "/v2/orders"];\n' },
  },
];

const API_B_VARIANTS: ServiceVariant[] = [
  {
    tag: "b3",
    files: { "src/client.ts": 'export const endpoints = ["/v1/orders"];\nawait fetch("/v1/orders");\n' },
  },
  {
    tag: "b5",
    files: {
      "src/client.ts":
        'export const endpoints = ["/v1/orders", "/v2/orders"];\nawait fetch("/v1/orders");\nawait fetch("/v2/orders");\n',
    },
  },
  {
    tag: "b6",
    files: {
      "src/client.ts":
        'export const endpoints = ["/v1/orders", "/v2/orders"];\nawait fetch("/v1/orders");\nawait fetch("/v2/orders");\n',
      "src/config.ts": "export const ordersUrl = process.env.ORDERS_V2_URL;\n",
    },
  },
  {
    tag: "b7",
    files: {
      "src/client.ts":
        'export const endpoints = ["/v1/orders", "/v9/ghost"];\nawait fetch("/v1/orders");\nawait fetch("/v9/ghost");\n',
    },
  },
];

type Scenario = {
  name: string;
  bumpedTag: string;
  expected: {
    verdict: "pass" | "fail";
    requiredBumps: Array<{ service: string; from: string; to: string }>;
    missingEnv: string[];
    unmet: string[];
  };
};

const SCENARIOS: Scenario[] = [
  {
    name: "cosmetic-bump-passes-alone",
    bumpedTag: "b3-cosmetic",
    expected: { verdict: "pass", requiredBumps: [], missingEnv: [], unmet: [] },
  },
  {
    name: "new-endpoint-requires-a2",
    bumpedTag: "b5",
    expected: {
      verdict: "pass",
      requiredBumps: [{ service: "api-a", from: "a1", to: "a2" }],
      missingEnv: [],
      unmet: [],
    },
  },
  {
    name: "env-var-missing-fails",
    bumpedTag: "b6",
    expected: { verdict: "fail", requiredBumps: [], missingEnv: ["ORDERS_V2_URL"], unmet: [] },
  },
  {
    name: "ghost-endpoint-unsatisfiable",
    bumpedTag: "b7",
    expected: { verdict: "fail", requiredBumps: [], missingEnv: [], unmet: ["/v9/ghost"] },
  },
];

function git(workingDir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: workingDir, env: GIT_ISOLATION });
}

function commitAll(workingDir: string, message: string): void {
  git(workingDir, "add", "-A");
  git(workingDir, "commit", "-m", message);
}

function buildServiceRepo(parentDir: string, repoName: string, variants: ServiceVariant[], extraFiles: Record<string, string>): string {
  const repoDir = join(parentDir, repoName);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), `# ${repoName}\n\nSkein e2e fixture service.\n`);
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(join(repoDir, path, ".."), { recursive: true });
    writeFileSync(join(repoDir, path), content);
  }
  commitAll(repoDir, "initial");
  for (const variant of variants) {
    for (const [path, content] of Object.entries(variant.files)) {
      mkdirSync(join(repoDir, path, ".."), { recursive: true });
      writeFileSync(join(repoDir, path), content);
    }
    commitAll(repoDir, variant.tag);
    git(repoDir, "tag", variant.tag);
  }
  return repoDir;
}

type FixtureWorld = {
  rootDir: string;
  apiADir: string;
  apiBDir: string;
  valuesDir: string;
};

function buildWorld(): FixtureWorld {
  const rootDir = mkdtempSync(join(tmpdir(), "skein-e2e-"));
  const apiADir = buildServiceRepo(rootDir, "api-a", API_A_VARIANTS, {});
  const apiBDir = buildServiceRepo(rootDir, "api-b", API_B_VARIANTS, {});
  const apiBVariants = ["b3", ...SCENARIOS.map((scenario) => scenario.bumpedTag)];
  // b3-cosmetic: same code as b3, README-only change on top.
  writeFileSync(join(apiBDir, "README.md"), "# api-b\n\nSkein e2e fixture service. Cosmetic release note.\n");
  commitAll(apiBDir, "cosmetic");
  git(apiBDir, "tag", "b3-cosmetic");

  const valuesDir = join(rootDir, "values");
  mkdirSync(join(valuesDir, "env/prod"), { recursive: true });
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
  git(valuesDir, "init", "-b", "main");
  writeFileSync(join(valuesDir, "env/prod/a.yaml"), "tag: a1\n");
  writeFileSync(join(valuesDir, "env/prod/b.yaml"), `tag: ${apiBVariants[0]}\n`);
  commitAll(valuesDir, "initial pins");
  void apiBVariants;
  return { rootDir, apiADir, apiBDir, valuesDir };
}

function bumpValue(world: FixtureWorld, tag: string): { baseSha: string; headSha: string } {
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: world.valuesDir }).toString().trim();
  writeFileSync(join(world.valuesDir, "env/prod/b.yaml"), `tag: ${tag}\n`);
  commitAll(world.valuesDir, `bump api-b to ${tag}`);
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: world.valuesDir }).toString().trim();
  return { baseSha, headSha };
}

function buildDeps(world: FixtureWorld, baseSha: string, headSha: string, commentFile: string): PipelineDeps {
  return {
    settings: { mode: "advisory", model: MODEL, concurrency: 4, maxCostUsd: 2, configPath: "skein.yaml" },
    readConfigFile: () => Promise.resolve(execFileSync("git", ["show", `${headSha}:skein.yaml`], { cwd: world.valuesDir, env: GIT_ISOLATION }).toString()),
    valuesDir: world.valuesDir,
    baseSha,
    headSha,
    prNumber: 0,
    repoUrlFor: (service: string) => (service === "api-a" ? world.apiADir : world.apiBDir),
    cloneFactory: (repoUrl: string, token: string) => {
      void token;
      return bloblessClone(repoUrl, "", mkdtempSync(join(tmpdir(), "skein-e2e-clone-")));
    },
    anthropicFactory: () => {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
      return {
        createMessage: async (input: unknown) => {
          const response = await client.messages.create(input as Parameters<typeof client.messages.create>[0]);
          return {
            content: response.content.map((block) => ({ type: block.type, text: block.type === "text" ? block.text : undefined })),
            usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
          };
        },
      };
    },
    commentApi: {
      listComments: async () => [],
      updateComment: async () => {},
      createComment: async (prNumber: number, body: string) => {
        void prNumber;
        writeFileSync(commentFile, body);
      },
    },
  };
}

function matches(actual: unknown[], expected: unknown[], label: string): string[] {
  const problems: string[] = [];
  if (actual.length !== expected.length) {
    problems.push(`${label}: expected ${expected.length} entries, got ${actual.length} (${JSON.stringify(actual)})`);
  }
  return problems;
}

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("run-local: ANTHROPIC_API_KEY is required (real extraction calls)");
    return 1;
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const world = buildWorld();
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  try {
    for (const scenario of SCENARIOS) {
      const { baseSha, headSha } = bumpValue(world, scenario.bumpedTag);
      const commentFile = join(OUTPUT_DIR, `${scenario.name}.comment.md`);
      const outcome = await runPipeline(buildDeps(world, baseSha, headSha, commentFile));
      const problems = [
        ...matches(outcome.bumps ?? [], scenario.expected.requiredBumps, "bumps"),
        ...matches(outcome.missingEnv ?? [], scenario.expected.missingEnv, "missingEnv"),
        ...matches(outcome.unmet ?? [], scenario.expected.unmet, "unmet"),
      ];
      if (outcome.verdict !== scenario.expected.verdict) {
        problems.push(`verdict: expected ${scenario.expected.verdict}, got ${outcome.verdict}`);
      }
      const expectedBumps = scenario.expected.requiredBumps;
      for (const expectedBump of expectedBumps) {
        const found = (outcome.bumps ?? []).some(
          (bump) => bump.service === expectedBump.service && bump.from === expectedBump.from && bump.to === expectedBump.to
        );
        if (!found) problems.push(`requiredBumps: missing ${expectedBump.service} ${expectedBump.from}->${expectedBump.to}`);
      }
      for (const envName of scenario.expected.missingEnv) {
        if (!(outcome.missingEnv ?? []).some((entry) => entry.env === envName)) problems.push(`missingEnv: ${envName} not reported`);
      }
      for (const detail of scenario.expected.unmet) {
        if (!outcome.report.includes(detail)) problems.push(`unmet: ${detail} not reported in the PR comment`);
      }
      const passed = problems.length === 0;
      if (!passed) failures += 1;
      results.push({ scenario: scenario.name, expected: scenario.expected, verdict: outcome.verdict, exitCode: outcome.exitCode, problems, passed });
      console.log(`${passed ? "PASS" : "FAIL"} ${scenario.name} — verdict=${outcome.verdict} exit=${outcome.exitCode}${passed ? "" : ` problems=${JSON.stringify(problems)}`}`);
    }
  } finally {
    writeFileSync(join(OUTPUT_DIR, "scenarios.json"), JSON.stringify(results, null, 2));
    rmSync(world.rootDir, { recursive: true, force: true });
  }
  console.log(`run-local: ${results.length - failures}/${results.length} scenarios matched expectation → ${join(OUTPUT_DIR, "scenarios.json")}`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
