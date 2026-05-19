import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectRedis, redis } from "./cache.js";
import { query } from "./db.js";
import { generatePlan } from "./ai.js";
import { summarizeCodebaseWithCodex } from "./codexCodebaseSummary.js";
import { saveCodebaseSummary } from "./analysisStore.js";

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function parseJsonInput(value, fallback = null) {
  if (!value || typeof value !== "string") return fallback;
  return JSON.parse(value);
}

const server = new McpServer({
  name: "mcp-project-manager",
  version: "1.1.0"
});

server.tool(
  "create_project",
  "Create a new project record.",
  {
    name: z.string().min(2),
    goals: z.string().min(5),
    techStack: z.string().optional().default(""),
    timeline: z.string().optional().default(""),
    budget: z.string().optional().default("")
  },
  async ({ name, goals, techStack, timeline, budget }) => {
    const result = await query(
      `INSERT INTO projects (name, goals, tech_stack, timeline, budget)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [name, goals, techStack, timeline, budget]
    );
    return textResult(result.rows[0]);
  }
);

server.tool(
  "summarize_codebase",
  "Read and analyze all text files in a folder and return project summary + per-file roles + pipeline diagram.",
  {
    targetPath: z.string().min(1)
  },
  async ({ targetPath }) => {
    const result = await summarizeCodebaseWithCodex(targetPath);
    const saved = await saveCodebaseSummary(result);
    return textResult({
      summaryId: saved.id,
      root: result.root,
      title: result.title,
      description: result.description,
      model: result.model,
      fullReport: result.fullReport
    });
  }
);

server.tool("list_projects", "List all projects.", {}, async () => {
  const result = await query("SELECT * FROM projects ORDER BY created_at DESC");
  return textResult(result.rows);
});

server.tool(
  "get_project",
  "Get one project and all plan versions.",
  { projectId: z.number().int().positive() },
  async ({ projectId }) => {
    const cacheKey = `project:${projectId}`;
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      return textResult(JSON.parse(cached));
    }

    const project = await query("SELECT * FROM projects WHERE id=$1", [projectId]);
    if (!project.rowCount) throw new Error("Project not found");
    const plans = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC",
      [projectId]
    );
    const payload = { ...project.rows[0], plans: plans.rows };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", 120).catch(() => null);
    return textResult(payload);
  }
);

server.tool(
  "generate_plan",
  "Generate a new AI plan version for a project.",
  {
    projectId: z.number().int().positive(),
    provider: z.enum(["codex_cli", "claude_cli", "openai", "anthropic"]).optional()
  },
  async ({ projectId, provider }) => {
    const projectResult = await query("SELECT * FROM projects WHERE id=$1", [projectId]);
    if (!projectResult.rowCount) throw new Error("Project not found");
    const project = projectResult.rows[0];
    const latest = await query(
      "SELECT COALESCE(MAX(version), 0) AS version FROM project_plans WHERE project_id=$1",
      [projectId]
    );
    const nextVersion = Number(latest.rows[0].version) + 1;
    const planJson = await generatePlan(project, provider);
    const insert = await query(
      `INSERT INTO project_plans (project_id, version, plan_json, status, provider)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [projectId, nextVersion, planJson, "pending", provider || null]
    );
    await redis.del(`project:${projectId}`).catch(() => null);
    return textResult(insert.rows[0]);
  }
);

server.tool(
  "list_plans",
  "List plans for a project with optional status filter.",
  {
    projectId: z.number().int().positive(),
    status: z.string().optional(),
    limit: z.number().int().positive().optional().default(20),
    offset: z.number().int().nonnegative().optional().default(0)
  },
  async ({ projectId, status, limit, offset }) => {
    const params = [projectId];
    const where = ["project_id=$1"];
    if (status) {
      params.push(status);
      where.push(`status=$${params.length}`);
    }
    params.push(limit);
    params.push(offset);
    const sql = `SELECT * FROM project_plans WHERE ${where.join(" AND ")} ORDER BY version DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const rows = await query(sql, params);
    return textResult(rows.rows);
  }
);

server.tool(
  "compare_plans",
  "Compare latest plan against a prior version.",
  {
    projectId: z.number().int().positive(),
    againstVersion: z.number().int().positive()
  },
  async ({ projectId, againstVersion }) => {
    const latestResult = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC LIMIT 1",
      [projectId]
    );
    if (!latestResult.rowCount) throw new Error("No plans found");

    const oldResult = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 AND version=$2 LIMIT 1",
      [projectId, againstVersion]
    );
    if (!oldResult.rowCount) throw new Error("Compared version not found");

    const latest = latestResult.rows[0];
    const prior = oldResult.rows[0];
    const latestTasks = (latest.plan_json?.taskBreakdown || []).map((t) => t.task);
    const priorTasks = (prior.plan_json?.taskBreakdown || []).map((t) => t.task);

    return textResult({
      latestVersion: latest.version,
      comparedVersion: prior.version,
      summaryChanged: latest.plan_json?.summary !== prior.plan_json?.summary,
      addedTasks: latestTasks.filter((t) => !priorTasks.includes(t)),
      removedTasks: priorTasks.filter((t) => !latestTasks.includes(t))
    });
  }
);

server.tool(
  "promote_plan_baseline",
  "Mark a plan version as baseline.",
  { planId: z.number().int().positive() },
  async ({ planId }) => {
    const planResult = await query("SELECT * FROM project_plans WHERE id=$1", [planId]);
    if (!planResult.rowCount) throw new Error("Plan not found");
    const plan = planResult.rows[0];

    await query("UPDATE project_plans SET is_baseline=FALSE WHERE project_id=$1", [plan.project_id]);
    const updated = await query(
      "UPDATE project_plans SET is_baseline=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *",
      [planId]
    );
    await redis.del(`project:${plan.project_id}`).catch(() => null);
    return textResult(updated.rows[0]);
  }
);

server.tool(
  "submit_plan_feedback",
  "Accept, reject, modify, or mark needs_review for a plan.",
  {
    planId: z.number().int().positive(),
    action: z.enum(["accept", "reject", "modify", "needs_review"]),
    comments: z.string().optional().default(""),
    modifiedPlanJson: z.string().optional()
  },
  async ({ planId, action, comments, modifiedPlanJson }) => {
    const planResult = await query("SELECT * FROM project_plans WHERE id=$1", [planId]);
    if (!planResult.rowCount) throw new Error("Plan not found");
    const currentPlan = planResult.rows[0];

    let updatedPlan = currentPlan.plan_json;
    let status = currentPlan.status;

    if (action === "accept") status = "accepted";
    if (action === "reject") status = "rejected";
    if (action === "needs_review") status = "needs_review";
    if (action === "modify") {
      updatedPlan = parseJsonInput(modifiedPlanJson, currentPlan.plan_json);
      status = "modified";
    }

    const updated = await query(
      `UPDATE project_plans
       SET status=$1, plan_json=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [status, updatedPlan, planId]
    );

    await query(
      `INSERT INTO plan_feedback (plan_id, action, comments, modified_plan_json)
       VALUES ($1,$2,$3,$4)`,
      [planId, action, comments, action === "modify" ? updatedPlan : null]
    );

    await redis.del(`project:${currentPlan.project_id}`).catch(() => null);
    return textResult(updated.rows[0]);
  }
);

async function main() {
  await connectRedis();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed:", error);
  process.exit(1);
});
