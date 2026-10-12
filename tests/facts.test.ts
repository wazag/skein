import { describe, expect, it } from "vitest";
import { harvestFacts, type ProviderFacts } from "../src/facts";

const REPO_FILES = ["src/routes.ts", "src/worker.ts", "README.md", "node_modules/pkg/index.js"];

const FILE_CONTENTS: Record<string, string> = {
  "src/routes.ts": [
    'app.get("/v1/orders", handler);',
    "const ordersUrl = process.env.ORDERS_URL;",
    'const maxRetries = os.environ["MAX_RETRIES"];',
    'const pageLimit = os.environ.get("PAGE_LIMIT");',
    'const featureFlags = ENV["FEATURE_FLAG"];',
    'app.get("/health", handler);',
  ].join("\n"),
  "src/worker.ts":
    'const queueName = "orders-task-queue"; taskQueue.register(queueName); const mode = os.getenv("WORKER_MODE");',
  "README.md": 'See `/docs` for endpoints. Not code. ENV["SECRET_PROSE"] here is prose.',
  "node_modules/pkg/index.js": 'app.get("/v1/vendor", handler); const token = process.env.VENDOR_TOKEN;',
};

async function harvestFixtureFacts(): Promise<ProviderFacts> {
  return harvestFacts(
    (file) => Promise.resolve(FILE_CONTENTS[file] ?? ""),
    () => Promise.resolve(REPO_FILES),
  );
}

describe("harvestFacts", () => {
  it("collects quoted endpoints with at least two path segments", async () => {
    const facts = await harvestFixtureFacts();
    expect(facts.endpoints).toEqual(["/v1/orders"]);
  });

  it("collects env vars from process.env, os.environ, os.environ.get, os.getenv, and ENV bracket access", async () => {
    const facts = await harvestFixtureFacts();
    expect(facts.envVars).toEqual(["ORDERS_URL", "MAX_RETRIES", "PAGE_LIMIT", "FEATURE_FLAG", "WORKER_MODE"]);
  });

  it("collects queue-name literals that share a line with a taskQueue reference", async () => {
    const facts = await harvestFixtureFacts();
    expect(facts.queueNames).toEqual(["orders-task-queue"]);
  });

  it("reads only code files, excluding prose and vendored directories", async () => {
    const facts = await harvestFixtureFacts();
    expect(facts.files).toEqual(["src/routes.ts", "src/worker.ts"]);
    expect(facts.envVars).not.toContain("SECRET_PROSE");
    expect(facts.envVars).not.toContain("VENDOR_TOKEN");
    expect(facts.endpoints).not.toContain("/docs");
    expect(facts.endpoints).not.toContain("/v1/vendor");
  });
});
