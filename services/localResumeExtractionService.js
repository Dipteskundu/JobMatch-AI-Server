const TECHNOLOGIES = [
  "JavaScript", "TypeScript", "React Native", "React", "Next.js", "Node.js",
  "Express", "MongoDB", "PostgreSQL", "MySQL", "Firebase", "Python", "Java",
  "C++", "C#", "C", "Tailwind CSS", "Docker", "Kubernetes", "AWS", "Azure",
  "GCP", "Git", "Redux", "HTML", "CSS", "GraphQL", "REST API", "Redis",
  "Linux", "Figma", "Selenium", "Jest", "Cypress", "Vue.js", "Angular",
];

const GENERAL_SKILLS = [
  "Agile", "Communication", "Leadership", "Project Management",
  "Problem Solving", "Teamwork", "Data Analysis", "Customer Service",
  "Strategic Planning", "Time Management", "Technical Writing",
];

const SECTION_ALIASES = new Map([
  ["summary", "summary"],
  ["professional summary", "summary"],
  ["profile", "summary"],
  ["objective", "summary"],
  ["career objective", "summary"],
  ["skills", "skills"],
  ["technical skills", "skills"],
  ["core skills", "skills"],
  ["core competencies", "skills"],
  ["competencies", "skills"],
  ["skills and expertise", "skills"],
  ["professional skills", "skills"],
  ["work experience", "experience"],
  ["professional experience", "experience"],
  ["experience", "experience"],
  ["employment history", "experience"],
  ["professional background", "experience"],
  ["education", "education"],
  ["academic background", "education"],
  ["projects", "projects"],
  ["selected projects", "projects"],
  ["certifications", "certificates"],
  ["certification", "certificates"],
  ["certificates", "certificates"],
  ["licenses and certifications", "certificates"],
]);

const ROLE_PATTERN =
  /\b(engineer|developer|programmer|analyst|designer|manager|administrator|architect|consultant|specialist|recruiter|scientist|accountant|teacher|director|coordinator|intern|technician|researcher|writer|marketer|sales|product owner|product manager|scrum master)\b/i;
const DATE_TOKEN = "(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+)?(?:19|20)\\d{2}";
const DATE_RANGE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to|through)\\s*(present|current|${DATE_TOKEN})`,
  "i",
);

function cleanLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/^[\s•●▪*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTerms(text, terms) {
  return terms.filter((term) => {
    const pattern = new RegExp(
      `(^|[^a-z0-9+#])${escapeRegExp(term)}(?=$|[^a-z0-9+#])`,
      "i",
    );
    return pattern.test(text);
  });
}

function getSectionName(line) {
  const heading = cleanLine(line)
    .replace(/^#+\s*/, "")
    .replace(/:$/, "")
    .toLowerCase();
  return SECTION_ALIASES.get(heading) || null;
}

function splitResumeSections(text) {
  const sections = {
    intro: [],
    summary: [],
    skills: [],
    experience: [],
    education: [],
    projects: [],
    certificates: [],
  };
  let current = "intro";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    if (!line) {
      if (sections[current].at(-1) !== "") sections[current].push("");
      continue;
    }

    const colonIndex = line.indexOf(":");
    const label = colonIndex > -1 ? line.slice(0, colonIndex) : line;
    const section = getSectionName(label);
    if (section) {
      current = section;
      const remainder = colonIndex > -1 ? cleanLine(line.slice(colonIndex + 1)) : "";
      if (remainder) sections[current].push(remainder);
      continue;
    }

    sections[current].push(line);
  }

  return sections;
}

function readLabeledValue(text, labels) {
  const labelsPattern = labels.map(escapeRegExp).join("|");
  return text.match(new RegExp(`(?:^|\\n)\\s*(?:${labelsPattern})\\s*:\\s*([^\\n]+)`, "i"))?.[1]
    ?.trim() || "";
}

function firstLikelyName(lines) {
  for (const line of lines.slice(0, 8)) {
    const candidate = cleanLine(line).replace(/[|,].*$/, "").trim();
    const words = candidate.split(/\s+/);
    if (
      words.length >= 2 &&
      words.length <= 4 &&
      /^[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3}$/u.test(candidate) &&
      !ROLE_PATTERN.test(candidate) &&
      !/@|https?:|www\./i.test(candidate)
    ) {
      return candidate;
    }
  }
  return "";
}

function getDateRange(line) {
  const match = line.match(DATE_RANGE);
  if (!match) return null;
  return { startDate: match[1].trim(), endDate: match[2].trim() };
}

function splitEntries(lines) {
  const entries = [];
  let current = [];

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line) {
      if (current.length) {
        entries.push(current);
        current = [];
      }
      continue;
    }

    if (getDateRange(line) && current.some((item) => getDateRange(item))) {
      entries.push(current);
      current = [];
    }
    current.push(line);
  }

  if (current.length) entries.push(current);
  return entries.filter((entry) => entry.some(Boolean));
}

function parseMonthYear(value) {
  if (/^(present|current)$/i.test(value)) {
    const now = new Date();
    return now.getFullYear() * 12 + now.getMonth();
  }
  const year = Number(value.match(/(?:19|20)\d{2}/)?.[0]);
  if (!year) return null;
  const monthText = value.match(/^[A-Za-z]+/)?.[0]?.slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = monthText ? months.indexOf(monthText) : 0;
  return year * 12 + Math.max(month, 0);
}

function getExperienceYears(entries) {
  const intervals = entries
    .map((entry) => {
      const range = entry.find(getDateRange);
      if (!range) return null;
      const dates = getDateRange(range);
      const start = parseMonthYear(dates.startDate);
      const end = parseMonthYear(dates.endDate);
      return start !== null && end !== null && end >= start ? [start, end] : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);

  if (!intervals.length) return 0;

  let totalMonths = 0;
  let [start, end] = intervals[0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      totalMonths += end - start;
      [start, end] = [nextStart, nextEnd];
    }
  }
  totalMonths += end - start;
  return Math.round((totalMonths / 12) * 10) / 10;
}

function splitRoleAndCompany(line) {
  const parts = line.split(/\s+(?:at|@)\s+|\s+[|]\s+|\s+[–—]\s+/i);
  return parts.length > 1
    ? { position: parts[0].trim(), company: parts.slice(1).join(" ").trim() }
    : { position: line.trim(), company: "" };
}

function extractExperience(entries) {
  return entries.map((entry) => {
    const dateLine = entry.find((line) => getDateRange(line));
    const range = dateLine ? getDateRange(dateLine) : {};
    const headingLines = entry.filter((line) => (
      line !== dateLine && !/^[•●▪*-]/.test(line)
    ));
    const positionLine = headingLines.find((line) => ROLE_PATTERN.test(line));
    const splitRole = positionLine ? splitRoleAndCompany(positionLine) : {};
    const company = splitRole.company || headingLines.find((line) => line !== positionLine) || "";
    const description = entry
      .filter((line) => line !== dateLine && line !== positionLine && line !== company)
      .map(cleanLine)
      .filter(Boolean)
      .join(" ");

    return {
      company,
      position: splitRole.position || positionLine || "",
      startDate: range.startDate || "",
      endDate: range.endDate || "",
      description,
    };
  }).filter((entry) => Object.values(entry).some(Boolean));
}

function extractSimpleEntries(lines, kind) {
  return splitEntries(lines).map((entry) => {
    const content = entry.filter((line) => !getDateRange(line));
    const dates = getDateRange(entry.find((line) => getDateRange(line)) || "") || {};
    if (kind === "education") {
      const degreeIndex = content.findIndex((line) =>
        /\b(bachelor|master|doctor|ph\.?d|b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|associate|diploma)\b/i.test(line),
      );
      const degreeLine = degreeIndex >= 0 ? content[degreeIndex] : "";
      const field = degreeLine.match(/^.*\s+(?:in|of)\s+(.+)$/i)?.[1] || "";
      return {
        school: content.find((line, index) => index !== degreeIndex) || "",
        degree: field
          ? degreeLine.slice(0, degreeLine.length - field.length).replace(/\s+(?:in|of)\s*$/i, "").trim()
          : degreeLine,
        field: field.trim(),
        startDate: dates.startDate || "",
        endDate: dates.endDate || "",
        description: content.filter((line, index) => index !== degreeIndex && line !== content[0]).join(" "),
      };
    }

    if (kind === "projects") {
      const name = content[0] || "";
      const description = content.slice(1).join(" ");
      return {
        name,
        description,
        technologies: findTerms(entry.join(" "), TECHNOLOGIES).join(", "),
        link: entry.join(" ").match(/https?:\/\/[^\s,)]+/i)?.[0] || "",
      };
    }

    return {
      name: content[0] || "",
      issuer: readLabeledValue(entry.join("\n"), ["issuer", "issued by"]) || content[1] || "",
      date: readLabeledValue(entry.join("\n"), ["date", "issued"]) || dates.endDate || dates.startDate || "",
      credentialId: readLabeledValue(entry.join("\n"), ["credential id", "credential"]),
    };
  }).filter((entry) => Object.values(entry).some(Boolean));
}

function extractUrl(text, domain) {
  const match = text.match(new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?${domain}\\/[^\\s,;<>]+`, "i"));
  if (!match) return "";
  return normalizeUrl(match[0].replace(/[).,]+$/, ""));
}

function normalizeUrl(value) {
  const url = String(value || "").trim().replace(/[).,]+$/, "");
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function extractResumeProfile(resumeText) {
  const text = String(resumeText || "").replace(/\r/g, "").trim();
  if (!text) throw new Error("No resume text provided for local extraction");

  const sections = splitResumeSections(text);
  const experienceEntries = splitEntries(sections.experience);
  const experience = extractExperience(experienceEntries);
  const technologies = findTerms(text, TECHNOLOGIES);
  const skillsFromSection = sections.skills
    .flatMap((line) => line.split(/[,;|•]/))
    .map(cleanLine)
    .filter((skill) => skill && skill.length <= 60 && !getDateRange(skill));
  const skills = Array.from(new Set([
    ...skillsFromSection,
    ...technologies,
    ...findTerms(text, GENERAL_SKILLS),
  ]));
  const introLines = sections.intro;
  const topTitle = introLines.map(cleanLine).find((line) => (
    ROLE_PATTERN.test(line) && line.length <= 100
  )) || "";
  const roleTitles = Array.from(new Set([
    ...experience.map((entry) => entry.position),
    topTitle,
  ].filter(Boolean)));
  const summary = sections.summary.map(cleanLine).filter(Boolean).join(" ");
  const phone = text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/)?.[0] || "";
  const linkedin = extractUrl(text, "linkedin\\.com");
  const github = extractUrl(text, "github\\.com");
  const twitter = extractUrl(text, "(?:twitter|x)\\.com");
  const portfolioUrl = normalizeUrl(
    readLabeledValue(text, ["portfolio", "portfolio url"]) ||
    extractUrl(text, "(?:portfolio|about\\.me|behance\\.net|dribbble\\.com)"),
  );
  const websiteUrl = normalizeUrl(readLabeledValue(text, ["website", "personal website"]));
  const genericUrls = Array.from(text.matchAll(/(?:https?:\/\/|www\.)[^\s,;<>]+/gi), (match) => match[0]);
  const website = websiteUrl || normalizeUrl(genericUrls.find((url) => (
    !/(linkedin|github|twitter|x\.com|portfolio|behance|dribbble)/i.test(url)
  )));

  return {
    skills,
    experience_years: getExperienceYears(experienceEntries),
    technologies,
    role_titles: roleTitles,
    displayName: firstLikelyName(introLines),
    title: experience[0]?.position || topTitle || roleTitles[0] || "",
    location: readLabeledValue(text, ["location", "based in"]),
    phone: phone.trim(),
    bio: summary,
    experience,
    education: extractSimpleEntries(sections.education, "education"),
    projects: extractSimpleEntries(sections.projects, "projects"),
    certificates: extractSimpleEntries(sections.certificates, "certificates"),
    linkedin,
    github,
    twitter,
    website,
    portfolioUrl,
  };
}

export { extractResumeProfile };
