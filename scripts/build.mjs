import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import { writeBundleNotices } from "./bundle-notices.mjs";
await mkdir("dist", { recursive: true });
const result = await build({
  metafile: true,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/arelay.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/arelay.mjs", 0o755);
await writeBundleNotices(result.metafile.inputs);
