// tests/index-import.test.ts — pins the run-on-import entry contract: importing the action
// entry module must never perform real I/O outside the runner. @actions/core and
// @actions/github are mocked, so the module-level void run() resolves entirely through
// stubs — no Octokit construction, no network, and no process.exitCode poisoning.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  getOctokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn(() => ""),
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: mocks.setFailed,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: { payload: {}, repo: { owner: "octo", repo: "values" }, sha: "deadbeef" },
  getOctokit: mocks.getOctokit,
}));

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("src/index run-on-import", () => {
  it("starts on import, does no real I/O, and fails message-only when credentials are absent", async () => {
    await import("../src/index");
    await flushAsyncWork();
    expect(mocks.setFailed).toHaveBeenCalledTimes(1);
    expect(typeof mocks.setFailed.mock.calls[0]?.[0]).toBe("string"); // message only, never an error object
    expect(mocks.getOctokit).not.toHaveBeenCalled(); // auth resolution fails before any octokit is built
  });
});
