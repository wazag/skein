// src/index.ts — GitHub Action entry point. Builds the real PipelineDeps (octokit, Anthropic
// SDK, blobless clones, PR comment API) and runs the pipeline. GitHub's node24 runner imports
// dist/index.js and expects the action to run at import — no env-var entry guard exists.
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";
import Anthropic from "@anthropic-ai/sdk";
import { loadRunSettings, SkeinConfigError } from "./config";
import { resolveToken } from "./auth";
import { bloblessClone } from "./git";
import { REPORT_MARKER } from "./comment";
import type { AnthropicClient } from "./extract";
import { runPipeline, type PipelineDeps } from "./pipeline";

type PullRequestContext = { number: number; base: { sha: string }; head: { sha: string } };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Thin shim over the installed SDK: messages.create mapped onto AnthropicClient.createMessage,
// content blocks and usage extracted into the minimal shape. No retry logic in v1.
function anthropicClientFactory(apiKey: string): () => AnthropicClient {
  const client = new Anthropic(apiKey === "" ? undefined : { apiKey });
  return () => ({
    createMessage: async (input: unknown) => {
      const response = await client.messages.create(input as Anthropic.MessageCreateParamsNonStreaming);
      return {
        content: response.content.map((part) =>
          part.type === "text" ? { type: part.type, text: part.text } : { type: part.type },
        ),
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      };
    },
  });
}

async function run(): Promise<void> {
  try {
    const anthropicKey = core.getInput("anthropic-api-key") || process.env.ANTHROPIC_API_KEY || "";
    if (anthropicKey !== "") core.setSecret(anthropicKey);
    const token = await resolveToken({
      githubToken: core.getInput("github-token"),
      appId: core.getInput("app-id"),
      appPrivateKey: core.getInput("app-private-key"),
      createInstallationToken: async (appId, privateKey) =>
        (await createAppAuth({ appId, privateKey })({ type: "installation" })).token,
    });
    core.setSecret(token);
    const octokit = getOctokit(token);

    const pullRequest = context.payload.pull_request as PullRequestContext | undefined;
    if (pullRequest === undefined) {
      core.setFailed("skein: no pull_request context — run on pull_request paths touching values files");
      return;
    }
    const repo = context.repo;
    const settings = loadRunSettings(core.getInput);

    const deps: PipelineDeps = {
      settings,
      gitToken: token,
      // repos.getContent returns base64; a directory listing arrives as an array of entries —
      // the config path must be a file, so both non-file shapes are rejected.
      readConfigFile: async () => {
        const response = await octokit.rest.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: settings.configPath,
          ref: context.sha,
        });
        if (Array.isArray(response.data)) {
          throw new SkeinConfigError(`config path '${settings.configPath}' is a directory, not a file`);
        }
        const file = response.data as { type?: string; content?: string; encoding?: string };
        if (file.type !== "file" || typeof file.content !== "string" || file.encoding !== "base64") {
          throw new SkeinConfigError(`config '${settings.configPath}' did not return base64 file content`);
        }
        return Buffer.from(file.content, "base64").toString("utf8");
      },
      valuesDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      prNumber: pullRequest.number,
      repoUrlFor: (repoSpec) => `https://github.com/${repoSpec}`,
      cloneFactory: (repoUrl, cloneToken, targetDir) => bloblessClone(repoUrl, cloneToken, targetDir),
      anthropicFactory: anthropicClientFactory(anthropicKey),
      commentApi: {
        // upsertComment matches by includes(REPORT_MARKER); a reply quoting the marker would
        // collide. Filter the listing to comments that START with the marker, so only the
        // true report comment can ever be the match upsertComment finds.
        listComments: async (prNumber) => {
          const listed = await octokit.rest.issues.listComments({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: prNumber,
          });
          return listed.data
            .filter((comment) => (comment.body ?? "").startsWith(REPORT_MARKER))
            .map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
        },
        updateComment: async (commentId, body) => {
          await octokit.rest.issues.updateComment({ owner: repo.owner, repo: repo.repo, comment_id: commentId, body });
        },
        createComment: async (prNumber, body) => {
          await octokit.rest.issues.createComment({ owner: repo.owner, repo: repo.repo, issue_number: prNumber, body });
        },
      },
    };

    const outcome = await runPipeline(deps);
    core.setOutput("verdict", outcome.verdict);
    core.setOutput("report", outcome.report);
    core.setOutput("required-bumps", JSON.stringify(outcome.bumps ?? []));
    core.setOutput("missing-env", JSON.stringify(outcome.missingEnv ?? []));
    core.setOutput("cost-usd", outcome.costUsd === undefined ? "0" : outcome.costUsd.toFixed(3));
    if (outcome.exitCode !== 0) {
      core.setFailed(`skein ${outcome.verdict}${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`);
    }
  } catch (error) {
    // Message only — never log the error object: GitRepoError's cause chain can carry the raw token.
    core.setFailed(`skein: ${messageOf(error)}`);
  }
}

// The runner imports this module and expects the action to start: run unconditionally.
void run();
