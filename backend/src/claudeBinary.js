import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export async function resolveClaudeBinary() {
  const configured = config.claudeBin || "claude";
  if (configured && configured !== "claude" && fs.existsSync(configured)) return configured;

  const binName = process.platform === "win32" ? "claude.cmd" : "claude";
  const candidates = [
    path.join(repoRoot, "node_modules", ".bin", binName),
    path.join(repoRoot, "..", "node_modules", ".bin", binName),
    path.join(process.cwd(), "node_modules", ".bin", binName)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return configured;
}
