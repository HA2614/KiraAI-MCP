import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import inquirer from "inquirer";
import { query } from "./db.js";
import { connectRedis } from "./cache.js";
import { generatePlan } from "./ai.js";
import { generateProjectStructure, listDirectories, readTextFile, writeTextFile } from "./structure.js";
import { summarizeCodebaseWithCodex } from "./codexCodebaseSummary.js";
import { applyCodeJob, getCodeJob, startCodeJob } from "./codeJobs.js";

let activeProjectId = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const desktopLauncherPath = path.join(repoRoot, "desktop", "launcher.py");

function line(char = "-", width = 88) {
  return char.repeat(width);
}

function getPageSize(defaultSize = 16) {
  const rows = Number(process.stdout.rows || 0);
  if (!rows) return defaultSize;
  return Math.max(defaultSize, rows - 8);
}

function header(title) {
  console.clear();
  console.log(chalk.cyan(line()));
  console.log(chalk.bold.white(`  ${title}`));
  console.log(chalk.cyan(line()));
  console.log();
}

function section(title) {
  console.log();
  console.log(chalk.bold.yellow(`  ${title}`));
  console.log(chalk.gray(`  ${line(".", 70)}`));
}

function printKV(label, value = "") {
  const left = `${label}:`.padEnd(22, " ");
  console.log(`  ${chalk.gray(left)} ${value}`);
}

async function pause(message = "Press Enter to continue") {
  await inquirer.prompt([{ type: "input", name: "ok", message }]);
}

async function runSafe(fn) {
  try {
    await fn();
  } catch (error) {
    console.log(chalk.red(`\n  Error: ${error.message}`));
    await pause();
  }
}

async function chooseProject(message = "Select project") {
  const res = await query("SELECT id, name FROM projects ORDER BY created_at DESC");
  if (!res.rowCount) {
    console.log(chalk.red("  No projects found."));
    return null;
  }
  const { projectId } = await inquirer.prompt([
    {
      type: "list",
      name: "projectId",
      message,
      pageSize: 14,
      choices: res.rows.map((p) => ({ name: `#${p.id}  ${p.name}`, value: p.id }))
    }
  ]);
  return projectId;
}

async function projectCreateFlow() {
  header("Create Project");
  const answers = await inquirer.prompt([
    { type: "input", name: "name", message: "Project name:" },
    { type: "input", name: "goals", message: "Goals:" },
    { type: "input", name: "techStack", message: "Tech stack:", default: "" },
    { type: "input", name: "timeline", message: "Timeline:", default: "" },
    { type: "input", name: "budget", message: "Budget:", default: "" }
  ]);
  const created = await query(
    `INSERT INTO projects (name, goals, tech_stack, timeline, budget)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name`,
    [answers.name, answers.goals, answers.techStack, answers.timeline, answers.budget]
  );
  activeProjectId = created.rows[0].id;
  console.log(chalk.green(`\n  Created project #${created.rows[0].id}: ${created.rows[0].name}`));
  await pause();
}

async function projectsMenu() {
  while (true) {
    header("Projects Menu");
    printKV("Active Project", activeProjectId ? `#${activeProjectId}` : "None");
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose action",
        choices: [
          { name: "Create project", value: "create" },
          { name: "Select active project", value: "select" },
          { name: "Back", value: "back" }
        ]
      }
    ]);
    if (action === "back") return;
    if (action === "create") await runSafe(projectCreateFlow);
    if (action === "select") {
      const id = await chooseProject("Select active project");
      if (id) activeProjectId = id;
    }
  }
}

async function generatePlanFlow() {
  header("Generate Plan");
  if (!activeProjectId) activeProjectId = await chooseProject("Select project");
  if (!activeProjectId) return pause();

  const { provider } = await inquirer.prompt([
    {
      type: "list",
      name: "provider",
      message: "Provider",
      choices: ["codex_cli", "claude_cli", "openai", "anthropic"]
    }
  ]);

  const projectRes = await query("SELECT * FROM projects WHERE id=$1", [activeProjectId]);
  const project = projectRes.rows[0];
  const versionRes = await query(
    "SELECT COALESCE(MAX(version), 0) AS v FROM project_plans WHERE project_id=$1",
    [activeProjectId]
  );
  const nextVersion = Number(versionRes.rows[0].v) + 1;

  const plan = await generatePlan(project, provider);
  const inserted = await query(
    `INSERT INTO project_plans (project_id, version, plan_json, status, provider)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, version`,
    [activeProjectId, nextVersion, plan, "pending", provider]
  );
  console.log(chalk.green(`\n  Plan saved as #${inserted.rows[0].id} (v${inserted.rows[0].version}).`));
  await pause();
}

async function viewPlanHistoryFlow() {
  header("Plan History");
  if (!activeProjectId) activeProjectId = await chooseProject("Select project");
  if (!activeProjectId) return pause();

  const filter = await inquirer.prompt([
    { type: "input", name: "status", message: "Status filter (blank=all):", default: "" }
  ]);

  const params = [activeProjectId];
  let sql = "SELECT id, version, status, provider, is_baseline, created_at FROM project_plans WHERE project_id=$1";
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status=$${params.length}`;
  }
  sql += " ORDER BY version DESC";
  const rows = await query(sql, params);

  const total = rows.rows.length;
  const accepted = rows.rows.filter((r) => r.status === "accepted").length;
  const baseline = rows.rows.find((r) => r.is_baseline);
  printKV("Plans shown", String(total));
  printKV("Accepted", String(accepted));
  printKV("Baseline", baseline ? `v${baseline.version}` : "none");
  rows.rows.slice(0, 8).forEach((r) => console.log(`  v${r.version}  ${r.status}  ${r.provider || "-"}`));
  if (total > 8) console.log(`  ... ${total - 8} more`);
  await pause();
}

async function comparePlansFlow() {
  header("Compare Plans");
  if (!activeProjectId) activeProjectId = await chooseProject("Select project");
  if (!activeProjectId) return pause();

  const latest = await query(
    "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC LIMIT 1",
    [activeProjectId]
  );
  if (!latest.rowCount) {
    console.log(chalk.red("  No plans found."));
    return pause();
  }

  const { againstVersion } = await inquirer.prompt([
    { type: "number", name: "againstVersion", message: "Compare latest against version:", default: Math.max(1, latest.rows[0].version - 1) }
  ]);

  const prior = await query(
    "SELECT * FROM project_plans WHERE project_id=$1 AND version=$2 LIMIT 1",
    [activeProjectId, againstVersion]
  );
  if (!prior.rowCount) {
    console.log(chalk.red("  Compared version not found."));
    return pause();
  }

  const latestTasks = (latest.rows[0].plan_json?.taskBreakdown || []).map((t) => t.task);
  const priorTasks = (prior.rows[0].plan_json?.taskBreakdown || []).map((t) => t.task);

  section("Compare Result");
  const added = latestTasks.filter((t) => !priorTasks.includes(t));
  const removed = priorTasks.filter((t) => !latestTasks.includes(t));
  printKV("Latest", `v${latest.rows[0].version}`);
  printKV("Compared", `v${prior.rows[0].version}`);
  printKV("Summary changed", latest.rows[0].plan_json?.summary !== prior.rows[0].plan_json?.summary ? "yes" : "no");
  printKV("Added tasks", String(added.length));
  printKV("Removed tasks", String(removed.length));
  if (added.length) console.log(`  + ${added.slice(0, 3).join(" | ")}`);
  if (removed.length) console.log(`  - ${removed.slice(0, 3).join(" | ")}`);
  await pause();
}

async function promoteBaselineFlow() {
  header("Promote Baseline");
  if (!activeProjectId) activeProjectId = await chooseProject("Select project");
  if (!activeProjectId) return pause();

  const rows = await query("SELECT id, version FROM project_plans WHERE project_id=$1 ORDER BY version DESC", [activeProjectId]);
  if (!rows.rowCount) return pause("No plans found. Press Enter.");

  const { planId } = await inquirer.prompt([
    {
      type: "list",
      name: "planId",
      message: "Select plan version to mark baseline",
      choices: rows.rows.map((r) => ({ name: `v${r.version} (plan #${r.id})`, value: r.id }))
    }
  ]);

  const plan = await query("SELECT * FROM project_plans WHERE id=$1", [planId]);
  await query("UPDATE project_plans SET is_baseline=FALSE WHERE project_id=$1", [activeProjectId]);
  await query("UPDATE project_plans SET is_baseline=TRUE, updated_at=NOW() WHERE id=$1", [planId]);

  console.log(chalk.green(`\n  Promoted plan #${plan.rows[0].id} to baseline.`));
  await pause();
}

async function generateStructureFlow() {
  header("Generate Structure");
  if (!activeProjectId) activeProjectId = await chooseProject("Select project");
  if (!activeProjectId) return pause();

  const planRes = await query("SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC LIMIT 1", [activeProjectId]);
  if (!planRes.rowCount) return pause("Generate a plan first. Press Enter.");

  const projectRes = await query("SELECT * FROM projects WHERE id=$1", [activeProjectId]);
  const opts = await inquirer.prompt([
    { type: "input", name: "targetPath", message: "Target base path:", default: path.join(repoRoot, "structure") },
    { type: "list", name: "profile", message: "Scaffold profile", choices: ["web+api", "web", "api", "docs-only"] },
    { type: "confirm", name: "dryRun", message: "Dry run only?", default: true },
    { type: "list", name: "overwriteStrategy", message: "Overwrite strategy", choices: ["skip_existing", "overwrite_all", "prompt_conflicts"] }
  ]);

  const out = await generateProjectStructure({
    targetPath: opts.targetPath,
    project: projectRes.rows[0],
    plan: planRes.rows[0].plan_json,
    profile: opts.profile,
    dryRun: opts.dryRun,
    overwriteStrategy: opts.overwriteStrategy,
    planVersion: planRes.rows[0].version
  });

  section("Structure result");
  printKV("Root", out.root);
  printKV("Dry run", String(out.dryRun));
  printKV("Created", String((out.createdFiles || []).length));
  printKV("Skipped", String((out.skippedFiles || []).length));
  printKV("Conflicts", String((out.conflicts || []).length));
  await pause();
}

async function fileExplorerFlow() {
  header("Terminal File Explorer");
  let current = path.join(repoRoot, "structure");
  while (true) {
    const listing = await listDirectories(current);
    header("Terminal File Explorer");
    printKV("Current", listing.path);
    printKV("FS Root", listing.fsRoot);

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Action",
        choices: [
          { name: "Open folder", value: "folder" },
          { name: "Open file", value: "file" },
          { name: "Go to path", value: "goto" },
          { name: "Back", value: "quit" }
        ]
      }
    ]);

    if (action === "quit") return;
    if (action === "goto") {
      const { p } = await inquirer.prompt([{ type: "input", name: "p", message: "Path", default: current }]);
      current = p;
      continue;
    }
    if (action === "folder") {
      const { p } = await inquirer.prompt([
        { type: "list", name: "p", message: "Folder", choices: listing.directories.map((d) => ({ name: d, value: d })) }
      ]);
      current = p;
      continue;
    }
    if (action === "file") {
      const { p } = await inquirer.prompt([
        { type: "list", name: "p", message: "File", choices: listing.files.map((f) => ({ name: path.basename(f), value: f })) }
      ]);
      const file = await readTextFile(p);
      console.log(file.content.slice(0, 1200));
      const { edit } = await inquirer.prompt([{ type: "confirm", name: "edit", message: "Edit file?", default: false }]);
      if (edit) {
        const { content } = await inquirer.prompt([{ type: "editor", name: "content", message: "Edit content", default: file.content }]);
        await writeTextFile(p, content);
      }
      await pause();
    }
  }
}

async function summarizeCodebaseFlow() {
  header("KiraAI Codebase Summary");
  const { targetPath } = await inquirer.prompt([
    {
      type: "input",
      name: "targetPath",
      message: "Folder path to summarize:",
      default: repoRoot
    }
  ]);

  function renderProgress(progress, message) {
    const width = 34;
    const safe = Math.max(0, Math.min(100, Number(progress || 0)));
    const filled = Math.round((safe / 100) * width);
    const bar = `${"=".repeat(filled)}${"-".repeat(width - filled)}`;
    process.stdout.write(`\r  [${bar}] ${String(safe).padStart(3, " ")}%  ${message.padEnd(38, " ")}`);
  }

  console.log("  KiraAI is analyzing...");
  const summary = await summarizeCodebaseWithCodex(targetPath, {
    onProgress: ({ progress, message }) => {
      renderProgress(progress, message || "Working");
    }
  });
  process.stdout.write("\n");
  section("Overview");
  printKV("Title", summary.title);
  printKV("Root", summary.root);
  console.log(`\n  ${summary.description}`);
  if (summary.analysisJson?.improvementSuggestions?.length) {
    section("Top Improvements");
    summary.analysisJson.improvementSuggestions.slice(0, 5).forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.file || "-"} :: ${s.function || "-"} :: ${s.suggestion}`);
    });
  }
  await pause();
}

async function aiCodeFlow() {
  header("KiraAI Code Worker");
  const answers = await inquirer.prompt([
    { type: "input", name: "rootPath", message: "Project root:", default: repoRoot },
    { type: "editor", name: "userPrompt", message: "Code prompt:" }
  ]);
  const job = await startCodeJob({ rootPath: answers.rootPath, userPrompt: answers.userPrompt });
  printKV("Job", `#${job.id}`);
  let current = job;
  while (["queued", "planning", "running"].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    current = await getCodeJob(job.id);
    process.stdout.write(`\r  status=${current.status}`.padEnd(40, " "));
  }
  process.stdout.write("\n");
  printKV("Status", current.status);
  printKV("Files", String((current.changed_files || []).length));
  printKV("Summary", current.diff_summary || "-");
  if (current.status === "awaiting_review") {
    const { apply } = await inquirer.prompt([{ type: "confirm", name: "apply", message: "Apply proposed files?", default: false }]);
    if (apply) {
      current = await applyCodeJob(current.id);
      printKV("Applied", current.status);
    }
  }
  await pause();
}

function runDetached(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function desktopLauncherFlow() {
  header("Desktop Launcher");
  const { mode } = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "Launch mode",
      choices: [
        { name: "Attach mode (backend already running)", value: "attach" },
        { name: "Start backend + launch desktop window", value: "startBackend" },
        { name: "Kill all desktop launcher processes", value: "killAllDesktop" },
        { name: "Back", value: "back" }
      ]
    }
  ]);
  if (mode === "back") return;
  if (mode === "killAllDesktop") {
    const { port } = await inquirer.prompt([
      {
        type: "number",
        name: "port",
        message: "Port to kill listener on",
        default: 4000
      }
    ]);
    const safePort = Number(port || 0);
    if (!Number.isInteger(safePort) || safePort <= 0 || safePort > 65535) {
      console.log(chalk.red("\n  Invalid port."));
      return pause();
    }

    const psScript = [
      `$port = ${safePort}`,
      "$allToKill = New-Object System.Collections.Generic.HashSet[int]",
      "$listenerPids = @()",
      "try {",
      "  $listenerPids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique",
      "} catch {",
      "  $listenerPids = @()",
      "}",
      "if (-not $listenerPids -or $listenerPids.Count -eq 0) {",
      "  $lines = netstat -ano -p tcp | Select-String -Pattern (\":\" + $port + \"\\s\")",
      "  foreach ($line in $lines) {",
      "    $parts = ($line -replace '^\\s+', '') -split '\\s+'",
      "    if ($parts.Length -ge 5 -and $parts[3] -eq 'LISTENING') {",
      "      $pidCandidate = 0",
      "      if ([int]::TryParse($parts[4], [ref]$pidCandidate)) { $listenerPids += $pidCandidate }",
      "    }",
      "  }",
      "  $listenerPids = $listenerPids | Select-Object -Unique",
      "}",
      "if (-not $listenerPids -or $listenerPids.Count -eq 0) { Write-Output (\"No listener found on port {0}.\" -f $port); exit 0 }",
      "$allToKill = New-Object System.Collections.Generic.HashSet[int]",
      "function Add-Children($procParentId) {",
      "  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $procParentId }",
      "  foreach ($c in $children) {",
      "    if ($allToKill.Add([int]$c.ProcessId)) { Add-Children([int]$c.ProcessId) }",
      "  }",
      "}",
      "foreach ($listenerPid in $listenerPids) {",
      "  $pIdNum = [int]$listenerPid",
      "  if ($pIdNum -gt 0) {",
      "    $allToKill.Add($pIdNum) | Out-Null",
      "    Add-Children $pIdNum",
      "  }",
      "}",
      "foreach ($procId in $allToKill) {",
      "  try {",
      "    Stop-Process -Id $procId -Force -ErrorAction Stop",
      "    Write-Output (\"Stopped PID {0}\" -f $procId)",
      "  } catch {",
      "    Write-Output (\"Failed PID {0}: {1}\" -f $procId, $_.Exception.Message)",
      "  }",
      "}",
      "Write-Output (\"Killed listener process tree(s) on port {0}.\" -f $port)"
    ].join("\n");
    const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    console.log(`\n  ${output.trim() || "Kill command executed."}`);
    return pause();
  }

  const { url } = await inquirer.prompt([
    {
      type: "input",
      name: "url",
      message: "Desktop URL",
      default: "http://127.0.0.1:4000"
    }
  ]);

  const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "pythonw" : "python");
  const args = [desktopLauncherPath, "--url", url, "--parent-pid", String(process.pid)];
  if (mode === "startBackend") {
    args.push("--start-backend", "--backend-cwd", repoRoot);
  }
  if (mode === "attach") {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const healthUrl = `${url.replace(/\/+$/, "")}/api/health`;
      const response = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        console.log(chalk.red("\n  Attach mode failed: backend health endpoint is not ready."));
        printKV("Expected", healthUrl);
        return pause();
      }
    } catch {
      console.log(chalk.red("\n  Attach mode failed: backend is not reachable."));
      printKV("Tip", "Use 'Start backend + launch desktop window' mode.");
      return pause();
    }
  }

  runDetached(pythonBin, args, repoRoot);
  console.log(chalk.green("\n  Desktop launcher started in background."));
  printKV("Python", pythonBin);
  printKV("Mode", mode === "attach" ? "attach" : "start+desktop");
  printKV("URL", url);
  await pause();
}

async function mainMenu() {
  while (true) {
    header("KiraAI Terminal Suite");
    printKV("Active Project", activeProjectId ? `#${activeProjectId}` : "None");
    const { menu } = await inquirer.prompt([
      {
        type: "list",
        name: "menu",
        message: "Choose module (core flows first)",
        pageSize: getPageSize(20),
        choices: [
          { name: "Projects", value: "projects" },
          { name: "Generate Plan", value: "genPlan" },
          { name: "View Plan History (filters)", value: "viewHistory" },
          { name: "Compare Plans", value: "comparePlans" },
          { name: "Promote Plan Baseline", value: "promote" },
          { name: "Generate Project Structure", value: "genStructure" },
          { name: "File Explorer", value: "explorer" },
          { name: "KiraAI Code Worker", value: "aiCode" },
          { name: "Advanced Tools", value: "advanced" },
          { name: "Exit", value: "exit" }
        ]
      }
    ]);
    if (menu === "exit") break;
    if (menu === "projects") await runSafe(projectsMenu);
    if (menu === "genPlan") await runSafe(generatePlanFlow);
    if (menu === "viewHistory") await runSafe(viewPlanHistoryFlow);
    if (menu === "comparePlans") await runSafe(comparePlansFlow);
    if (menu === "promote") await runSafe(promoteBaselineFlow);
    if (menu === "genStructure") await runSafe(generateStructureFlow);
    if (menu === "explorer") await runSafe(fileExplorerFlow);
    if (menu === "aiCode") await runSafe(aiCodeFlow);
    if (menu === "advanced") await runSafe(advancedToolsMenu);
  }
}

async function advancedToolsMenu() {
  while (true) {
    header("Advanced Tools");
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "Select advanced action",
      choices: [
        { name: "Summarize Codebase Folder", value: "summarize" },
        { name: "Start Desktop Version / Process Controls", value: "desktop" },
        { name: "Back", value: "back" }
      ]
    }]);
    if (action === "back") return;
    if (action === "summarize") await runSafe(summarizeCodebaseFlow);
    if (action === "desktop") await runSafe(desktopLauncherFlow);
  }
}

async function bootstrap() {
  await connectRedis();
  await mainMenu();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
