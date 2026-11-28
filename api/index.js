// api/index.js
//
// Vercel serverless entry point.
//
// This file is deliberately tiny and dependency-free. Its only jobs are:
//
//   1. install process-level safety nets before anything else can reject,
//   2. lazy-load the real application (`server/app.js`) inside a try/catch,
//   3. turn ANY load failure into a readable JSON response instead of Vercel's
//      opaque `FUNCTION_INVOCATION_FAILED`.
//
// Before this wrapper existed, a module-scope failure anywhere in the import
// graph (a native binding that would not load, a missing traced file, a thrown
// error at module scope) made `compileUserCode()` throw and every single route —
// including `/` and `/health` — returned HTTP 500 with no diagnostic at all.
//
// Nothing heavy is imported here on purpose: this module must be able to load
// in order to explain why the rest of the app could not.

let appPromise = null;
let loadError = null;

function loadApp() {
  if (!appPromise) {
    appPromise = import("../server/app.js").then(
      (module) => {
        const app = module?.default;
        if (typeof app !== "function") {
          throw new Error(
            "server/app.js did not export an Express application as its default export.",
          );
        }
        // Vercel decides whether to inject its own req/res helpers with
        // `typeof listener.listen !== 'function'` — the same test it uses to
        // recognise an Express server. Exposing a real `listen` keeps Vercel's
        // helpers off `res`, so Express keeps full control of `res.send`,
        // `res.json` and the body parser.
        handler.listen = (...args) => app.listen(...args);
        return app;
      },
      (error) => {
        loadError = error;
        throw error;
      },
    );
  }
  return appPromise;
}

function describe(error) {
  const message = String(error?.message || error || "Unknown error").replace(
    /[\r\n\t]+/g,
    " ",
  );
  return {
    message: message.slice(0, 400),
    name: String(error?.name || "Error").slice(0, 80),
    code: error?.code ? String(error.code).slice(0, 80) : undefined,
  };
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  try {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (error) {
    console.error("[bootstrap] failed to write the diagnostic response:", error);
  }
}

function reportLoadFailure(res, error) {
  const detail = describe(error);
  console.error(
    "[bootstrap] FAILED to load server/app.js:",
    error?.stack || String(error),
  );

  sendJson(res, 500, {
    success: false,
    stage: "bootstrap",
    message: `The API failed to load: ${detail.message}`,
    name: detail.name,
    code: detail.code,
    node: process.version,
    // Only expose the stack outside production; the message above already
    // carries the actionable part (module name, missing file, binding error).
    stack: process.env.NODE_ENV === "production" ? undefined : error?.stack,
    timestamp: new Date().toISOString(),
  });
}

async function handler(req, res) {
  let app;
  try {
    app = await loadApp();
  } catch (error) {
    // Cached by loadApp(): a module-load failure is deterministic, so there is
    // no point retrying it on every request — but we still answer each one.
    return reportLoadFailure(res, error || loadError);
  }

  try {
    return app(req, res);
  } catch (error) {
    console.error(
      "[bootstrap] the request handler threw:",
      error?.stack || String(error),
    );
    return sendJson(res, 500, {
      success: false,
      stage: "request",
      message: "Internal server error",
      node: process.version,
      timestamp: new Date().toISOString(),
    });
  }
}

// Vercel's `serverless-handler` skips its own helper injection when the
// listener exposes `.listen`, which is how it recognises an Express server.
// Until the app has loaded there is nothing to listen on; after a successful
// load `loadApp()` replaces this with the real `app.listen`.
handler.listen = function notLoadedYet() {
  throw new Error(
    "The API application has not loaded yet, so it cannot listen.",
  );
};

// ── Process-level safety nets ────────────────────────────────────────────────
// Without these, a single unhandled rejection (Node >= 15 treats them as fatal)
// or uncaught exception anywhere in the process takes down every in-flight
// request and makes Vercel report FUNCTION_INVOCATION_FAILED with no stack.
// We log loudly and stay alive: the affected request still fails through the
// normal error middleware, but the function instance keeps serving.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[process] unhandledRejection:",
    reason instanceof Error ? reason.stack || String(reason) : String(reason),
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "[process] uncaughtException:",
    error?.stack || String(error),
  );
});

export default handler;
