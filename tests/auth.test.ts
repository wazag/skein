import { describe, expect, it, vi } from "vitest";
import { AuthConfigError, resolveToken } from "../src/auth";

describe("resolveToken", () => {
  it("prefers an explicit github-token", async () => {
    const createInstallationToken = vi.fn();
    const token = await resolveToken({ githubToken: "pat-1", appId: "1", appPrivateKey: "k", createInstallationToken });
    expect(token).toBe("pat-1");
    expect(createInstallationToken).not.toHaveBeenCalled();
  });

  it("exchanges app credentials for an installation token", async () => {
    const createInstallationToken = vi.fn().mockResolvedValue("installation-token");
    const token = await resolveToken({ appId: "123", appPrivateKey: "-----BEGIN", createInstallationToken });
    expect(token).toBe("installation-token");
  });

  it("throws a helpful error when neither credential is supplied", async () => {
    await expect(resolveToken({})).rejects.toThrow(AuthConfigError);
    await expect(resolveToken({})).rejects.toThrow(/github-token|app-id/);
  });

  it("treats an empty-string github-token as absent and uses the app exchange", async () => {
    const createInstallationToken = vi.fn().mockResolvedValue("installation-token");
    const token = await resolveToken({ githubToken: "", appId: "123", appPrivateKey: "-----BEGIN", createInstallationToken });
    expect(token).toBe("installation-token");
    expect(createInstallationToken).toHaveBeenCalledWith("123", "-----BEGIN");
  });
});
