import test from "node:test";
import assert from "node:assert/strict";
import { extractResumeProfile } from "../services/localResumeExtractionService.js";

const resumeText = `
Alex Candidate
Senior Software Engineer
Location: Dhaka, Bangladesh
Phone: +880 1712 345678
https://linkedin.com/in/alex-candidate
https://alexcandidate.dev
Portfolio: https://behance.net/alex-candidate

Professional Summary
Software engineer building accessible web applications.

Skills
JavaScript, React, Node.js, Problem Solving

Work Experience
Senior Software Engineer at Acme
Jan 2020 - Present
Built a hiring platform with React and Node.js.

Education
Example University
Bachelor of Science in Computer Science
2015 - 2019

Projects
JobMatch Platform
Built a job matching application with React and MongoDB.

Certifications
Cloud Developer Certificate
Issuer: Example Academy
`;

test("extracts common profile fields and labeled sections without a provider", () => {
  const profile = extractResumeProfile(resumeText);

  assert.equal(profile.displayName, "Alex Candidate");
  assert.equal(profile.title, "Senior Software Engineer");
  assert.equal(profile.location, "Dhaka, Bangladesh");
  assert.equal(profile.phone, "+880 1712 345678");
  assert.match(profile.bio, /accessible web applications/i);
  assert.ok(profile.skills.includes("JavaScript"));
  assert.ok(profile.skills.includes("Problem Solving"));
  assert.ok(profile.technologies.includes("React"));
  assert.ok(profile.role_titles.includes("Senior Software Engineer"));
  assert.deepEqual(profile.experience[0], {
    company: "Acme",
    position: "Senior Software Engineer",
    startDate: "Jan 2020",
    endDate: "Present",
    description: "Built a hiring platform with React and Node.js.",
  });
  assert.equal(profile.education[0].school, "Example University");
  assert.equal(profile.education[0].degree, "Bachelor of Science");
  assert.equal(profile.education[0].field, "Computer Science");
  assert.equal(profile.projects[0].name, "JobMatch Platform");
  assert.ok(profile.projects[0].technologies.includes("React"));
  assert.equal(profile.certificates[0].issuer, "Example Academy");
  assert.equal(profile.linkedin, "https://linkedin.com/in/alex-candidate");
  assert.equal(profile.website, "https://alexcandidate.dev");
  assert.equal(profile.portfolioUrl, "https://behance.net/alex-candidate");
  assert.ok(profile.experience_years > 0);
});

test("does not mistake incidental C characters for the C skill", () => {
  const profile = extractResumeProfile("Alex Candidate\nSkills\nReact, Node.js\n");

  assert.ok(profile.technologies.includes("Node.js"));
  assert.equal(profile.technologies.includes("C"), false);
});

test("returns empty collections instead of inventing missing resume sections", () => {
  const profile = extractResumeProfile("Candidate text without recognized sections.");

  assert.deepEqual(profile.experience, []);
  assert.deepEqual(profile.education, []);
  assert.deepEqual(profile.projects, []);
  assert.deepEqual(profile.certificates, []);
});
