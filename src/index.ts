// src/index.ts
export async function run(): Promise<void> {}

// Only execute when invoked as an action, not when imported by tests.
if (process.env.SKEIN_ACTION_ENTRY === "1") {
  void run();
}
