// routes/resume.routes.js

import express from "express";
import multer from "multer";
import path from "path";
import { uploadResume } from "../controllers/resumeController.js";

const router = express.Router();
const MAX_RESUME_SIZE = 4 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_SIZE },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      const error = new Error("Please upload a PDF, DOCX, or TXT resume.");
      error.status = 415;
      error.userMessage = error.message;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

const receiveResume = upload.single("resume");

router.post("/api/resume/upload", (req, res, next) => {
  receiveResume(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      error.status = 413;
      error.userMessage = "Resume file must be 4 MiB or smaller.";
    } else if (!error.status) {
      error.status = 400;
    }
    return next(error);
  });
}, uploadResume);

export default router;
