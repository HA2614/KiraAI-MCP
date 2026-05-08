import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { resolveCodexBinary } from "./codexBinary.js";
import { ExternalServiceError } from "./errors.js";
import { logWarn } from "./logger.js";
import { validatePlanOrThrow } from "./planSchema.js";

const openai = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;
const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(project) {
  return `
You are a senior technical program manager.
Be concise and practical.
Return at most 8 tasks and at most 5 milestones.
Keep each text field short.
Target under 350 output tokens.
Generate a detailed project plan as valid JSON with this exact shape:
{
  "summary": "string",
  "recommendedTechStack": ["string"],
  "taskBreakdown": [
    {"task":"string","ownerRole":"string","estimateDays":number,"dependencies":["string"]}
  ],
  "estimatedTimelineWeeks": number,
  "estimatedBudgetUsd": number,
  "risks": ["string"],
  "milestones": [{"name":"string","week":number,"deliverables":["string"]}]
}

Project details:
- Name: ${project.name}
- Goals: ${project.goals}
- Requested tech stack: ${project.tech_stack || "not specified"}
- Timeline: ${project.timeline || "not specified"}
- Budget: ${project.budget || "not specified"}
`;
}

function providerChain(providerOverride) {
  if (providerOverride) return [providerOverride];
  const chain = [config.aiProvider, ...config.aiFallbackProviders].filter(Boolean);
  return [...new Set(chain)];
}

export async function generatePlan(project, providerOverride) {
  const chain = providerChain(providerOverride);
  const errors = [];

  for (const provider of chain) {
    for (let attempt = 1; attempt <= config.aiRetryCount + 1; attempt += 1) {
      try {
        const plan = await generateByProvider(project, provider);
        return validatePlanOrThrow(plan, provider);
      } catch (error) {
        const retriable = isRetriable(error);
        errors.push({ provider, attempt, message: error.message });
        if (!retriable || attempt > config.aiRetryCount) {
          logWarn("ai_provider_failed", { provider, attempt, message: error.message });
          break;
        }
        await sleep(config.aiRetryDelayMs * attempt);
      }
    }
  }

  throw new ExternalServiceError("All AI providers failed", { attempts: errors }, "AI_PROVIDER_CHAIN_FAILED");
}

function isRetriable(error) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("tempor") ||
    msg.includes("network")
  );
}

async function generateByProvider(project, provider) {
  if (provider === "codex_cli") {
    return await generatePlanWithCodexCli(project);
  }

  if (provider === "anthropic") {
    if (!anthropic) throw new ExternalServiceError("ANTHROPIC_API_KEY is missing", null, "ANTHROPIC_NOT_CONFIGURED");
    const msg = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: "user", content: buildPrompt(project) }]
    });
    const text = msg.content.find((c) => c.type === "text")?.text || "{}";
    return parsePlanJson(text);
  }

  if (provider !== "openai") {
    throw new ExternalServiceError(`Unsupported AI provider: ${provider}`, null, "AI_PROVIDER_UNSUPPORTED");
  }
  if (!openai) throw new ExternalServiceError("OPENAI_API_KEY is missing", null, "OPENAI_NOT_CONFIGURED");

  const completion = await openai.chat.completions.create({
    model: config.openAiModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You output concise, practical project plans in strict JSON."
      },
      {
        role: "user",
        content: buildPrompt(project)
      }
    ]
  });

  const content = completion.choices[0]?.message?.content || "{}";
  return parsePlanJson(content);
}

async function generatePlanWithCodexCli(project) {
  const prompt = `${buildPrompt(project)}

Output only JSON with no markdown fences and no additional commentary.`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-plan-"));
  const outputFile = path.join(tempDir, "plan.json");

  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile
  ];
  if (config.codexModel) {
    args.push("--model", config.codexModel);
  }
  args.push(prompt);

  const codexBin = await resolveCodexBinary();
  await new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ExternalServiceError(`codex exec timed out after ${config.codexTimeoutMs}ms`, null, "CODEX_TIMEOUT"));
    }, config.codexTimeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(new ExternalServiceError(error.message, null, "CODEX_PROCESS_ERROR")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new ExternalServiceError(`codex exec failed (code ${code})`, { stderr: stderr.trim() }, "CODEX_EXIT_NON_ZERO"));
    });
  });

  try {
    const output = await readFile(outputFile, "utf8");
    return parsePlanJson(output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parsePlanJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(payload.slice(start, end + 1));
    }
    throw new ExternalServiceError("AI response was not valid JSON", null, "AI_INVALID_JSON");
  }
}
