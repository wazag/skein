import { describe, expect, it, vi } from "vitest";
import { verifyClaims } from "../src/verify";
import type { Claim } from "../src/extract";

// New-file numbering for the hunk below: line 10 = load(), 11 = the added fetch, 12 = return.
const CLIENT_DIFF = [
  "diff --git a/src/client.ts b/src/client.ts",
  "@@ -10,3 +10,4 @@", // 3 old lines / 4 new lines — matches the hunk body below
  " async function load() {",
  "+  const response = await fetch('/v2/orders');",
  "   return response;",
  " }",
].join("\n");

const CONFIG_FILE = "1\n2\nconst base = process.env.ORDERS_URL;\n";

const REMOVAL_DIFF = [
  "diff --git a/src/legacy.ts b/src/legacy.ts",
  "@@ -4,2 +4,1 @@", // two old lines collapse to one: the addition lands on new-file line 4
  "-callLegacy('/v1/a');",
  "-callLegacy('/v1/b');",
  "+callOrders('/v2/orders');",
].join("\n");

// Two hunks in one file: the second must restart the new-file counter at its own start line.
const MULTI_HUNK_DIFF = [
  "diff --git a/src/worker.ts b/src/worker.ts",
  "@@ -2,2 +2,3 @@",
  " first();",
  "+second();",
  " third();",
  "@@ -20,2 +21,3 @@",
  " twentieth();",
  "+twentyFirst();",
  " twentySecond();",
].join("\n");

// Real `git diff` output carries ---/+++ metadata between the file header and the first hunk;
// those lines must never satisfy a citation, and must not leak a stale line number across files.
const METADATA_LINES_DIFF = [
  "diff --git a/src/first.ts b/src/first.ts",
  "--- a/src/first.ts",
  "+++ b/src/first.ts",
  "@@ -1,2 +1,3 @@",
  " lead()",
  "+tail()",
  "diff --git a/src/second.ts b/src/second.ts",
  "--- a/src/second.ts",
  "+++ b/src/second.ts",
  "@@ -4,2 +4,3 @@",
  " lead()",
  "+tail()",
].join("\n");

function claimCiting(file: string, line: number, detail: string): Claim {
  return { kind: "endpoint", detail, direction: "calls", citation: { file, line } };
}

function envClaimCiting(file: string, line: number, detail: string): Claim {
  return { kind: "env", detail, direction: "reads", citation: { file, line } };
}

function fileReader(files: Record<string, string>) {
  return async (file: string) => files[file];
}

describe("verifyClaims", () => {
  it("verifies a claim whose citation lands on a line the diff adds", async () => {
    const claim = claimCiting("src/client.ts", 11, "/v2/orders");
    const readFile = vi.fn(fileReader({}));
    const result = await verifyClaims([claim], CLIENT_DIFF, readFile);
    expect(result.verified).toEqual([claim]);
    expect(result.dropped).toEqual([]);
  });

  it("does not consult the repo file when the diff already verifies the claim", async () => {
    const readFile = vi.fn(fileReader({}));
    await verifyClaims([claimCiting("src/client.ts", 11, "/v2/orders")], CLIENT_DIFF, readFile);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("verifies a claim from a file absent from the diff when the repo file has the detail on the cited line", async () => {
    const claim = envClaimCiting("src/config.ts", 3, "ORDERS_URL");
    const result = await verifyClaims([claim], CLIENT_DIFF, fileReader({ "src/config.ts": CONFIG_FILE }));
    expect(result.verified).toEqual([claim]);
    expect(result.dropped).toEqual([]);
  });

  it("matches a multi-token detail by its last path fragment in the repo file", async () => {
    const claim = claimCiting("src/routes.ts", 1, "GET /v2/orders");
    const result = await verifyClaims(
      [claim],
      CLIENT_DIFF,
      fileReader({ "src/routes.ts": "const path = '/v2/orders';\n" }),
    );
    expect(result.verified).toEqual([claim]);
  });

  it("drops a claim citing a context line rather than an added line", async () => {
    const claim = claimCiting("src/client.ts", 12, "/v2/orders");
    const result = await verifyClaims([claim], CLIENT_DIFF, fileReader({}));
    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reason: expect.stringContaining("src/client.ts:12") }]);
  });

  it("places an added line at its new-file position even after preceding removals", async () => {
    const claim = claimCiting("src/legacy.ts", 4, "/v2/orders");
    const result = await verifyClaims([claim], REMOVAL_DIFF, fileReader({}));
    expect(result.verified).toEqual([claim]);
  });

  it("drops a claim citing a line that only the old revision had", async () => {
    const claim = claimCiting("src/legacy.ts", 5, "/v1/b");
    const result = await verifyClaims([claim], REMOVAL_DIFF, fileReader({}));
    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reason: expect.stringContaining("src/legacy.ts:5") }]);
  });

  it("restarts the new-file line counter at every hunk header", async () => {
    const claims = [
      claimCiting("src/worker.ts", 3, "second"),
      claimCiting("src/worker.ts", 22, "twentyFirst"),
    ];
    const result = await verifyClaims(claims, MULTI_HUNK_DIFF, fileReader({}));
    expect(result.verified).toEqual(claims);
    expect(result.dropped).toEqual([]);
  });

  it("never satisfies a citation with the ---/+++ file metadata lines", async () => {
    // src/first.ts leaves the counter at 3 when the second file starts; that stale number must
    // not survive via the '+++ b/src/second.ts' metadata line.
    const staleClaim = claimCiting("src/second.ts", 3, "lead");
    const addedClaim = claimCiting("src/second.ts", 5, "tail");
    const result = await verifyClaims([staleClaim, addedClaim], METADATA_LINES_DIFF, fileReader({}));
    expect(result.verified).toEqual([addedClaim]);
    expect(result.dropped).toEqual([{ claim: staleClaim, reason: expect.stringContaining("src/second.ts:3") }]);
  });

  it("drops a claim whose file is missing from both the diff and the repo, naming the citation", async () => {
    const claim = claimCiting("src/other.ts", 11, "/v2/orders");
    const result = await verifyClaims([claim], CLIENT_DIFF, fileReader({}));
    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reason: expect.stringContaining("src/other.ts") }]);
  });

  it("drops a claim when the file exists at the tag but the cited line omits the detail", async () => {
    const claim = envClaimCiting("src/config.ts", 2, "ORDERS_URL");
    const result = await verifyClaims([claim], CLIENT_DIFF, fileReader({ "src/config.ts": CONFIG_FILE }));
    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reason: expect.stringContaining("src/config.ts:2") }]);
  });

  it("drops a claim whose cited line is past the end of the repo file", async () => {
    const claim = envClaimCiting("src/config.ts", 9, "ORDERS_URL");
    const result = await verifyClaims([claim], CLIENT_DIFF, fileReader({ "src/config.ts": CONFIG_FILE }));
    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reason: expect.stringContaining("src/config.ts:9") }]);
  });

  it("keeps the input order across verified and dropped claims", async () => {
    const first = claimCiting("src/client.ts", 11, "/v2/orders");
    const second = claimCiting("src/missing.ts", 1, "/v2/orders");
    const third = claimCiting("src/client.ts", 11, "/v2/shipments");
    const result = await verifyClaims([first, second, third], CLIENT_DIFF, fileReader({}));
    expect(result.verified).toEqual([first, third]);
    expect(result.dropped.map((entry) => entry.claim)).toEqual([second]);
  });
});
