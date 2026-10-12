// tests/smoke.test.ts
import { describe, expect, it } from "vitest";
import { run } from "../src/index";

describe("scaffold", () => {
  it("runs without throwing", async () => {
    await expect(run()).resolves.toBeUndefined();
  });
});
