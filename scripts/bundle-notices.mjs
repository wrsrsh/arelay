import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function writeBundleNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes("node_modules/")) continue;
    let dir = dirname(resolve(input));
    for (;;) {
      try {
        const pkg = JSON.parse(
          await readFile(join(dir, "package.json"), "utf8"),
        );
        if (pkg.name && pkg.version) {
          packages.set(`${pkg.name}@${pkg.version}`, dir);
          break;
        }
      } catch {
        /* Walk to the actual package root. */
      }
      const parent = dirname(dir);
      if (parent === dir)
        throw new Error(`Cannot identify bundled dependency: ${input}`);
      dir = parent;
    }
  }
  let notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  notice += "\n## Licenses of packages included in this release bundle\n";
  for (const [name, dir] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    let license;
    for (const filename of [
      "LICENSE",
      "license",
      "LICENSE.md",
      "license.md",
      "LICENSE.txt",
      "license.txt",
      "License",
      "LICENSE-MIT",
    ]) {
      try {
        license = await readFile(join(dir, filename), "utf8");
        break;
      } catch {
        /* Try alternate spelling. */
      }
    }
    if (!license)
      throw new Error(`Missing license for bundled dependency ${name}`);
    notice += `\n### ${name}\n\n\`\`\`text\n${license.trim()}\n\`\`\`\n`;
  }
  await writeFile("dist/THIRD_PARTY_NOTICES.md", notice);
}
