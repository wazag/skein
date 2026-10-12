// esbuild.mjs
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/index.js",
  sourcemap: false,
  legalComments: "none",
});
