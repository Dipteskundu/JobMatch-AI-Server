import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("exits with an actionable error when the backend port is occupied", async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, resolve);
  });

  const port = blocker.address().port;
  const isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jobmatch-startup-"));
  const child = spawn(process.execPath, [path.join(backendRoot, "index.js")], {
    cwd: isolatedCwd,
    env: { ...process.env, PORT: String(port), VERCEL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const result = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Backend did not exit after failing to bind the occupied port"));
      }, 10000);

      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
    });

    assert.equal(result.code, 1);
    assert.match(result.output, new RegExp(`Port ${port} is already in use`));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(isolatedCwd, { recursive: true, force: true });
  }
});
