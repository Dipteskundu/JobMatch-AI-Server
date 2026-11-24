import test from "node:test";
import assert from "node:assert/strict";

const {
  connectWithRetry,
  getDbState,
  isDbUnavailableError,
  isDnsError,
  pingDB,
  resetDnsResolver,
} = await import("../config/db.js");

function dnsFailure(message = "querySrv ETIMEOUT _mongodb._tcp.example.mongodb.net") {
  return Object.assign(new Error(message), { code: "ETIMEOUT" });
}

/**
 * Scripted MongoClient factory. `script[i]` describes attempt i+1:
 * "ok" (default), "hang", or an Error to reject with.
 */
function scriptedFactory(script) {
  const state = { created: 0, closed: 0, options: null };

  const createClient = (uri, options) => {
    state.created += 1;
    state.options = options;
    // Attempts past the end of the script repeat its last behaviour, so a
    // single-entry script means "always behave like this".
    const behavior = script[state.created - 1] ?? script[script.length - 1] ?? "ok";

    return {
      connect() {
        if (behavior === "hang") return new Promise(() => {});
        if (behavior instanceof Error) return Promise.reject(behavior);
        return Promise.resolve();
      },
      db(name) {
        return { name, command: async () => ({ ok: 1 }) };
      },
      async close() {
        state.closed += 1;
      },
    };
  };

  return { state, createClient };
}

test("connects on the first attempt without closing the live client", async () => {
  const { state, createClient } = scriptedFactory(["ok"]);

  const { client, db } = await connectWithRetry("mongodb://test", "jobs", {
    createClient,
  });

  assert.equal(state.created, 1);
  assert.equal(state.closed, 0);
  assert.equal(db.name, "jobs");
  assert.ok(client);
  // Per-attempt bounds are applied to the driver options.
  assert.ok(state.options.connectTimeoutMS > 0);
  assert.ok(state.options.serverSelectionTimeoutMS > 0);
});

test("retries after a DNS failure and succeeds on a later attempt", async () => {
  const { state, createClient } = scriptedFactory([dnsFailure(), dnsFailure(), "ok"]);

  const { db } = await connectWithRetry("mongodb://test", "jobs", {
    createClient,
    attempts: 3,
    backoffMs: 1,
  });

  assert.equal(state.created, 3);
  assert.equal(state.closed, 2); // failed attempts must not leak clients
  assert.equal(db.name, "jobs");
});

test("gives up with an actionable 503 after exhausting attempts", async () => {
  const { state, createClient } = scriptedFactory([dnsFailure()]);

  await assert.rejects(
    () =>
      connectWithRetry("mongodb://test", "jobs", {
        createClient,
        attempts: 3,
        backoffMs: 1,
      }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "ETIMEOUT");
      assert.match(error.userMessage, /Database unreachable/);
      assert.match(error.message, /after 3 attempt/);
      return true;
    },
  );

  assert.equal(state.created, 3);
  assert.equal(state.closed, 3); // every failed client was closed
});

test("time-boxes a hung connect instead of blocking a request forever", async () => {
  const { state, createClient } = scriptedFactory(["hang"]);
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      connectWithRetry("mongodb://test", "jobs", {
        createClient,
        attempts: 2,
        attemptTimeoutMs: 60,
        backoffMs: 1,
      }),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /timed out/i);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 2000, "attempt must be time-boxed");
  assert.equal(state.closed, 2, "hung clients are closed too");
});

test("isDnsError only matches resolver-class failures", () => {
  assert.equal(isDnsError(dnsFailure()), true);
  assert.equal(isDnsError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), true);
  assert.equal(isDnsError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), false);
  assert.equal(isDnsError(new Error("plain")), false);
  assert.equal(isDnsError(undefined), false);
});

test("isDbUnavailableError flags driver reachability failures for a clean 503", () => {
  assert.equal(isDbUnavailableError(dnsFailure()), true);
  assert.equal(isDbUnavailableError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(
    isDbUnavailableError(Object.assign(new Error("no primary"), { name: "MongoServerSelectionError" })),
    true,
  );
  assert.equal(
    isDbUnavailableError(Object.assign(new Error("socket reset"), { name: "MongoNetworkError" })),
    true,
  );
  assert.equal(isDbUnavailableError(new Error("validation failed")), false);
  assert.equal(isDbUnavailableError(undefined), false);
});

test("getDbState starts idle before any connection attempt", () => {
  assert.equal(getDbState(), "idle");
});

test("resetDnsResolver is safe to call and reports whether it ran", () => {
  assert.equal(typeof resetDnsResolver(), "boolean");
});

test("pingDB resolves true against a healthy database", async () => {
  const provider = async () => ({ command: async () => ({ ok: 1 }) });

  assert.equal(await pingDB(500, provider), true);
});

test("pingDB fails fast when the database never answers", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    () => pingDB(50, () => new Promise(() => {})),
    /timed out/i,
  );

  assert.ok(Date.now() - startedAt < 2000);
});

test("pingDB propagates connection failures", async () => {
  const provider = async () => {
    throw Object.assign(new Error("Database unreachable"), { status: 503 });
  };

  await assert.rejects(() => pingDB(500, provider), /Database unreachable/);
});
