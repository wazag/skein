import { describe, expect, it, vi } from "vitest";
import { CostCeilingExceeded, runCostTracker, type ModelPrice } from "../src/cost";
import { extractClaims } from "../src/extract";

const MODEL_ID = "claude-sonnet-5";
const MODEL_PRICE_PER_MTOK: ModelPrice = { input: 3, output: 15 }; // claude-sonnet-5 list price, USD per 1M tokens
const validClaims = [
  {
    kind: "endpoint",
    detail: "GET /v2/orders",
    direction: "calls",
    citation: { file: "src/client.ts", line: 12 },
  },
];

function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 1000, output_tokens: 100 },
  };
}

function fakeAnthropic(claims: unknown) {
  return { createMessage: vi.fn().mockResolvedValue(textResponse(JSON.stringify(claims))) };
}

function multiFileDiff(fileCount: number, linesPerFile: number): string {
  return Array.from(
    { length: fileCount },
    (_, fileIndex) =>
      `diff --git a/f${fileIndex}.ts b/f${fileIndex}.ts\n` +
      Array.from({ length: linesPerFile }, (_, lineIndex) => `+line ${lineIndex} fetch('/v9/x${fileIndex}')`).join("\n"),
  ).join("\n");
}

describe("extractClaims", () => {
  it("returns schema-validated claims", async () => {
    const claims = await extractClaims(MODEL_ID, "diff --git a/x b/x\n+fetch('/v2/orders')", "api-b", fakeAnthropic(validClaims));
    expect(claims).toEqual(validClaims);
  });

  it("drops invalid claims instead of throwing", async () => {
    const badClaims = [...validClaims, { kind: "mystery", detail: "x", direction: "calls", citation: { file: "a", line: 1 } }];
    const claims = await extractClaims(MODEL_ID, "diff", "api-b", fakeAnthropic(badClaims));
    expect(claims).toEqual(validClaims);
  });

  it("splits oversized diffs into per-file chunks and merges claims", async () => {
    // 40 files x 101 lines = 4040 lines → >1500 → multiple ≤1500-line chunks.
    const anthropic = fakeAnthropic([validClaims[0]]);
    const claims = await extractClaims(MODEL_ID, multiFileDiff(40, 100), "api-b", anthropic);
    expect(anthropic.createMessage.mock.calls.length).toBeGreaterThan(1);
    expect(claims).toEqual(Array.from({ length: anthropic.createMessage.mock.calls.length }, () => validClaims[0]));
  });

  it("survives a chunk returning non-JSON and keeps other chunks' claims", async () => {
    // 2 files x 801 lines = 1602 lines → two chunks; the first one replies with prose.
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(textResponse("I cannot parse"))
      .mockResolvedValueOnce(textResponse(JSON.stringify(validClaims)));
    const claims = await extractClaims(MODEL_ID, multiFileDiff(2, 800), "api-b", { createMessage });
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(claims).toEqual(validClaims);
  });

  it("accepts claims wrapped in markdown fences or leading prose", async () => {
    const fenced = "```json\n" + JSON.stringify(validClaims, null, 2) + "\n```";
    const prosed = "Here are the claims:\n" + JSON.stringify(validClaims);
    for (const response of [fenced, prosed]) {
      const anthropic = fakeAnthropic([]);
      anthropic.createMessage.mockResolvedValueOnce(textResponse(response));
      const claims = await extractClaims(MODEL_ID, "diff --git a/x b/x\n+fetch('/v2/orders')", "api-b", anthropic);
      expect(claims).toEqual(validClaims);
    }
  });

  it("normalizes flat-shaped claims (name/file/line at top level) to canonical", async () => {
    const flat = [
      { kind: "endpoint", direction: "calls", name: "/v2/orders", file: "src/client.ts", line: 3 },
      { kind: "env", direction: "reads", detail: "ORDERS_V2_URL", file: "src/config.ts", line: 1 },
      { kind: "mystery", direction: "calls", name: "x", file: "a", line: 1 },
    ];
    const anthropic = fakeAnthropic([]);
    anthropic.createMessage.mockResolvedValueOnce(textResponse(JSON.stringify(flat)));
    const claims = await extractClaims(MODEL_ID, "diff --git a/x b/x\n+fetch('/v2/orders')", "api-b", anthropic);
    expect(claims).toEqual([
      { kind: "endpoint", detail: "/v2/orders", direction: "calls", citation: { file: "src/client.ts", line: 3 } },
      { kind: "env", detail: "ORDERS_V2_URL", direction: "reads", citation: { file: "src/config.ts", line: 1 } },
    ]);
  });
});

describe("runCostTracker", () => {
  it("accumulates spend from usage and throws at ceiling", () => {
    const tracker = runCostTracker(50);
    const hugeUsage = { input_tokens: 10_000_000, output_tokens: 1_000_000 }; // 10M in / 1M out → $45
    expect(() => tracker.add(hugeUsage, MODEL_PRICE_PER_MTOK)).not.toThrow();
    expect(tracker.spentUsd()).toBeCloseTo(45, 10);
    expect(() => tracker.add(hugeUsage, MODEL_PRICE_PER_MTOK)).toThrow(CostCeilingExceeded); // $90 > $50
    expect(tracker.spentUsd()).toBeCloseTo(90, 10);
  });

  it("reports the spend that breached the ceiling", () => {
    const tracker = runCostTracker(10);
    try {
      tracker.add({ input_tokens: 10_000_000, output_tokens: 0 }, MODEL_PRICE_PER_MTOK); // $30 > $10
      expect.unreachable("add should have thrown CostCeilingExceeded");
    } catch (error) {
      expect(error).toBeInstanceOf(CostCeilingExceeded);
      expect((error as CostCeilingExceeded).spentUsd).toBeCloseTo(30, 10);
    }
  });
});
