import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolveSafePath } from "./structure.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".txt", ".css", ".scss", ".html", ".sql", ".py", ".yml", ".yaml", ".env", ".toml", ".xml"
]);

function isLikelyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || path.basename(filePath).toLowerCase() === "dockerfile";
}

function extractImports(content) {
  const imports = [];
  const importRegex = /import\s+[^\n]*?from\s+["']([^"']+)["']/g;
  const requireRegex = /require\(["']([^"']+)["']\)/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) imports.push(m[1]);
  while ((m = requireRegex.exec(content)) !== null) imports.push(m[1]);
  return [...new Set(imports)].slice(0, 12);
}

function extractExports(content) {
  const exports = [];
  const exportFnRegex = /export\s+(?:default\s+)?function\s+([A-Za-z0-9_]+)/g;
  const exportConstRegex = /export\s+const\s+([A-Za-z0-9_]+)/g;
  const moduleExportsRegex = /module\.exports\s*=\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = exportFnRegex.exec(content)) !== null) exports.push(m[1]);
  while ((m = exportConstRegex.exec(content)) !== null) exports.push(m[1]);
  while ((m = moduleExportsRegex.exec(content)) !== null) exports.push(m[1]);
  return [...new Set(exports)].slice(0, 12);
}

function extractKeySymbols(content) {
  const symbols = [];
  const fnRegex = /(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  const classRegex = /class\s+([A-Za-z0-9_]+)/g;
  const constFnRegex = /const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = fnRegex.exec(content)) !== null) symbols.push(m[1]);
  while ((m = classRegex.exec(content)) !== null) symbols.push(m[1]);
  while ((m = constFnRegex.exec(content)) !== null) symbols.push(m[1]);
  return [...new Set(symbols)].slice(0, 20);
}

function describeFileFromCode(relativePath, content) {
  const lower = content.toLowerCase();
  const ext = path.extname(relativePath).toLowerCase();

  if (relativePath.endsWith("package.json")) return "Defines dependencies, scripts, and package metadata.";
  if (ext === ".sql") return "Defines schema or SQL queries used by the application.";
  if (lower.includes("express") && lower.includes("router")) return "Implements HTTP routes and request handlers.";
  if (lower.includes("app.listen") || lower.includes("create_server")) return "Starts or configures a server runtime.";
  if ((ext === ".jsx" || ext === ".tsx") && lower.includes("return (") ) return "Defines a React UI component/page.";
  if (lower.includes("axios.create") || lower.includes("fetch(")) return "Implements API client or external service calls.";
  if (lower.includes("z.object(") || lower.includes("zod")) return "Defines runtime validation schemas.";
  if (lower.includes("@modelcontextprotocol") || lower.includes("mcpserver")) return "Implements MCP server/tool integration.";
  if (lower.includes("inquirer")) return "Implements terminal interactive flow.";
  if (ext === ".md") return "Project documentation and usage guidance.";

  const symbols = extractKeySymbols(content);
  if (symbols.length) return `Contains core logic with key symbols: ${symbols.slice(0, 5).join(", ")}.`;
  return "Contains implementation logic for this project.";
}

function detectStack(files) {
  const names = files.map((f) => f.relativePath.toLowerCase());
  const stack = [];
  if (names.some((n) => n.endsWith("package.json"))) stack.push("Node.js");
  if (names.some((n) => n.endsWith(".jsx") || n.endsWith(".tsx"))) stack.push("React");
  if (files.some((f) => f.content.toLowerCase().includes("express"))) stack.push("Express API");
  if (files.some((f) => f.content.toLowerCase().includes("postgres") || f.content.toLowerCase().includes("pg"))) stack.push("PostgreSQL");
  if (files.some((f) => f.content.toLowerCase().includes("redis"))) stack.push("Redis");
  if (files.some((f) => f.content.toLowerCase().includes("@modelcontextprotocol"))) stack.push("MCP");
  if (files.some((f) => f.content.toLowerCase().includes("openai") || f.content.toLowerCase().includes("anthropic") || f.content.toLowerCase().includes("codex"))) {
    stack.push("AI provider integration");
  }
  return stack;
}

function inferProjectDescription(files, stack) {
  const hasTerminal = files.some((f) => f.content.toLowerCase().includes("inquirer"));
  const hasMcp = files.some((f) => f.content.toLowerCase().includes("@modelcontextprotocol"));
  const hasWeb = files.some((f) => f.relativePath.startsWith("frontend/") || f.relativePath.endsWith("App.jsx"));
  const hasApi = files.some((f) => f.content.toLowerCase().includes("express"));

  const parts = [];
  if (hasApi) parts.push("backend API service");
  if (hasWeb) parts.push("web frontend");
  if (hasTerminal) parts.push("terminal suite");
  if (hasMcp) parts.push("MCP tool interface");
  const core = parts.length ? parts.join(", ") : "application code";

  return `This project is a ${core}. Detected technologies: ${stack.join(", ") || "not enough signals"}.`;
}

function buildPipeline(files) {
  const hasFrontend = files.some((f) => f.relativePath.startsWith("frontend/") || f.relativePath.startsWith("apps/web/"));
  const hasBackend = files.some((f) => f.relativePath.startsWith("backend/") || f.content.includes("express"));
  const hasDb = files.some((f) => f.content.toLowerCase().includes("postgres") || f.relativePath.endsWith(".sql"));
  const hasRedis = files.some((f) => f.content.toLowerCase().includes("redis"));
  const hasAi = files.some((f) => f.content.toLowerCase().includes("openai") || f.content.toLowerCase().includes("anthropic") || f.content.toLowerCase().includes("codex"));
  const hasTerminal = files.some((f) => f.content.toLowerCase().includes("inquirer"));
  const hasMcp = files.some((f) => f.content.toLowerCase().includes("@modelcontextprotocol"));

  const lines = ["flowchart LR"];
  if (hasFrontend && hasBackend) lines.push("  Frontend[Web/Desktop UI] --> Backend[Node API]");
  if (hasTerminal && hasBackend) lines.push("  Terminal[Terminal Suite] --> Backend");
  if (hasMcp && hasBackend) lines.push("  MCP[MCP Tools] --> Backend");
  if (hasDb && hasBackend) lines.push("  Backend --> DB[(PostgreSQL)]");
  if (hasRedis && hasBackend) lines.push("  Backend --> Cache[(Redis)]");
  if (hasAi && hasBackend) lines.push("  Backend --> AI[AI Providers / CLI]");
  if (lines.length === 1) lines.push("  Project[Codebase] --> Summary[Analysis]");
  return lines.join("\n");
}

async function collectCandidateFiles(rootPath, maxFiles = 800) {
  const out = [];

  async function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isLikelyTextFile(full)) continue;

      const rel = path.relative(rootPath, full).replace(/\\/g, "/");
      let fileStat = null;
      try {
        fileStat = await stat(full);
      } catch {
        continue;
      }
      if (fileStat.size > 1024 * 1024) continue;
      out.push({ absolutePath: full, relativePath: rel, bytes: fileStat.size });
    }
  }

  await walk(rootPath);
  return out;
}

function updateProgress(onProgress, value, stage, message, extra = {}) {
  if (!onProgress) return;
  onProgress({ progress: value, stage, message, ...extra });
}

export async function summarizeCodebase(targetPath, options = {}) {
  const onProgress = options.onProgress || null;
  const root = resolveSafePath(targetPath);

  updateProgress(onProgress, 3, "scan", "Scanning directories");
  const candidates = await collectCandidateFiles(root, options.maxFiles || 800);

  const files = [];
  const total = candidates.length || 1;
  for (let i = 0; i < candidates.length; i += 1) {
    const f = candidates[i];
    let content = "";
    try {
      content = await readFile(f.absolutePath, "utf8");
    } catch {
      continue;
    }
    files.push({ ...f, content });
    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
      const progress = 5 + Math.floor(((i + 1) / total) * 65);
      updateProgress(onProgress, progress, "read", `Reading files (${i + 1}/${candidates.length})`, {
        readFiles: i + 1,
        totalFiles: candidates.length
      });
    }
  }

  updateProgress(onProgress, 75, "analyze", "Analyzing file contents");
  const fileSummaries = files.map((f, index) => {
    if ((index + 1) % 25 === 0 || index === files.length - 1) {
      const progress = 75 + Math.floor(((index + 1) / (files.length || 1)) * 20);
      updateProgress(onProgress, progress, "analyze", `Analyzing code (${index + 1}/${files.length})`, {
        analyzedFiles: index + 1,
        totalFiles: files.length
      });
    }

    const imports = extractImports(f.content);
    const exports = extractExports(f.content);
    const keySymbols = extractKeySymbols(f.content);

    return {
      path: f.relativePath,
      bytes: f.bytes,
      lines: f.content.split("\n").length,
      description: describeFileFromCode(f.relativePath, f.content),
      imports,
      exports,
      keySymbols
    };
  });

  const stack = detectStack(files);
  const title = `${path.basename(root)} Codebase Summary`;
  const description = inferProjectDescription(files, stack);
  const pipelineDiagramMermaid = buildPipeline(files);

  updateProgress(onProgress, 100, "done", "Analysis completed", {
    totalFiles: files.length
  });

  return {
    root,
    title,
    description,
    detectedStack: stack,
    fileCount: files.length,
    files: fileSummaries,
    pipelineDiagramMermaid
  };
}
