// config/db.js
// MongoDB connection with serverless-friendly caching, bounded retries and a
// DNS resolver that can recover from a network drop at process start.

import { MongoClient } from "mongodb";
import dns from "node:dns";
import { loadEnv } from "./env.js";

// One attempt must never outlive this: it bounds how long a single API request
// can block while the database is unreachable (the driver's own defaults are
// ~30s, which made every request hang before failing). Worst case for a dead
// database is 3 attempts + backoff ≈ 16s, still inside the client's 30s budget.
const ATTEMPT_TIMEOUT_MS = 5000;
const CONNECT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 300;

// Failure modes that a resolver-channel reset may fix.
const DNS_ERROR_CODES = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ESERVFAIL",
  "EREFUSED",
  "ENODATA",
  "ENOTFOUND",
]);

const globalCache = globalThis.__mongoCache || {
  client: null,
  db: null,
  promise: null,
  lastError: null,
};

globalThis.__mongoCache = globalCache;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject once `ms` elapses so a hung connect cannot stall a request forever. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message || `Timed out after ${ms}ms`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isDnsError(error) {
  return Boolean(error && DNS_ERROR_CODES.has(error.code));
}

// Driver errors that mean "cannot reach the database right now" and deserve a
// clean 503 instead of a generic 500 — including a drop that happens *after*
// a successful connect (the driver re-selects a server on every query).
const DB_UNAVAILABLE_NAMES = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoTopologyClosedError",
]);

export const DB_UNAVAILABLE_MESSAGE =
  "Database unreachable. Check the network connection, then restart the server.";

export function isDbUnavailableError(error) {
  if (!error) return false;
  if (error.status === 503 || isDnsError(error)) return true;
  return DB_UNAVAILABLE_NAMES.has(error.name);
}

/**
 * Coarse connection state for the health endpoint: "connected" (handle ready),
 * "connecting" (attempt in flight), "error" (last attempt failed), "idle"
 * (nothing tried yet). State-based rather than a timed ping, because a cold
 * Atlas connect takes ~6s and would otherwise be misreported as down.
 */
export function getDbState() {
  if (globalCache.db) return "connected";
  if (globalCache.promise) return "connecting";
  return globalCache.lastError ? "error" : "idle";
}

/**
 * c-ares captures the OS nameserver list the first time a process resolves a
 * name. When that moment lands inside a Wi-Fi drop, the resolver channel stays
 * wedged for the life of the process — every later query returns
 * `querySrv ETIMEOUT` even though the network is fine. Re-applying the current
 * server list forces the channel to rebuild its sockets. Best effort: a
 * restart is the guaranteed fix.
 */
export function resetDnsResolver() {
  try {
    const servers = dns.getServers();
    if (!servers || servers.length === 0) return false;
    dns.setServers(servers);
    return true;
  } catch {
    return false;
  }
}

/** Open one client and resolve it to a `Db`, hard-bounded by `attemptTimeoutMs`. */
async function openClient(uri, dbName, createClient, attemptTimeoutMs) {
  const client = createClient(uri, {
    connectTimeoutMS: attemptTimeoutMs,
    serverSelectionTimeoutMS: attemptTimeoutMs,
  });

  try {
    const db = await withTimeout(
      client.connect().then(() => client.db(dbName)),
      attemptTimeoutMs,
      `MongoDB connection timed out after ${attemptTimeoutMs}ms`,
    );
    return { client, db };
  } catch (error) {
    // Never leak a half-open client: every failed attempt used to keep its
    // MongoClient instance alive for the life of the process.
    await Promise.resolve(client.close()).catch(() => {});
    throw error;
  }
}

/**
 * Connect with bounded retries. Each attempt is individually time-boxed and a
 * DNS-class failure triggers a resolver-channel reset before the next try.
 *
 * `options` exists for tests: `createClient`, `attempts`, `attemptTimeoutMs`,
 * `backoffMs`.
 */
export async function connectWithRetry(uri, dbName, options = {}) {
  const createClient = options.createClient || ((u, o) => new MongoClient(u, o));
  const attempts = options.attempts ?? CONNECT_ATTEMPTS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? RETRY_BACKOFF_MS;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await openClient(uri, dbName, createClient, attemptTimeoutMs);
    } catch (error) {
      lastError = error;
      if (isDnsError(error)) resetDnsResolver();
      if (attempt < attempts) await delay(backoffMs * attempt);
    }
  }

  const failure = new Error(
    `Could not connect to MongoDB after ${attempts} attempt(s): ${lastError?.message || "unknown error"}`,
  );
  failure.code = lastError?.code || "EMONGO";
  failure.cause = lastError;
  // Surfaced by the API error handler as a clean, actionable message.
  failure.status = 503;
  failure.userMessage = DB_UNAVAILABLE_MESSAGE;
  throw failure;
}

async function connectDB() {
  const { env } = loadEnv();
  const uri = env.MONGODB_URI;
  const dbName = env.MONGO_DB_NAME;

  if (!uri) {
    throw new Error("MONGODB_URI is missing. Configure it in your environment variables.");
  }

  if (globalCache.db) return globalCache.db;

  if (!globalCache.promise) {
    globalCache.promise = connectWithRetry(uri, dbName)
      .then(({ client, db }) => {
        globalCache.client = client;
        globalCache.db = db;
        globalCache.lastError = null;
        return db;
      })
      .catch((error) => {
        // Clear the cache so the next request retries from scratch.
        globalCache.promise = null;
        globalCache.lastError = error;
        throw error;
      });
  }

  return globalCache.promise;
}

function getDB() {
  if (!globalCache.db) {
    throw new Error("Database not initialized. Call connectDB() first.");
  }
  return globalCache.db;
}

/**
 * Cheap liveness probe for the health endpoint. Bounded by `timeoutMs` so a
 * dead database answers `/health` quickly instead of hanging it.
 *
 * `provider` is injectable for tests.
 */
async function pingDB(timeoutMs = 3000, provider = connectDB) {
  return withTimeout(
    (async () => {
      const db = await provider();
      await db.command({ ping: 1 });
      return true;
    })(),
    timeoutMs,
    `Database ping timed out after ${timeoutMs}ms`,
  );
}

/** Drop the cached connection (tests / forced reconnect). */
async function resetDBConnection() {
  const { client } = globalCache;
  globalCache.client = null;
  globalCache.db = null;
  globalCache.promise = null;
  globalCache.lastError = null;
  if (client) await Promise.resolve(client.close()).catch(() => {});
}

export { connectDB, getDB, pingDB, resetDBConnection };
