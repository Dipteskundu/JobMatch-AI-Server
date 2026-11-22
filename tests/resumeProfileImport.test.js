import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResumeProfile } from "../services/aiSkillExtractionService.js";

test("normalizes resume details into editable profile fields", () => {
  const profile = normalizeResumeProfile({
    skills: [" React ", "React"],
    technologies: ["Node.js"],
    experience_years: "4.5",
    role_titles: ["Frontend Engineer"],
    displayName: " Alex Candidate ",
    experience: [{
      company: "Acme",
      position: "Engineer",
      startDate: "2020",
      extra: "not accepted",
    }],
    education: [{ school: "Example University", degree: "BS" }],
    projects: [{ name: "JobMatch", technologies: ["React", "Node.js"] }],
    certificates: [{ name: "Cloud Certificate", issuer: "Example" }],
    email: "private@example.com",
  });

  assert.equal(profile.displayName, "Alex Candidate");
  assert.equal(profile.title, "Frontend Engineer");
  assert.equal(profile.experience_years, 4.5);
  assert.deepEqual(profile.skills, ["React"]);
  assert.deepEqual(profile.experience, [{
    company: "Acme",
    position: "Engineer",
    startDate: "2020",
    endDate: "",
    description: "",
  }]);
  assert.deepEqual(profile.projects, [{
    name: "JobMatch",
    description: "",
    technologies: "React, Node.js",
    link: "",
  }]);
  assert.equal(Object.hasOwn(profile, "email"), false);
});

test("uses empty profile collections and ignores invalid years", () => {
  const profile = normalizeResumeProfile({
    experience_years: Infinity,
    experience: "not an array",
    education: [null, { school: "" }],
  });

  assert.equal(profile.experience_years, 0);
  assert.deepEqual(profile.experience, []);
  assert.deepEqual(profile.education, []);
});
