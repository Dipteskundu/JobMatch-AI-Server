// Verifies the degraded-database contract: a dead MongoDB must produce a clean
// 503 with an actionable message (no stack trace), while /health stays HTTP 200
// and reports the failure so it's diagnosable in one curl.
//
// VERCEL=1 disables dotenv's `override` so this test can inject an unreachable
// MONGO_URI without the real .env winning.
import test from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL = "1";
process.env.MONGO_URI = "mongodb://127.0.0.1:9/jobmatch_unreachable_test";
process.env.MONGO_DB_NAME = "jobmatch_unreachable_test";
delete process.env.MONGODB_URI;

const { default: app } = await import("../api/index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("/health is fast and honest before the first connection attempt finishes", async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    // Never claim "down" while an attempt is still running.
    assert.equal(body.db, "connecting");
    assert.equal(body.status, "starting");
  } finally {
    server.close();
  }
});

test("public APIs fail with an actionable 503 when the database is down", async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.match(body.message, /Database unreachable/);
    // Expected failures must not dump a stack trace at the client.
    assert.equal(body.stack, undefined);
  } finally {
    server.close();
  }
});

test("/health stays 200 and reports the database as down after a failed attempt", async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.db, "down");
    assert.equal(body.status, "degraded");
  } finally {
    server.close();
  }
});
