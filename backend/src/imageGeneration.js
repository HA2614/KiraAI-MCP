import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { resolveCodexBinary } from "./codexBinary.js";
import { ExternalServiceError, ValidationError } from "./errors.js";

const VISUAL_PROMPT_PATTERN = /\b(wireframe|mockup|image|photo|screenshot|visual|logo|thumbnail|afbeelding|foto|plaatje|illustration|poster|banner)\b/i;
const CODEX_IMAGE_FILENAME = "kiraai-codex-image.svg";
const MAX_CODEX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

export function shouldGenerateImage({ prompt = "", responseMode = "auto" } = {}) {
  const mode = String(responseMode || "auto").toLowerCase();
  if (mode === "image") return true;
  if (mode === "code") return false;
  return VISUAL_PROMPT_PATTERN.test(String(prompt || ""));
}

export function resolveImageProvider(value = config.imageProvider) {
  const provider = String(value || "codex_cli").trim().toLowerCase();
  if (!provider || provider === "codex" || provider === "codex_cli") return "codex_cli";
  if (provider === "openai") return "codex_cli";
  return provider;
}

function normalizeImagePrompt(prompt) {
  const text = String(prompt || "").trim();
  const brandSafeText = text.replace(/\bshopify\b/gi, "generic ecommerce admin");
  return [
    brandSafeText,
    "",
    "Create a clean product design reference image only.",
    "If a brand is mentioned, do not use official logos, trademarks, or exact brand artwork.",
    "Use neutral placeholder content, realistic spacing, and clear UI hierarchy."
  ].join("\n");
}

function fakeImageAsset(prompt) {
  const title = String(prompt || "KiraAI image").trim().slice(0, 64) || "KiraAI image";
  const escaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#f7fafc"/>
  <rect x="112" y="104" width="800" height="816" rx="28" fill="#ffffff" stroke="#cbd5e1" stroke-width="4"/>
  <rect x="160" y="168" width="704" height="80" rx="18" fill="#0f766e"/>
  <rect x="160" y="300" width="304" height="220" rx="18" fill="#e2e8f0"/>
  <rect x="512" y="300" width="304" height="88" rx="18" fill="#d9f99d"/>
  <rect x="512" y="432" width="304" height="88" rx="18" fill="#bfdbfe"/>
  <rect x="160" y="584" width="656" height="44" rx="12" fill="#e2e8f0"/>
  <rect x="160" y="660" width="520" height="44" rx="12" fill="#e2e8f0"/>
  <rect x="160" y="780" width="208" height="64" rx="18" fill="#0f766e"/>
  <text x="512" y="214" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff">KiraAI Image Preview</text>
  <text x="512" y="724" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" fill="#334155">${escaped}</text>
</svg>`;
  return {
    assetType: "image",
    mimeType: "image/svg+xml",
    filename: "kiraai-generated-preview.svg",
    content: Buffer.from(svg, "utf8"),
    metadata: {
      provider: "fake",
      size: "1024x1024"
    }
  };
}

function parseImageSize(value) {
  const match = String(value || "").match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) return { width: 1024, height: 1024, label: "1024x1024" };
  const width = Math.max(256, Math.min(2048, Number(match[1])));
  const height = Math.max(256, Math.min(2048, Number(match[2])));
  return { width, height, label: `${width}x${height}` };
}

function appendLimited(current, chunk, limit = 8000) {
  const next = `${current}${chunk.toString()}`;
  return next.length > limit ? next.slice(-limit) : next;
}

function safePromptPreview(prompt, limit = 140) {
  return String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildCodexImagePrompt(prompt) {
  const size = parseImageSize(config.imageDefaultSize);
  return [
    "You are KiraAI image generation running inside Codex CLI.",
    "Return exactly one complete self-contained SVG document as your final answer.",
    `Use a ${size.width} by ${size.height} canvas.`,
    "The SVG should directly satisfy the user's request as a polished visual reference image.",
    "Use SVG shapes, paths, gradients, patterns, and short readable text only.",
    "Do not use shell commands, tools, apply_patch, file creation, markdown fences, HTML wrappers, CSS files, screenshots, or extra assets.",
    "Do not use scripts, event handlers, external images, external fonts, official logos, trademarks, or exact brand artwork.",
    "If the prompt mentions a brand, treat it as a generic style/category reference only.",
    "Start with <svg and end with </svg>. Do not include explanations before or after the SVG.",
    "",
    "User prompt:",
    normalizeImagePrompt(prompt)
  ].join("\n");
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findGeneratedImagePath(tempDir, depth = 0) {
  const expected = path.join(tempDir, CODEX_IMAGE_FILENAME);
  if (await pathExists(expected)) return expected;
  if (depth > 3) return "";

  const entries = await readdir(tempDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    const filePath = path.join(tempDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findGeneratedImagePath(filePath, depth + 1);
      if (nested) candidates.push({ filePath: nested, mtimeMs: 0 });
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_MIME_BY_EXTENSION.has(ext)) continue;
    const info = await stat(filePath).catch(() => null);
    if (info) candidates.push({ filePath, mtimeMs: Number(info.mtimeMs || 0) });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || "";
}

function extractSvg(text = "") {
  const match = String(text || "").match(/<svg\b[\s\S]*?<\/svg>/i);
  return match ? match[0].trim() : "";
}

function validateSvgContent(content) {
  const text = content.toString("utf8").trim();
  if (!/<svg\b/i.test(text)) {
    throw new ExternalServiceError("Codex generated an SVG file without an <svg> root.", null, "IMAGE_CODEX_INVALID_SVG");
  }
  if (!/^<svg\b[\s\S]*<\/svg>$/i.test(text)) {
    throw new ExternalServiceError("Codex generated SVG with content outside the root <svg> document.", null, "IMAGE_CODEX_INVALID_SVG");
  }
  if (/<script\b/i.test(text) || /javascript:/i.test(text) || /\son\w+\s*=/i.test(text) || /<foreignObject\b/i.test(text)) {
    throw new ExternalServiceError("Codex generated an unsafe SVG file.", null, "IMAGE_CODEX_UNSAFE_SVG");
  }
  if (/\b(?:href|src)\s*=\s*["']https?:\/\//i.test(text)) {
    throw new ExternalServiceError("Codex generated an SVG with external references.", null, "IMAGE_CODEX_EXTERNAL_REFERENCE");
  }
}

export function normalizeSvgAssetContent(content) {
  const svg = extractSvg(content.toString("utf8"));
  if (!svg) {
    throw new ExternalServiceError("Codex generated an SVG file without an <svg> root.", null, "IMAGE_CODEX_INVALID_SVG");
  }
  const normalized = Buffer.from(svg, "utf8");
  validateSvgContent(normalized);
  return normalized;
}

function imageAssetFromSvgText(svg, metadata = {}) {
  const content = normalizeSvgAssetContent(Buffer.from(svg, "utf8"));
  return {
    assetType: "image",
    mimeType: "image/svg+xml",
    filename: CODEX_IMAGE_FILENAME,
    content,
    metadata
  };
}

async function buildImageAssetFromFile(filePath, metadata = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXTENSION.get(ext);
  if (!mimeType) {
    throw new ExternalServiceError("Codex generated an unsupported image format.", { filePath }, "IMAGE_CODEX_UNSUPPORTED_FORMAT");
  }

  const info = await stat(filePath);
  if (!info.size) {
    throw new ExternalServiceError("Codex generated an empty image file.", { filePath }, "IMAGE_CODEX_EMPTY_FILE");
  }
  if (info.size > MAX_CODEX_IMAGE_BYTES) {
    throw new ExternalServiceError("Codex generated an image file that is too large.", { filePath, size: info.size }, "IMAGE_CODEX_FILE_TOO_LARGE");
  }

  let content = await readFile(filePath);
  if (mimeType === "image/svg+xml") content = normalizeSvgAssetContent(content);
  const filename = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "-") || CODEX_IMAGE_FILENAME;
  return {
    assetType: "image",
    mimeType,
    filename,
    content,
    metadata
  };
}

async function runCodexImagePrompt(tempDir, prompt, outputFile) {
  const codexBin = await resolveCodexBinary();
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    config.imageCodexSandbox,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    `model_reasoning_effort="${config.imageCodexReasoningEffort}"`,
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile
  ];
  if (config.imageCodexModel) args.push("--model", config.imageCodexModel);
  args.push("-");

  const timeoutMs = Math.max(10000, Number(config.imageCodexTimeoutMs || config.codeJobTimeoutMs || 900000));
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(prompt);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let timeout = null;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error) => {
      finish(new ExternalServiceError(error.message, null, "IMAGE_CODEX_PROCESS_ERROR"));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(
          new ExternalServiceError(
            `Codex image generation timed out after ${timeoutMs}ms`,
            { stdout: stdout.trim(), stderr: stderr.trim() },
            "IMAGE_CODEX_TIMEOUT"
          )
        );
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new ExternalServiceError(
          `Codex image generation failed (code ${code})`,
          { stdout: stdout.trim(), stderr: stderr.trim() },
          "IMAGE_CODEX_NON_ZERO"
        )
      );
    });
  });
}

async function generateImageAssetWithCodex({ prompt }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-image-codex-"));
  const outputFile = path.join(tempDir, "codex-summary.txt");
  const metadata = {
    provider: "codex_cli",
    configuredProvider: config.imageProvider || "codex_cli",
    model: config.imageCodexModel || null,
    size: parseImageSize(config.imageDefaultSize).label,
    promptPreview: safePromptPreview(prompt)
  };

  try {
    const codexPrompt = buildCodexImagePrompt(prompt);
    const result = await runCodexImagePrompt(tempDir, codexPrompt, outputFile);
    const summary = await readFile(outputFile, "utf8").catch(() => "");
    const generatedPath = await findGeneratedImagePath(tempDir);
    if (generatedPath) {
      return buildImageAssetFromFile(generatedPath, {
        ...metadata,
        codexSummary: summary.trim().slice(0, 1000) || null
      });
    }

    const fallbackSvg = extractSvg(`${summary}\n${result.stdout}\n${result.stderr}`);
    if (fallbackSvg) return imageAssetFromSvgText(fallbackSvg, {
      ...metadata,
      codexSummary: summary.trim().slice(0, 1000) || null,
      generatedFromText: true
    });

    throw new ExternalServiceError(
      "Codex did not return usable SVG image markup.",
      {
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        summary: summary.trim()
      },
      "IMAGE_CODEX_NO_OUTPUT"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function generateImageAsset({ prompt }) {
  if (!config.imageGenerationEnabled) {
    throw new ValidationError("Image generation is disabled. Set IMAGE_GENERATION_ENABLED=true to enable it.");
  }

  const provider = resolveImageProvider(config.imageProvider);
  if (provider === "fake") return fakeImageAsset(prompt);
  if (provider === "codex_cli") return generateImageAssetWithCodex({ prompt });
  if (provider !== "codex_cli") {
    throw new ValidationError(`Unsupported image provider: ${config.imageProvider}`);
  }
}
