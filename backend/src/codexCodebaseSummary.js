import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.js";
import { resolveCodexBinary } from "./codexBinary.js";
import { resolveSafePath } from "./structure.js";
import { ExternalServiceError } from "./errors.js";
import { createRunTimer } from "./performanceTiming.js";

const COMMON_IGNORES = [
  "node_modules/",
  "**/node_modules/**",
  ".git/",
  "dist/",
  "**/dist/**",
  "build/",
  "**/build/**",
  ".next/",
  ".cache/",
  "coverage/",
  "*.log",
  ".env",
  ".env.*",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "vendor/",
  "__pycache__/",
  "qa/node_modules/",
  "qa/reports/",
  "frontend/dist/"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTitle(text, fallback) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => l.startsWith("#"));
  if (heading) return heading.replace(/^#+\s*/, "").slice(0, 140);
  return (lines[0] || fallback).slice(0, 140);
}

function extractDescription(text, fallback) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.slice(0, 420);
}

async function readGitignoreHints(root) {
  const gitignorePath = path.join(root, ".gitignore");
  try {
    const raw = await readFile(gitignorePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .slice(0, 200);
  } catch {
    return [];
  }
}

function buildPrompt(ignorePatterns) {
  return [
    "Analyze the codebase in the current directory and return ONLY valid JSON (no markdown).",
    "Also suggest concrete function-level code improvements.",
    "",
    "JSON schema:",
    "{",
    '  "title": "string",',
    '  "projectDescription": "string",',
    '  "projectMetadata": {"name":"string","goals":"string","techStack":"string","detectedFrameworks":["string"],"productDescription":"string"},',
    '  "architectureOverview": ["string"],',
    '  "pipelineFlow": ["string"],',
    '  "files": [{"path":"string","role":"string","summary":"string"}],',
    '  "codeStyleObservations": ["string"],',
    '  "improvementSuggestions": [{"file":"string","function":"string","issue":"string","suggestion":"string","priority":"high|medium|low","followUpCriteria":"string"}]',
    "}",
    "",
    "Rules:",
    "- Mention only existing files.",
    "- Keep file summaries concise (1-2 lines).",
    "- improvementSuggestions must focus on concrete functions/methods.",
    "- projectMetadata should be suitable for creating a project record for this existing codebase.",
    "- codeStyleObservations should describe recurring code style, architecture, naming, state, and error-handling patterns.",
    "- followUpCriteria must make each improvement checkable during the next analysis.",
    "- Do not include dependency/generated files.",
    "- Ignore files matching patterns:",
    ...ignorePatterns.map((p) => `  - ${p}`)
  ].join("\n");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    return JSON.parse(slice);
  }
  throw new ExternalServiceError("Codex output was not valid JSON", null, "CODEX_SUMMARY_INVALID_JSON");
}

function validateAnalysisJson(analysisJson) {
  const title = String(analysisJson?.title || "").toLowerCase();
  const description = String(analysisJson?.projectDescription || "").toLowerCase();
  const files = Array.isArray(analysisJson?.files) ? analysisJson.files : [];
  const text = `${title} ${description}`;
  const blocked = [
    "analysis blocked",
    "analysis unavailable",
    "unable to access",
    "could not analyze",
    "could not inspect",
    "sandbox error",
    "bubblewrap",
    "bwrap"
  ].some((marker) => text.includes(marker));

  if (blocked || files.length === 0) {
    throw new ExternalServiceError(
      "Codex did not produce a real codebase analysis.",
      {
        title: analysisJson?.title || "",
        projectDescription: analysisJson?.projectDescription || "",
        fileCount: files.length
      },
      "CODEX_SUMMARY_INCOMPLETE"
    );
  }
}

function shouldKeepLogLine(line) {
  const text = String(line || "");
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  if ([
    "postgresql://",
    "database_url",
    "postgres",
    "psql",
    "pg_",
    "redis",
    "node_modules",
    "docker compose",
    "schema applied",
    "migration"
  ].some((needle) => lower.includes(needle))) return false;
  if (lower.includes("startup remote plugin sync failed")) return false;
  if (lower.includes("failed to warm featured plugin ids cache")) return false;
  if (lower.includes("cloudflare")) return false;
  if (lower.includes("<html>")) return false;
  if (lower.includes("</html>")) return false;
  if (lower.includes("tokens used")) return false;
  if (lower.includes("enable javascript and cookies to continue")) return false;
  if (text.length > 2600) return false;
  return [
    "error",
    "failed",
    "fatal",
    "timed out",
    "timeout",
    "not found",
    "permission",
    "denied",
    "completed",
    "succeeded"
  ].some((needle) => lower.includes(needle));
}

export async function summarizeCodebaseWithCodex(targetPath, options = {}) {
  const onProgress = options.onProgress || null;
  const onLog = options.onLog || null;
  const root = resolveSafePath(targetPath);
  const timer = createRunTimer();

  const update = (progress, stage, message) => {
    if (onProgress) onProgress({ progress, stage, message });
  };
  const log = (source, line) => {
    if (!onLog) return;
    onLog({
      ts: new Date().toISOString(),
      source,
      line: String(line || "")
    });
  };

  timer.mark("prepare");
  update(5, "prepare", "Preparing KiraAI analysis");
  const gitignorePatterns = await readGitignoreHints(root);
  const prompt = buildPrompt([...COMMON_IGNORES, ...gitignorePatterns]);

  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-codebase-summary-"));
  const outputFile = path.join(tempDir, "summary.md");

  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    config.codexSummarySandbox,
    "exec",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile
  ];
  if (config.codexSummaryModel) {
    args.push("--model", config.codexSummaryModel);
  }
  args.push(prompt);

  const codexBin = await resolveCodexBinary();
  if (!codexBin) {
    throw new ExternalServiceError(
      "Codex CLI is required for analyzer but was not found. Set CODEX_BIN or install @openai/codex.",
      null,
      "CODEX_CLI_NOT_FOUND"
    );
  }
  timer.mark("codex_cli", {
    model: config.codexSummaryModel,
    sandbox: config.codexSummarySandbox
  });
  update(15, "run", "Launching KiraAI analysis engine");

  let progressLoopActive = true;
  const progressLoop = (async () => {
    let p = 20;
    while (progressLoopActive) {
      update(p, "run", "KiraAI is analyzing codebase files");
      p = Math.min(90, p + 2);
      await sleep(700);
    }
  })();

  await new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      log("system", `KiraAI analysis timed out after ${config.codexTimeoutMs}ms; stopping process.`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000).unref();
    }, config.codexTimeoutMs);

    const flushLines = (source, chunk) => {
      const text = chunk.toString();
      const parts = text.split(/\r?\n/).filter((p) => p.trim().length > 0);
      for (const part of parts) {
        if (!shouldKeepLogLine(part)) continue;
        const compact = part.length > 260 ? `${part.slice(0, 257)}...` : part;
        log(source, compact);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      flushLines("stdout", chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      flushLines("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      settled = true;
      if (timedOut) {
        reject(
          new ExternalServiceError(
            `KiraAI summary timed out after ${config.codexTimeoutMs}ms`,
            { stderr: stderr.trim(), stdout: stdout.trim() },
            "CODEX_SUMMARY_TIMEOUT"
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ExternalServiceError(
          `KiraAI summary failed (code ${code})`,
          { stderr: stderr.trim(), stdout: stdout.trim() },
          "CODEX_SUMMARY_NON_ZERO"
        )
      );
    });
  }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new ExternalServiceError(
        `Codex CLI is required but could not be spawned: ${error.message}`,
        null,
        "CODEX_CLI_NOT_FOUND"
      );
    }
    if (error instanceof ExternalServiceError) {
      throw error;
    }
    throw new ExternalServiceError(error.message, null, "CODEX_SUMMARY_PROCESS_ERROR");
  }).finally(async () => {
    progressLoopActive = false;
    await progressLoop;
  });

  if (!fs.existsSync(outputFile)) {
    await rm(tempDir, { recursive: true, force: true });
    throw new ExternalServiceError("Codex CLI produced no output file", null, "CODEX_SUMMARY_NO_OUTPUT");
  }

  timer.mark("parse_validate_output");
  update(95, "finalize", "Reading KiraAI output");
  try {
    const fullReportRaw = await readFile(outputFile, "utf8");
    const analysisJson = extractJsonObject(fullReportRaw);
    validateAnalysisJson(analysisJson);
    const fullReport = JSON.stringify(analysisJson, null, 2);
    const title = extractTitle(analysisJson.title, `${path.basename(root)} Codebase Analysis`);
    const description = extractDescription(analysisJson.projectDescription, "Codebase analysis completed.");

    update(100, "done", "Analysis completed");
    const finished = timer.finish("done", {
      ignorePatternCount: COMMON_IGNORES.length + gitignorePatterns.length
    });
    return {
      root,
      title,
      description,
      model: config.codexSummaryModel,
      fullReport,
      analysisJson,
      ignorePatternsUsed: [...COMMON_IGNORES, ...gitignorePatterns],
      startedAt: finished.startedAt,
      finishedAt: finished.finishedAt,
      durationMs: finished.durationMs,
      stageTimings: finished.stageTimings
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
