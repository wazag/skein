// src/index.ts
import * as core from "@actions/core";

export async function run(): Promise<void> {
  core.info("skein: pipeline not yet wired");
}

// Only execute when invoked as an action, not when imported by tests.
if (process.env.SKEIN_ACTION_ENTRY === "1") {
  void run();
}
