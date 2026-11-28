import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const OCR_CACHE_PATH = path.join(os.tmpdir(), "jobmatch-tesseract-cache");
const MAX_OCR_PAGES = 2;
const OCR_PAGE_WIDTH = 1500;

// The PDF/OCR toolchain is loaded on first use instead of at module load.
//
// `require("pdf-parse/worker")` eagerly requires the NATIVE @napi-rs/canvas
// binding, `tesseract.js` resolves its worker script and `PDFParse.setWorker()`
// runs real setup code. All of that used to execute while `api/index.js` was
// still being imported, so if any single native binding failed to load on the
// host platform the whole Express app failed to import and Vercel answered
// FUNCTION_INVOCATION_FAILED for every route — including `/` and `/health`,
// which never touch a resume.
//
// Loading lazily confines any such failure to the resume endpoint, where it
// becomes an actionable 503 instead of a total outage. The successful result is
// cached so the cost is paid once per process.
let pdfStackPromise = null;

function loadPdfStack() {
  if (!pdfStackPromise) {
    pdfStackPromise = Promise.resolve().then(() => {
      const pdfWorker = require("pdf-parse/worker");
      const { PDFParse } = require("pdf-parse");
      const { createWorker } = require("tesseract.js");
      const englishOcrData = require("@tesseract.js-data/eng");
      const TESSERACT_WORKER_PATH = require.resolve(
        "tesseract.js/src/worker-script/node/index.js",
      );

      // Installs the worker factory pdfjs needs to render pages for OCR.
      PDFParse.setWorker(pdfWorker.getData());

      return {
        pdfWorker,
        PDFParse,
        createWorker,
        englishOcrData,
        TESSERACT_WORKER_PATH,
      };
    });
    // Cache the rejection too: a module/binding failure is deterministic, and
    // retrying it per request would just turn a 503 into a cold-start storm.
    pdfStackPromise.catch(() => {});
  }
  return pdfStackPromise;
}

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

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getPackageVersion(packageName, entryPoint) {
  let directory = path.dirname(entryPoint);
  while (directory !== path.dirname(directory)) {
    const packagePath = path.join(directory, "package.json");
    if (fs.existsSync(packagePath)) {
      const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (metadata.name === packageName) return metadata.version;
    }
    directory = path.dirname(directory);
  }
  return "unknown";
}

// Version lookup must never throw: it runs from an error handler, and a
// resolution failure there would mask the original problem.
function safePackageVersion(packageName) {
  try {
    return getPackageVersion(packageName, require.resolve(packageName));
  } catch {
    return "unresolved";
  }
}

function logPdfFailure(stage, error) {
  const rawMessage = String(error?.message || "Unknown parser error")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:[A-Za-z]:\\|\/(?:home|tmp|var|Users)\/)[^\s]*/g, "[path]")
    .slice(0, 240);
  const details = {
    stage,
    errorName: String(error?.name || "Error").slice(0, 80),
    errorCode: String(error?.code || "").slice(0, 80) || undefined,
    errorMessage: rawMessage,
    nodeVersion: process.version,
    pdfParseVersion: safePackageVersion("pdf-parse"),
    ocrVersion: safePackageVersion("tesseract.js"),
  };
  console.error("[resume-pdf] processing failed", JSON.stringify(details));
}

function mapPdfError(error) {
  if (error?.name === "PasswordException") {
    return new ResumeFileError(
      "This PDF is password-protected. Remove the password and upload it again.",
      422,
    );
  }
  if (error?.name === "InvalidPDFException" || error?.name === "FormatError") {
    return new ResumeFileError(
      "This PDF is invalid or damaged. Export a valid PDF and try again.",
      422,
    );
  }
  return new ResumeFileError(
    "PDF processing failed on the server. Please try again or upload another PDF.",
    500,
  );
}

async function extractPdfText(buffer) {
  let parser;
  let ocrWorker;
  let stage = "pdf_toolchain";

  // Load the native/worker toolchain first so a binding failure is reported as
  // a clean, retryable 503 for this endpoint rather than bubbling up as an
  // unexpected 500.
  let pdfStack;
  try {
    pdfStack = await loadPdfStack();
  } catch (error) {
    logPdfFailure(stage, error);
    throw new ResumeFileError(
      "PDF processing is unavailable on this server right now. Upload a DOCX or TXT resume, or try again later.",
      503,
    );
  }

  const {
    pdfWorker,
    PDFParse,
    createWorker,
    englishOcrData,
    TESSERACT_WORKER_PATH,
  } = pdfStack;

  stage = "pdf_text";
  try {
    parser = new PDFParse({
      data: buffer,
      CanvasFactory: pdfWorker.CanvasFactory,
    });
    const result = await parser.getText({ pageJoiner: "" });
    const pages = Array.isArray(result.pages) && result.pages.length
      ? result.pages.map((page, index) => ({
          number: Number(page.num) || index + 1,
          text: String(page.text || ""),
        }))
      : [{ number: 1, text: String(result.text || "") }];
    const pagesNeedingOcr = pages.filter((page) => !normalizeText(page.text));
    const pagesToOcr = pagesNeedingOcr.slice(0, MAX_OCR_PAGES);
    const ocrTextByPage = new Map();

    if (pagesToOcr.length) {
      stage = "pdf_ocr";
      await fs.promises.mkdir(OCR_CACHE_PATH, { recursive: true });
      ocrWorker = await createWorker("eng", 1, {
        langPath: englishOcrData.langPath,
        gzip: englishOcrData.gzip,
        workerPath: TESSERACT_WORKER_PATH,
        cachePath: OCR_CACHE_PATH,
      });

      for (const page of pagesToOcr) {
        stage = "pdf_render";
        const screenshot = await parser.getScreenshot({
          partial: [page.number],
          desiredWidth: OCR_PAGE_WIDTH,
          imageBuffer: true,
          imageDataUrl: false,
        });
        const pageImage = screenshot.pages?.[0]?.data;
        if (!pageImage?.length) {
          throw new Error("PDF page rendering returned no image data");
        }

        stage = "pdf_ocr";
        const recognized = await ocrWorker.recognize(pageImage);
        ocrTextByPage.set(page.number, recognized.data.text || "");
      }
    }

    const text = normalizeText(
      pages.map((page) => ocrTextByPage.get(page.number) || page.text).join("\n"),
    );
    if (!text) {
      throw new ResumeFileError(
        "No readable text could be extracted from this PDF. Ensure scanned pages contain clear, upright, printed text.",
        422,
      );
    }

    return {
      text,
      warning: pagesNeedingOcr.length > MAX_OCR_PAGES
        ? `Only ${MAX_OCR_PAGES} scanned PDF pages were processed. Split the resume into smaller files to extract the remaining pages.`
        : "",
    };
  } catch (error) {
    if (error instanceof ResumeFileError) throw error;
    logPdfFailure(stage, error);
    throw mapPdfError(error);
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    if (parser) await parser.destroy();
  }
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
  let warning = "";
  if (extension === ".pdf") {
    const parsedPdf = await extractPdfText(buffer);
    extractedText = parsedPdf.text;
    warning = parsedPdf.warning;
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

  const normalizedText = normalizeText(extractedText);

  if (!normalizedText) {
    throw new ResumeFileError(
      "No readable text was found in the uploaded file. Upload a document containing clear, selectable or printed text.",
      422,
    );
  }

  return { text: normalizedText, warning };
}

export { extractTextFromResume, ResumeFileError };
