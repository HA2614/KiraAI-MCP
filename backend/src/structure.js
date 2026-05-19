import path from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  lstat,
  stat,
  writeFile,
  access,
  rm,
  rename,
  copyFile,
  realpath
} from "node:fs/promises";
import { constants } from "node:fs";
import { config } from "./config.js";
import { ValidationError } from "./errors.js";

const ALLOWED_ROOT = path.resolve(config.fsBasePath);
const TREE_MAX_DIRS_PER_LEVEL = Number(process.env.FS_TREE_MAX_DIRS || 80);
let allowedRootRealPath = null;

function withSep(p) {
  return p.endsWith(path.sep) ? p : `${p}${path.sep}`;
}

function withoutTrailingSep(p) {
  return p.replace(/[\\/]+$/, "");
}

function isBroadTraversalRoot(p) {
  const cleaned = withoutTrailingSep(p).replace(/\\/g, "/").toLowerCase();
  const allowed = withoutTrailingSep(ALLOWED_ROOT).replace(/\\/g, "/").toLowerCase();
  return cleaned === allowed || /^\/host\/[a-z]$/.test(cleaned) || /^[a-z]:$/.test(cleaned);
}

function extType(name) {
  const ext = path.extname(name).toLowerCase();
  return ext ? `${ext.slice(1).toUpperCase()} File` : "File";
}

function bytesToSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

export function resolveSafePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const rootWithSep = withSep(ALLOWED_ROOT);
  const allowed = resolved === ALLOWED_ROOT || resolved.startsWith(rootWithSep);
  if (!allowed) throw new ValidationError(`Path is outside allowed FS root: ${ALLOWED_ROOT}`);
  return resolved;
}

async function getAllowedRootRealPath() {
  if (!allowedRootRealPath) {
    await mkdir(ALLOWED_ROOT, { recursive: true });
    allowedRootRealPath = await realpath(ALLOWED_ROOT);
  }
  return allowedRootRealPath;
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertRealPathInsideRoot(targetPath) {
  const root = await getAllowedRootRealPath();
  const real = await realpath(targetPath);
  if (!isInsideRoot(root, real)) {
    throw new ValidationError(`Path resolves outside allowed FS root: ${ALLOWED_ROOT}`);
  }
  return real;
}

export async function resolveExistingSafePath(targetPath) {
  const resolved = resolveSafePath(targetPath);
  await assertRealPathInsideRoot(resolved);
  return resolved;
}

async function nearestExistingParent(targetPath) {
  let current = path.dirname(targetPath);
  const root = path.parse(current).root;
  while (current && current !== root) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      current = path.dirname(current);
    }
  }
  return current || root;
}

export async function resolveWritableSafePath(targetPath) {
  const resolved = resolveSafePath(targetPath);
  try {
    await lstat(resolved);
    await assertRealPathInsideRoot(resolved);
    return resolved;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await nearestExistingParent(resolved);
  await assertRealPathInsideRoot(parent);
  return resolved;
}

function assertNotRootMutation(targetPath) {
  if (isBroadTraversalRoot(targetPath)) {
    throw new ValidationError("Refusing to mutate the filesystem root or workspace root");
  }
}

export function mapFsError(error, resolvedPath) {
  const code = error?.code || "";
  if (code === "ENOENT") return new ValidationError(`Path not found: ${resolvedPath}`);
  if (code === "EACCES" || code === "EPERM") return new ValidationError(`Access denied for path: ${resolvedPath}`);
  return error;
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function toFsEntry(fullPath, dirent = null) {
  let st = null;
  try {
    await assertRealPathInsideRoot(fullPath);
    st = await stat(fullPath);
  } catch (error) {
    if (!dirent) throw error;
    return {
      path: fullPath,
      name: path.basename(fullPath),
      kind: dirent.isDirectory() ? "directory" : "file",
      size: null,
      sizeLabel: "",
      typeLabel: "Unavailable",
      modifiedAt: null,
      inaccessible: true,
      errorCode: error?.code || "UNKNOWN"
    };
  }
  const name = path.basename(fullPath);
  return {
    path: fullPath,
    name,
    kind: st.isDirectory() ? "directory" : "file",
    size: st.isFile() ? st.size : null,
    sizeLabel: st.isFile() ? bytesToSize(st.size) : "",
    typeLabel: st.isDirectory() ? "File Folder" : extType(name),
    modifiedAt: st.mtime.toISOString()
  };
}

function normalizeConflict(policy = "fail") {
  if (!["fail", "overwrite", "skip"].includes(policy)) throw new ValidationError("Invalid conflictPolicy");
  return policy;
}

export async function fsList({ targetPath, includeHidden = true }) {
  const resolved = await resolveExistingSafePath(targetPath);
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const mapped = [];
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith(".")) continue;
      const full = path.join(resolved, e.name);
      const info = await toFsEntry(full, e);
      mapped.push(info);
    }
    mapped.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent !== resolved ? parent : null,
      fsRoot: ALLOWED_ROOT,
      entries: mapped
    };
  } catch (error) {
    throw mapFsError(error, resolved);
  }
}

export async function fsTree({ targetPath, depth = 2 }) {
  const resolved = await resolveExistingSafePath(targetPath);
  const requestedDepth = Math.max(1, Math.min(5, Number(depth || 2)));
  const safeDepth = isBroadTraversalRoot(resolved) ? 1 : requestedDepth;
  async function walk(current, level) {
    const node = await toFsEntry(current);
    if (node.kind !== "directory" || level >= safeDepth) return { ...node, children: [] };
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return { ...node, children: [] };
    }
    const allDirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const dirs = allDirs.slice(0, TREE_MAX_DIRS_PER_LEVEL);
    const children = [];
    for (const d of dirs) {
      try {
        children.push(await walk(path.join(current, d.name), level + 1));
      } catch {
        // Windows drive roots can contain protected junctions; skip unreadable branches.
      }
    }
    return { ...node, children, truncated: allDirs.length > dirs.length };
  }
  return walk(resolved, 0);
}

export async function fsStat({ targetPath }) {
  const resolved = await resolveExistingSafePath(targetPath);
  try {
    return await toFsEntry(resolved);
  } catch (error) {
    throw mapFsError(error, resolved);
  }
}

export async function fsReadFile({ targetPath }) {
  const resolved = await resolveExistingSafePath(targetPath);
  try {
    const st = await stat(resolved);
    if (!st.isFile()) throw new ValidationError("Target is not a file");
    if (st.size > config.fsMaxReadBytes) {
      throw new ValidationError(`File is larger than FS_MAX_READ_BYTES (${config.fsMaxReadBytes})`);
    }
    return { path: resolved, content: await readFile(resolved, "utf8") };
  } catch (error) {
    throw mapFsError(error, resolved);
  }
}

export async function fsWriteFile({ targetPath, content, conflictPolicy = "overwrite" }) {
  const resolved = await resolveWritableSafePath(targetPath);
  assertNotRootMutation(resolved);
  const policy = normalizeConflict(conflictPolicy);
  try {
    const exists = await fileExists(resolved);
    if (exists && policy === "fail") return { ok: false, action: "write", path: resolved, status: "conflict" };
    if (exists && policy === "skip") return { ok: true, action: "write", path: resolved, status: "skipped" };
    await ensureDir(path.dirname(resolved));
    await writeFile(resolved, content, "utf8");
    return { ok: true, action: "write", path: resolved, status: exists ? "overwritten" : "created" };
  } catch (error) {
    throw mapFsError(error, resolved);
  }
}

export async function fsMkdir({ targetPath }) {
  const resolved = await resolveWritableSafePath(targetPath);
  await mkdir(resolved, { recursive: true });
  return { ok: true, action: "mkdir", path: resolved, status: "created" };
}

export async function fsCreateFile({ targetPath, content = "", conflictPolicy = "fail" }) {
  return fsWriteFile({ targetPath, content, conflictPolicy });
}

export async function fsRename({ sourcePath, newName, conflictPolicy = "fail" }) {
  const source = await resolveExistingSafePath(sourcePath);
  assertNotRootMutation(source);
  const destination = await resolveWritableSafePath(path.join(path.dirname(source), newName));
  assertNotRootMutation(destination);
  const policy = normalizeConflict(conflictPolicy);
  const exists = await fileExists(destination);
  if (exists && policy === "fail") return { ok: false, action: "rename", path: source, status: "conflict", destination };
  if (exists && policy === "skip") return { ok: true, action: "rename", path: source, status: "skipped", destination };
  if (exists && policy === "overwrite") await rm(destination, { recursive: true, force: true });
  await rename(source, destination);
  return { ok: true, action: "rename", path: source, destination, status: "moved" };
}

export async function fsMove({ sourcePath, destinationPath, conflictPolicy = "fail" }) {
  const source = await resolveExistingSafePath(sourcePath);
  assertNotRootMutation(source);
  const destination = await resolveWritableSafePath(destinationPath);
  assertNotRootMutation(destination);
  const policy = normalizeConflict(conflictPolicy);
  const exists = await fileExists(destination);
  if (exists && policy === "fail") return { ok: false, action: "move", path: source, status: "conflict", destination };
  if (exists && policy === "skip") return { ok: true, action: "move", path: source, status: "skipped", destination };
  if (exists && policy === "overwrite") await rm(destination, { recursive: true, force: true });
  await ensureDir(path.dirname(destination));
  await rename(source, destination);
  return { ok: true, action: "move", path: source, destination, status: "moved" };
}

async function copyRecursive(source, destination, policy) {
  await resolveExistingSafePath(source);
  await resolveWritableSafePath(destination);
  const st = await stat(source);
  const destinationExists = await fileExists(destination);
  if (destinationExists && policy === "fail") return { ok: false, status: "conflict" };
  if (destinationExists && policy === "skip") return { ok: true, status: "skipped" };
  if (destinationExists && policy === "overwrite") await rm(destination, { recursive: true, force: true });
  if (st.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const e of entries) await copyRecursive(path.join(source, e.name), path.join(destination, e.name), "overwrite");
  } else {
    await ensureDir(path.dirname(destination));
    await copyFile(source, destination);
  }
  return { ok: true, status: "copied" };
}

export async function fsCopy({ sourcePath, destinationPath, conflictPolicy = "fail" }) {
  const source = await resolveExistingSafePath(sourcePath);
  assertNotRootMutation(source);
  const destination = await resolveWritableSafePath(destinationPath);
  assertNotRootMutation(destination);
  const policy = normalizeConflict(conflictPolicy);
  const result = await copyRecursive(source, destination, policy);
  return { ok: result.ok, action: "copy", path: source, destination, status: result.status };
}

export async function fsDelete({ targetPath }) {
  const resolved = await resolveExistingSafePath(targetPath);
  assertNotRootMutation(resolved);
  await rm(resolved, { recursive: true, force: true });
  return { ok: true, action: "delete", path: resolved, status: "deleted" };
}

export async function fsBatch({ operations = [] }) {
  const results = [];
  for (const op of operations) {
    try {
      if (op.type === "delete") results.push(await fsDelete({ targetPath: op.targetPath }));
      else if (op.type === "copy") results.push(await fsCopy(op));
      else if (op.type === "move") results.push(await fsMove(op));
      else if (op.type === "rename") results.push(await fsRename(op));
      else if (op.type === "mkdir") results.push(await fsMkdir(op));
      else if (op.type === "create-file") results.push(await fsCreateFile(op));
      else results.push({ ok: false, action: op.type, status: "unsupported" });
    } catch (error) {
      results.push({ ok: false, action: op.type, status: "error", message: error.message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

function buildScaffoldFiles({ root, project, plan, profile, planVersion, structurePrompt = "" }) {
  const docsDir = path.join(root, "docs");
  const webDir = path.join(root, "apps", "web");
  const webSrcDir = path.join(webDir, "src");
  const apiDir = path.join(root, "apps", "api");
  const apiSrcDir = path.join(apiDir, "src");
  const infraDir = path.join(root, "infra");
  const weekLines = (plan.milestones || []).map((m) => `## Week ${m.week}: ${m.name}\n- ${(m.deliverables || []).join("\n- ")}`).join("\n\n");
  const promptBlock = structurePrompt?.trim()
    ? `\n## Generator Prompt\n${structurePrompt.trim()}\n`
    : "";
  const readme = `# ${project.name}\n\n## Goals\n${project.goals}\n\n## Summary\n${plan.summary || "No summary"}\n${promptBlock}`;
  const metadata = { generatedAt: new Date().toISOString(), profile, planVersion, projectId: project.id, projectName: project.name, structurePrompt };
  const files = [
    [path.join(root, "README.md"), readme],
    [path.join(docsDir, "plan.json"), JSON.stringify(plan, null, 2)],
    [path.join(docsDir, "weekly-plan.md"), weekLines || "No milestones provided."],
    [path.join(docsDir, "generator-metadata.json"), JSON.stringify(metadata, null, 2)]
  ];
  if (profile === "web+api" || profile === "web") {
    files.push(
      [path.join(webDir, "package.json"), `{"name":"${slugify(project.name)}-web","private":true,"version":"1.0.0","type":"module","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"axios":"^1.7.2","react":"^18.3.1","react-dom":"^18.3.1"},"devDependencies":{"@vitejs/plugin-react":"^4.3.1","vite":"^5.4.2"}}`],
      [path.join(webDir, "index.html"), `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${project.name}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`],
      [path.join(webSrcDir, "main.jsx"), 'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App.jsx";\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n'],
      [path.join(webSrcDir, "App.jsx"), `export default function App(){return <main style={{padding:20}}><h1>${project.name}</h1><p>${plan.summary || "Project scaffold"}</p></main>;}`]
    );
  }
  if (profile === "web+api" || profile === "api") {
    files.push(
      [path.join(apiDir, "package.json"), `{"name":"${slugify(project.name)}-api","private":true,"version":"1.0.0","type":"module","scripts":{"start":"node src/server.js"},"dependencies":{"express":"^4.19.2","cors":"^2.8.5"}}`],
      [path.join(apiSrcDir, "server.js"), 'import express from "express";\nimport cors from "cors";\nconst app = express();\napp.use(cors());\napp.get("/health", (_req,res)=>res.json({ok:true}));\napp.listen(4000, ()=>console.log("API listening on :4000"));\n'],
      [path.join(infraDir, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"\n"]
    );
  }
  return files;
}

export async function generateProjectStructure({ targetPath, project, plan, profile = "web+api", dryRun = false, overwriteStrategy = "skip_existing", structurePrompt = "", planVersion = null }) {
  const profiles = new Set(["web+api", "api", "web", "docs-only"]);
  if (!profiles.has(profile)) throw new ValidationError("Invalid profile. Use web+api, web, api, or docs-only.");
  if (!["skip_existing", "overwrite_all", "prompt_conflicts"].includes(overwriteStrategy)) throw new ValidationError("Invalid overwriteStrategy");
  const safeBase = await resolveWritableSafePath(targetPath);
  const root = path.resolve(safeBase, slugify(project.name || "project"));
  const createdFiles = [];
  const skippedFiles = [];
  const conflicts = [];
  const fileSpecs = buildScaffoldFiles({ root, project, plan, profile, planVersion, structurePrompt });
  if (dryRun) return { root, dryRun: true, plannedFiles: fileSpecs.map(([file]) => file), createdFiles, skippedFiles, conflicts };
  for (const [file, content] of fileSpecs) {
    const exists = await fileExists(file);
    if (exists && overwriteStrategy === "prompt_conflicts") { conflicts.push(file); continue; }
    if (exists && overwriteStrategy === "skip_existing") { skippedFiles.push(file); continue; }
    await resolveWritableSafePath(file);
    await ensureDir(path.dirname(file));
    await writeFile(file, content, "utf8");
    createdFiles.push(file);
  }
  return { root, dryRun: false, createdFiles, skippedFiles, conflicts };
}

// Backward-compatible wrappers
export async function listDirectories(targetPath) {
  const out = await fsList({ targetPath });
  return {
    path: out.path,
    parent: out.parent,
    fsRoot: out.fsRoot,
    directories: out.entries.filter((e) => e.kind === "directory").map((e) => e.path),
    files: out.entries.filter((e) => e.kind === "file").map((e) => e.path)
  };
}

export async function readTextFile(targetPath) {
  return fsReadFile({ targetPath });
}

export async function writeTextFile(targetPath, content) {
  const res = await fsWriteFile({ targetPath, content, conflictPolicy: "overwrite" });
  return { path: res.path, saved: res.ok };
}
