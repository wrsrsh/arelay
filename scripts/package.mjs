import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const stage = await mkdtemp(join(tmpdir(), "arelay-package-"));
const files = {
  "arelay.mjs": "dist/arelay.mjs",
  LICENSE: "LICENSE",
  "README.md": "README.md",
  "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
  "LICENSE.openai-codex": "vendor/LICENSE.openai-codex",
};
try {
  for (const [name, source] of Object.entries(files))
    await copyFile(source, join(stage, name));
  execFileSync(
    "tar",
    ["-czf", resolve("dist/arelay.tar.gz"), "-C", stage, ...Object.keys(files)],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  const hash = createHash("sha256")
    .update(await readFile("dist/arelay.tar.gz"))
    .digest("hex");
  await writeFile("dist/SHA256SUMS", `${hash}  arelay.tar.gz\n`);
  console.log(`Packaged dist/arelay.tar.gz (${hash})`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
