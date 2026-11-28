// middleware/asyncErrorBridge.js
//
// Express 4 does NOT await the promise returned by an `async` route handler.
// When such a handler rejects, two things happen:
//   1. the request never gets a response (it hangs until the platform timeout),
//   2. the rejection escapes to the process, and on Node >= 15 an unhandled
//      rejection is fatal — which on Vercel shows up as FUNCTION_INVOCATION_FAILED.
//
// This patches Express's internal Layer so a promise returned by a handler is
// routed into the normal error middleware. It is the same approach as the
// `express-async-errors` package, vendored here so the safety guards below stay
// under our control:
//   * `next()` is only ever called once per request,
//   * a rejection that arrives after the response was already flushed is logged
//     instead of triggering a second (header-already-sent) failure.
//
// The patch is installed at request time via the prototype, so it applies to
// routers that were created before or after this module is loaded.

import { createRequire } from "module";

const require = createRequire(import.meta.url);

let installed = false;

function isPromiseLike(value) {
  return Boolean(value) && typeof value.then === "function";
}

function logLateRejection(error) {
  const detail = error && error.stack ? error.stack : String(error);
  console.error(
    "[async-errors] handler rejected after the response started:",
    detail,
  );
}

/**
 * Wrap `next` so it can only fire once for a single request.
 * Returns { next, isSettled }.
 */
function once(next, state) {
  return function guardedNext(...args) {
    if (state.settled) return undefined;
    state.settled = true;
    return next(...args);
  };
}

function attachHandlers(Layer) {
  const proto = Layer.prototype;

  if (typeof proto.handle_request === "function") {
    proto.handle_request = function bridgeHandleRequest(req, res, next) {
      const fn = this.handle;

      // Same contract as Express: 4-argument handlers are error handlers.
      if (fn.length > 3) return next();

      const state = { settled: false };
      const guardedNext = once(next, state);

      try {
        const result = fn(req, res, guardedNext);
        if (isPromiseLike(result)) {
          result.then(undefined, (error) => {
            if (state.settled || res.headersSent) {
              logLateRejection(error);
              return;
            }
            state.settled = true;
            next(error);
          });
        }
        return result;
      } catch (error) {
        if (state.settled || res.headersSent) {
          logLateRejection(error);
          return undefined;
        }
        state.settled = true;
        return next(error);
      }
    };
  }

  if (typeof proto.handle_error === "function") {
    proto.handle_error = function bridgeHandleError(error, req, res, next) {
      const fn = this.handle;
      if (fn.length !== 4) return next(error);

      const state = { settled: false };
      const guardedNext = once(next, state);

      try {
        const result = fn(error, req, res, guardedNext);
        if (isPromiseLike(result)) {
          result.then(undefined, (nextError) => {
            if (state.settled || res.headersSent) {
              logLateRejection(nextError);
              return;
            }
            state.settled = true;
            next(nextError);
          });
        }
        return result;
      } catch (nextError) {
        if (state.settled || res.headersSent) {
          logLateRejection(nextError);
          return undefined;
        }
        state.settled = true;
        return next(nextError);
      }
    };
  }

  // Keep a marker so a double install is a no-op.
  try {
    Object.defineProperty(proto, "__jobmatchAsyncBridge", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Non-fatal: worst case we patch twice, which is idempotent by design.
  }

  return true;
}

/**
 * Install the bridge. Returns true when async handlers will now reach the
 * Express error middleware, false when the Express internals could not be
 * located (in which case we log a warning instead of failing the boot).
 */
export function installAsyncErrorBridge() {
  if (installed) return true;

  let Layer;
  try {
    Layer = require("express/lib/router/layer");
  } catch (error) {
    console.warn(
      `[async-errors] could not load Express internals: ${error?.message}. Async route errors will not reach the error middleware.`,
    );
    return false;
  }

  if (!Layer?.prototype || typeof Layer.prototype.handle_request !== "function") {
    console.warn(
      "[async-errors] unexpected Express layout: Layer.handle_request not found. Async route errors will not reach the error middleware.",
    );
    return false;
  }

  if (Layer.prototype.__jobmatchAsyncBridge) {
    installed = true;
    return true;
  }

  installed = attachHandlers(Layer);
  return installed;
}
