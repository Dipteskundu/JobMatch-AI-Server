import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractTextFromResume } from "../services/resumeParserService.js";
import { createScannedPdf } from "./fixtures/scannedResume.js";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

function createPdf(content) {
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join("")));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(""));
  const xref = [
    `xref\n0 ${offsets.length}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(`${xref}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(""));
}

async function createDocx(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("extracts and normalizes text from TXT files", async () => {
  const result = await extractTextFromResume({
    originalname: "resume.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("Alex Candidate\r\n\r\n\r\nReact  Developer"),
  });

  assert.equal(result.text, "Alex Candidate\n\nReact Developer");
  assert.equal(result.warning, "");
});

test("extracts text from DOCX files", async () => {
  const result = await extractTextFromResume({
    originalname: "resume.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await createDocx("Alex Candidate - React Developer"),
  });

  assert.match(result.text, /Alex Candidate - React Developer/);
});

test("extracts selectable text from PDFs", async () => {
  const result = await extractTextFromResume({
    originalname: "resume.pdf",
    mimetype: "application/pdf",
    buffer: createPdf("BT /F1 14 Tf 50 750 Td (Resume Candidate) Tj ET"),
  });
  assert.match(result.text, /Resume Candidate/);
  assert.equal(result.warning, "");
});

test("uses local OCR to extract text from scanned resume pages", async () => {
  const result = await extractTextFromResume({
    originalname: "scanned-resume.pdf",
    mimetype: "application/pdf",
    buffer: createScannedPdf("Alex Candidate\nReact JavaScript Developer"),
  });

  assert.match(result.text, /Alex Candidate/i);
  assert.match(result.text, /React/i);
  assert.equal(result.warning, "");
});

test("limits OCR to two scanned pages and reports partial extraction", async () => {
  const result = await extractTextFromResume({
    originalname: "long-scanned-resume.pdf",
    mimetype: "application/pdf",
    buffer: createScannedPdf("React Developer", 3),
  });

  assert.match(result.text, /React Developer/i);
  assert.equal((result.text.match(/React Developer/gi) || []).length, 2);
  assert.match(result.warning, /Only 2 scanned PDF pages were processed/);
});

test("rejects PDFs with no readable text after OCR", async () => {
  await assert.rejects(
    extractTextFromResume({
      originalname: "scanned.pdf",
      mimetype: "application/pdf",
      buffer: createPdf(""),
    }),
    { statusCode: 422, message: /No readable text could be extracted/ },
  );
});

test("logs sanitized PDF parser diagnostics without logging the upload filename", async () => {
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(" "));

  try {
    await assert.rejects(
      extractTextFromResume({
        originalname: "private-candidate-name.pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("not a PDF"),
      }),
      {
        statusCode: 422,
        message: "This PDF is invalid or damaged. Export a valid PDF and try again.",
      },
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /pdfParseVersion/);
  assert.match(messages[0], /nodeVersion/);
  assert.doesNotMatch(messages[0], /private-candidate-name|not a PDF/);
});

test("rejects empty documents and documents with no readable text", async () => {
  await assert.rejects(
    extractTextFromResume({
      originalname: "empty.txt",
      mimetype: "text/plain",
      buffer: Buffer.alloc(0),
    }),
    { statusCode: 422, message: "The uploaded resume file is empty." },
  );

  await assert.rejects(
    extractTextFromResume({
      originalname: "blank.txt",
      mimetype: "text/plain",
      buffer: Buffer.from(" \r\n\t "),
    }),
    { statusCode: 422, message: /No readable text was found/ },
  );
});

test("rejects unsupported legacy Word files and mismatched MIME types", async () => {
  await assert.rejects(
    extractTextFromResume({
      originalname: "resume.doc",
      mimetype: "application/msword",
      buffer: Buffer.from("legacy document"),
    }),
    { statusCode: 415, message: /PDF, DOCX, or TXT/ },
  );

  await assert.rejects(
    extractTextFromResume({
      originalname: "resume.pdf",
      mimetype: "text/plain",
      buffer: Buffer.from("not actually a PDF"),
    }),
    { statusCode: 415, message: /extension and file type do not match/ },
  );
});
