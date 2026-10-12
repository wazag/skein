import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const MAX_RUN_ERROR_DETAIL_LENGTH = 500;
const MAX_CLONE_ERROR_DETAIL_LENGTH = 300;

export class GitRepoError extends Error {}

function errorDetail(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || message).slice(0, MAX_RUN_ERROR_DETAIL_LENGTH);
}

async function run(repoDir: string, repoLabel: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoDir, maxBuffer: MAX_BUFFER_BYTES });
    return stdout;
  } catch (error) {
    throw new GitRepoError(`git ${args.join(" ")} failed in ${repoLabel}: ${errorDetail(error)}`, { cause: error });
  }
}

export type GitWorkdir = {
  diffTags(oldTag: string, newTag: string): Promise<string>;
  showFile(ref: string, file: string): Promise<string>;
  listTagsAsc(current: string): Promise<string[]>;
  listFiles(ref: string): Promise<string[]>;
  readFile(ref: string, file: string): Promise<string>;
};

export async function bloblessClone(repoUrl: string, token: string, targetDir: string): Promise<GitWorkdir> {
  const authenticatedUrl = token
    ? `https://x-access-token:${token}@${repoUrl.replace(/^https:\/\//, "")}`
    : repoUrl;
  try {
    await simpleGit().clone(authenticatedUrl, targetDir, ["--filter=blob:none", "--no-checkout"]);
  } catch (error) {
    const rawDetail = error instanceof Error ? error.message : String(error);
    // git echoes the remote URL (with embedded token) in clone failures — redact it.
    const detail = rawDetail.split(authenticatedUrl).join(repoUrl).slice(0, MAX_CLONE_ERROR_DETAIL_LENGTH);
    throw new GitRepoError(`clone failed for ${repoUrl}: ${detail}`, { cause: error });
  }
  const repoLabel = repoUrl;
  const requireTag = async (tag: string): Promise<void> => {
    const tags = (await run(targetDir, repoLabel, "tag", "--list")).split("\n").filter(Boolean);
    if (!tags.includes(tag)) {
      throw new GitRepoError(
        `repo ${repoLabel} has no tag '${tag}' — pin points nowhere; push the tag or fix skein.yaml/pins`
      );
    }
  };
  return {
    async diffTags(oldTag: string, newTag: string): Promise<string> {
      await requireTag(oldTag);
      await requireTag(newTag);
      return run(targetDir, repoLabel, "diff", `${oldTag}..${newTag}`, "--no-color");
    },
    async showFile(ref: string, file: string): Promise<string> {
      return run(targetDir, repoLabel, "show", `${ref}:${file}`);
    },
    async listTagsAsc(current: string): Promise<string[]> {
      const tags = (await run(targetDir, repoLabel, "tag", "--list", "--sort=version:refname"))
        .split("\n")
        .filter(Boolean);
      const currentIndex = tags.indexOf(current);
      return currentIndex === -1 ? tags : tags.slice(currentIndex);
    },
    async listFiles(ref: string): Promise<string[]> {
      return (await run(targetDir, repoLabel, "ls-tree", "-r", "--name-only", ref)).split("\n").filter(Boolean);
    },
    async readFile(ref: string, file: string): Promise<string> {
      return run(targetDir, repoLabel, "show", `${ref}:${file}`);
    },
  };
}

export async function valuesFileAtRef(valuesRepoDir: string, file: string, ref: string): Promise<string> {
  return run(valuesRepoDir, "values repo", "show", `${ref}:${file}`);
}
