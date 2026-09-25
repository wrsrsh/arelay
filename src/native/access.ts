import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config.js";

export const nativeTokenPath = () => join(paths().dir, "native-token");
export async function readNativeToken(): Promise<string> {
  const info = await lstat(nativeTokenPath()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          "Native delegation is not configured. Run arelay setup, then start its service.",
        );
      throw error;
    },
  );
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error(
      "Native service key must be a private regular file (mode 600)",
    );
  const token = (await readFile(nativeTokenPath(), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Invalid native service key; preserve it and repair the local installation",
    );
  return token;
}
export async function ensureNativeToken(): Promise<string> {
  await mkdir(paths().dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(nativeTokenPath(), randomBytes(32).toString("hex") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readNativeToken();
}
export function nativeAuthorized(
  header: string | undefined,
  token: string | undefined,
): boolean {
  if (!header || !token) return false;
  const actual = Buffer.from(header),
    expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
