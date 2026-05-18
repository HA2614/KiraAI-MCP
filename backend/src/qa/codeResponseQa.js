import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.IMAGE_GENERATION_ENABLED = "true";
process.env.IMAGE_PROVIDER = "fake";
process.env.IMAGE_MAX_PER_JOB = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJob(getCodeJob, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const job = await getCodeJob(jobId);
    if (["done", "awaiting_review", "failed", "applied", "rejected"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for code job ${jobId}`);
}

async function main() {
  const { config } = await import("../config.js");
  const { pool } = await import("../db.js");
  const { buildCodeResponseMarkdown, getCodeJob, getCodeJobAsset, startCodeJob } = await import("../codeJobs.js");
  const { resolveImageProvider, shouldGenerateImage } = await import("../imageGeneration.js");
  const { router } = await import("../routes.js");

  const qaRoot = path.join(config.fsBasePath, ".kiraai-code-response-qa");
  await mkdir(qaRoot, { recursive: true });

  try {
    const response = buildCodeResponseMarkdown({
      diffSummary: "2 file change(s) (+12 -3): frontend/src/App.jsx, backend/src/server.js",
      changedFiles: [
        { path: "frontend/src/App.jsx", additions: 10, deletions: 2 },
        { path: "backend/src/server.js", additions: 2, deletions: 1 }
      ],
      riskNotes: ["Review the isolated proposal before accepting."],
      testCommands: ["npm run qa"]
    });
    assert(response.includes("## Gedaan"), "Code response is missing Gedaan section");
    assert(response.includes("## Hoe starten/testen"), "Code response is missing test section");

    const job = await startCodeJob({
      rootPath: qaRoot,
      userPrompt: "maak een Shopify wireframe als voorbeeld",
      responseMode: "image"
    });
    const completed = await waitForJob(getCodeJob, job.id);
    assert(completed.status === "done", `Image job should finish as done, got ${completed.status}`);
    assert(completed.response_kind === "image", "Image job should be marked as image response");
    assert(completed.response_markdown.includes("Klaar"), "Image response should include the final done message");
    assert(Array.isArray(completed.assets) && completed.assets.length === 1, "Image job should store one asset");
    assert(Array.isArray(completed.changed_files) && completed.changed_files.length === 0, "Image job should not propose file changes");

    const asset = await getCodeJobAsset(completed.id, completed.assets[0].id);
    assert(asset.mime_type === "image/svg+xml", `Expected fake SVG asset, got ${asset.mime_type}`);
    assert(Buffer.isBuffer(asset.content) && asset.content.length > 100, "Stored asset content is empty");
    assert(shouldGenerateImage({ prompt: "maak een foto", responseMode: "code" }) === false, "Code mode should force code responses");
    assert(shouldGenerateImage({ prompt: "refactor component", responseMode: "image" }) === true, "Image mode should force image responses");
    assert(shouldGenerateImage({ prompt: "maak een foto", responseMode: "auto" }) === true, "Auto mode should still detect visual prompts");

    const app = express();
    app.use("/api", router);
    const server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    try {
      const address = server.address();
      const res = await fetch(`http://127.0.0.1:${address.port}/api/code-jobs/${completed.id}/assets/${asset.id}`);
      assert(res.ok, `Asset endpoint failed with ${res.status}`);
      assert((res.headers.get("content-type") || "").includes("image/svg+xml"), "Asset endpoint returned the wrong content type");
      const body = await res.text();
      assert(body.includes("<svg"), "Asset endpoint did not stream the SVG body");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    assert(resolveImageProvider("openai") === "codex_cli", "Legacy IMAGE_PROVIDER=openai should route to Codex without an OpenAI key");

    console.log("Code response QA passed");
  } finally {
    await rm(qaRoot, { recursive: true, force: true }).catch(() => null);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
