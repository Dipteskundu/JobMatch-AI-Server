import test from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY = "";
const { uploadResume } = await import("../controllers/resumeController.js");

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("profile import returns a preview without writing to the database", async () => {
  const response = createResponse();
  await uploadResume(
    {
      body: { profileImport: "true" },
      user: { uid: "candidate-123" },
      file: {
        buffer: Buffer.from("React and Node.js developer"),
        originalname: "resume.txt",
        mimetype: "text/plain",
        size: 28,
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.skills.includes("React"));
  assert.ok(response.body.data.skills.includes("Node.js"));
  assert.equal(response.body.data.skills.includes("C"), false);
  assert.deepEqual(response.body.data.profile.experience, []);
  assert.match(response.body.warning, /basic keyword extraction/i);
});

test("profile import requires the authenticated candidate identity", async () => {
  const response = createResponse();
  await uploadResume(
    {
      body: { profileImport: "true", candidateId: "another-user" },
      file: {
        buffer: Buffer.from("Resume text"),
        originalname: "resume.txt",
        mimetype: "text/plain",
        size: 11,
      },
    },
    response,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.message, "Authentication is required");
});
