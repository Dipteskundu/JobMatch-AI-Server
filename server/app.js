// server/app.js
//
// The Express application. It lives outside `api/` on purpose:
//   * Vercel turns every file in `api/` into its own Serverless Function, so
//     keeping the app here avoids building a second, unused function;
//   * `api/index.js` can then lazy-load this file and report a readable error
//     if the bundle ever fails to load, instead of the platform's opaque
//     FUNCTION_INVOCATION_FAILED.
// Both `api/` and `server/` sit at the repository root, so every relative
// import below is unchanged.

// `config/dotenv.js` must stay first: it loads `.env` before any other module
// reads process.env (several modules read env vars at module scope).
import "../config/dotenv.js";
import express from "express";
import cors from "cors";
import { installAsyncErrorBridge } from "../middleware/asyncErrorBridge.js";

import {
  connectDB,
  getDB,
  getDbState,
  isDbUnavailableError,
  pingDB,
  DB_UNAVAILABLE_MESSAGE,
} from "../config/db.js";
import { loadEnv } from "../config/env.js";
import { migrateDemoPasswords } from "../services/passwordMigration.js";

import jobsRoutes from "../routes/jobs.routes.js";
import companiesRoutes from "../routes/companies.routes.js";
import authRoutes from "../routes/auth.routes.js";
import dashboardRoutes from "../routes/dashboard.routes.js";
import communicationRoutes from "../routes/communication.routes.js";
import transparencyRoutes from "../routes/transparency.routes.js";
import skillTestRoutes from "../routes/skillTest.routes.js";
import resumeRoutes from "../routes/resume.routes.js";
import skillGapRoutes from "../routes/skillGapRoutes.js";
import preApplyRoutes from "../routes/preApply.routes.js";
import commVerificationRoutes from "../routes/commVerification.routes.js";
import applicationsRoutes from "../routes/applications.routes.js";
import interviewsRoutes from "../routes/interviews.routes.js";
import notificationsRoutes from "../routes/notifications.routes.js";
import chatbotRoutes from "../routes/chatbot.routes.js";
import tasksRoutes from "../routes/tasks.routes.js";
import learningRoutes from "../routes/learning.routes.js";
import interviewPrepRoutes from "../routes/interviewPrep.routes.js";
import agentsRoutes from "../routes/agents.routes.js";
import { ensureLearningIndexes } from "../config/learningIndexes.js";
import { verifyToken } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/recruiterGate.js";

// Patch Express so a rejected `async` handler reaches the error middleware
// below instead of killing the process (see middleware/asyncErrorBridge.js).
// This patches the Layer prototype, so route registration order is irrelevant.
installAsyncErrorBridge();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Learning Hub indexes: create once per process, after the first successful
// connection, without blocking boot on failure.
let indexPromise = null;
function ensureIndexesOnce() {
  if (!indexPromise) {
    indexPromise = ensureLearningIndexes(getDB()).catch((error) => {
      // Index setup failure is non-fatal; the app continues without auto-indexes
    });
  }
  return indexPromise;
}

const { env, errors, warnings, isProd } = loadEnv();

// Surface configuration problems instead of swallowing them: a missing or
// wrong env var used to fail every request with no clue in the logs.
if (warnings.length && !isProd) {
  warnings.forEach((msg) => console.warn(`[env] warning: ${msg}`));
}
if (errors.length) {
  errors.forEach((msg) => console.error(`[env] error: ${msg}`));
}

const hasFatalEnv = errors.length > 0;

// Applied app-wide (not just under /api) so `/` and `/health` send the same
// CORS headers as the API, and so OPTIONS preflight is answered for every
// path. `origin: "*"` is valid here because `credentials` is false: the client
// authenticates with an `Authorization: Bearer` header, never with cookies.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }),
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "JobMatch-AI-Server",
    envOk: !hasFatalEnv,
    warnings: !isProd ? warnings : undefined,
    timestamp: new Date().toISOString(),
  });
});

// Liveness stays HTTP 200 (documented contract). `db` is derived from the
// connection state rather than a timed ping: a cold Atlas connect takes ~6s and
// must not be misread as "down", while a failed attempt answers immediately.
app.get("/health", async (req, res) => {
  const state = getDbState();

  if (state === "error") {
    return res.status(200).json({
      success: true,
      status: "degraded",
      db: "down",
      timestamp: new Date().toISOString(),
    });
  }

  if (state === "idle") {
    // Warm the connection in the background; the next check reports the result.
    connectDB().catch(() => {});
  }

  if (state !== "connected") {
    return res.status(200).json({
      success: true,
      status: "starting",
      db: "connecting",
      timestamp: new Date().toISOString(),
    });
  }

  // Connected: confirm the handle still answers before claiming "up".
  let db = "up";
  try {
    await pingDB();
  } catch {
    db = "down";
  }

  return res.status(200).json({
    success: true,
    status: db === "up" ? "ok" : "degraded",
    db,
    timestamp: new Date().toISOString(),
  });
});

app.use(async (req, res, next) => {
  if (hasFatalEnv) {
    return res.status(500).json({
      success: false,
      message: "Server is misconfigured. Check environment variables.",
      errors: !isProd ? errors : undefined,
    });
  }

  try {
    await connectDB();
    await ensureIndexesOnce();
    await migrateDemoPasswords(getDB());
    return next();
  } catch (error) {
    error.status = error.status || 500;
    return next(error);
  }
});

// Everything under /api needs a JWT except the guest-browsable reads below.
const PUBLIC_GET = [
  /^\/jobs$/,
  /^\/jobs\/[^/]+$/,
  /^\/jobs\/[^/]+\/fit$/,
  /^\/companies$/,
  /^\/v1\/companies$/,
  /^\/v1\/learning\/paths$/,
  /^\/v1\/learning\/paths\/[^/]+$/,
  /^\/v1\/assessments$/,
];

const ADMIN_ONLY = [/^\/admin\//, /^\/dashboard\/admin$/, /^\/v1\/admin\//];

app.use("/api", (req, res, next) => {
  const path = req.path.replace(/\/+$/, "") || "/";

  if (req.method === "POST" && ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout", "/auth/google"].includes(path)) {
    return next();
  }
  if (req.method === "POST" && path === "/chatbot/ask-public") {
    return next();
  }
  if (req.method === "GET" && PUBLIC_GET.some((re) => re.test(path))) {
    return next();
  }

  return verifyToken(req, res, () => {
    if (ADMIN_ONLY.some((re) => re.test(path))) return requireAdmin(req, res, next);
    return next();
  });
});

app.use("/api/auth", authRoutes);
app.use(jobsRoutes);
app.use(companiesRoutes);
app.use(dashboardRoutes);
app.use(communicationRoutes);
app.use(transparencyRoutes);
app.use(skillTestRoutes);
app.use(resumeRoutes);
app.use(skillGapRoutes);
app.use(preApplyRoutes);
app.use(commVerificationRoutes);
app.use(applicationsRoutes);
app.use(interviewsRoutes);
app.use(notificationsRoutes);
app.use(chatbotRoutes);
app.use(tasksRoutes);
app.use(learningRoutes);
app.use(interviewPrepRoutes);
app.use(agentsRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON payload.",
    });
  }

  const status = err.status || (isDbUnavailableError(err) ? 503 : 500);
  const message =
    err.userMessage ||
    (status === 503
      ? DB_UNAVAILABLE_MESSAGE
      : status === 500
        ? "Internal server error"
        : err.message);

  res.status(status).json({
    success: false,
    message,
    error: !isProd ? err.message : undefined,
    // Stacks are noise for expected failures (e.g. the database being down).
    stack: !isProd && status === 500 ? err.stack : undefined,
  });
});

export default app;
