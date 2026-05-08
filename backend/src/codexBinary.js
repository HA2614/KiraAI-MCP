import fs from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export async function resolveCodexBinary() {
  if (config.codexBin && fs.existsSync(config.codexBin)) {
    return config.codexBin;
  }

  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || "";
    const extRoot = path.join(userProfile, ".vscode", "extensions");
    try {
      const entries = await readdir(extRoot, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
        .map((entry) => path.join(extRoot, entry.name, "bin", "windows-x86_64", "codex.exe"))
        .filter((candidate) => fs.existsSync(candidate));
      const withStats = await Promise.all(
        candidates.map(async (candidate) => ({ candidate, stats: await stat(candidate).catch(() => null) }))
      );
      const newest = withStats
        .filter((item) => item.stats)
        .sort((a, b) => Number(b.stats.mtimeMs || 0) - Number(a.stats.mtimeMs || 0))[0];
      if (newest) return newest.candidate;
    } catch {
      // Fall through to PATH lookup.
    }
  }

  return "codex";
}
