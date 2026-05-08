import express from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { connectRedis } from "./cache.js";
import { router } from "./routes.js";
import { attachRequestId, fail } from "./response.js";
import { logError, logInfo } from "./logger.js";
import { recoverInterruptedCodeJobsOnStartup } from "./codeJobs.js";
import { recoverInterruptedMlJobsOnStartup } from "./mlMind.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultStaticDir = path.join(repoRoot, "frontend", "dist");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(attachRequestId);

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - started;
    logInfo("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs
    });
  });
  next();
});

app.use("/api", router);

const staticDir = config.staticFrontendDir ? path.resolve(config.staticFrontendDir) : defaultStaticDir;
const hasStaticBuild = existsSync(path.join(staticDir, "index.html"));

if (hasStaticBuild) {
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(staticDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.status(200).type("text/plain").send(
      "Frontend build not found. Run `npm run build` from repo root, or run frontend dev server with `npm --workspace frontend run dev`."
    );
  });
}

app.use((err, req, res, _next) => {
  const statusCode = err?.statusCode || 500;
  const code = err?.code || "INTERNAL_ERROR";
  logError("http_request_error", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    code,
    statusCode,
    message: err.message
  });
  fail(res, err?.message || "Internal server error", statusCode, code, err?.details || null);
});

async function bootstrap() {
  await connectRedis();
  const resumedCodeJobs = await recoverInterruptedCodeJobsOnStartup();
  if (resumedCodeJobs.length) {
    logInfo("code_jobs_resumed_on_startup", { count: resumedCodeJobs.length });
  }
  const resumedMlJobs = await recoverInterruptedMlJobsOnStartup();
  if (resumedMlJobs.length) {
    logInfo("ml_jobs_resumed_on_startup", { count: resumedMlJobs.length });
  }
  app.listen(config.port, () => {
    logInfo("api_started", {
      url: `http://localhost:${config.port}`,
      staticDir,
      staticEnabled: hasStaticBuild
    });
  });
}

bootstrap();
