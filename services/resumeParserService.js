import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const SUPPORTED_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".txt", "text/plain"],
]);

class ResumeFileError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ResumeFileError";
    this.statusCode = statusCode;
  }
}

function ensureBuffer(file) {
  if (file?.buffer && Buffer.isBuffer(file.buffer)) return file.buffer;
  if (file?.path) return fs.readFileSync(file.path);
  return null;
}

async function extractPdfText(buffer) {
  try {
    const pdfParseModule = require("pdf-parse");
    const PDFParseClass = pdfParseModule?.PDFParse;
    const pdfParseFn = typeof pdfParseModule === "function" ? pdfParseModule : null;

    if (pdfParseFn) {
      const data = await pdfParseFn(buffer);
      return data?.text || "";
    }

    if (typeof PDFParseClass === "function") {
      const parser = new PDFParseClass({ data: buffer });
      try {
        const data = await parser.getText({ pageJoiner: "" });
        return data?.text || "";
      } finally {
        if (typeof parser.destroy === "function") await parser.destroy();
      }
    }
  } catch {
    throw new ResumeFileError(
      "The PDF could not be read. Upload a valid text-based PDF; scanned PDFs are not supported.",
      422,
    );
  }

  throw new ResumeFileError("PDF parsing is unavailable in this environment.", 500);
}

async function extractTextFromResume(file) {
  if (!file) throw new ResumeFileError("Resume file is required.");

  const extension = path.extname(file.originalname || "").toLowerCase();
  const supportedMimeType = SUPPORTED_TYPES.get(extension);
  if (!supportedMimeType) {
    throw new ResumeFileError("Unsupported file type. Please upload a PDF, DOCX, or TXT resume.", 415);
  }

  const mimeType = String(file.mimetype || "").toLowerCase();
  if (mimeType && mimeType !== supportedMimeType && mimeType !== "application/octet-stream") {
    throw new ResumeFileError("The file extension and file type do not match.", 415);
  }

  let buffer;
  try {
    buffer = ensureBuffer(file);
  } catch {
    throw new ResumeFileError("The uploaded resume file could not be read.", 422);
  }
  if (!buffer?.length) throw new ResumeFileError("The uploaded resume file is empty.", 422);

  let extractedText;
  if (extension === ".pdf") {
    extractedText = await extractPdfText(buffer);
  } else if (extension === ".docx") {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value || "";
    } catch {
      throw new ResumeFileError("The DOCX file could not be read. Upload a valid DOCX document.", 422);
    }
  } else {
    extractedText = buffer.toString("utf8");
  }

  const normalizedText = String(extractedText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalizedText) {
    throw new ResumeFileError(
      "No selectable text was found. Scanned or image-only PDFs are not supported; upload a text-based PDF, DOCX, or TXT file.",
      422,
    );
  }

  return normalizedText;
}

export { extractTextFromResume, ResumeFileError };
