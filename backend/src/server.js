import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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
import { authRouter, bootstrapAuth, isAllowedOrigin, optionalAuth, originGuard, requireAuth } from "./auth.js";

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultStaticDir = path.join(repoRoot, "frontend", "dist");

function corsOptions(req, callback) {
  const origin = req.headers.origin;
  if (!origin) return callback(null, { origin: false, credentials: true });
  if (!config.authEnabled && !config.corsAllowedOrigins.length) {
    return callback(null, { origin: true, credentials: true });
  }
  return callback(null, {
    origin: isAllowedOrigin(req, origin),
    credentials: true
  });
}

const globalApiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => fail(res, "Too many requests", 429, "RATE_LIMITED")
});

const loginLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => fail(res, "Too many login attempts", 429, "RATE_LIMITED")
});

const expensiveLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.expensiveRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => fail(res, "Too many expensive requests", 429, "RATE_LIMITED")
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors(corsOptions));
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

app.use("/api", globalApiLimiter);
app.use("/api", optionalAuth);
app.use("/api", originGuard);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);
app.use(["/api/code-jobs", "/api/ml", "/api/analysis"], expensiveLimiter);
app.use("/api", router);

const staticDir = config.staticFrontendDir ? path.resolve(config.staticFrontendDir) : defaultStaticDir;
const hasStaticBuild = existsSync(path.join(staticDir, "index.html"));

if (hasStaticBuild) {
  app.use(express.static(staticDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === "index.html") {
        res.setHeader("Cache-Control", "no-store");
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  }));
  app.get("/assets/*", (_req, res) => {
    res.status(404).type("text/plain").send("Frontend asset not found. Refresh the browser after the latest KiraAI rebuild.");
  });
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.setHeader("Cache-Control", "no-store");
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
  const exposed = err?.expose ?? statusCode < 500;
  const message = exposed ? (err?.message || "Request failed") : "Internal server error";
  const details = exposed ? (err?.details || null) : null;
  logError("http_request_error", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    code,
    statusCode,
    message: err.message
  });
  fail(res, message, statusCode, code, details);
});

async function bootstrap() {
  await connectRedis();
  await bootstrapAuth();
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
