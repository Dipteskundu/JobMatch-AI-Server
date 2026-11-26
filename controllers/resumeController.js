// controllers/resumeController.js

import { getDB } from "../config/db.js";
import { extractTextFromResume } from "../services/resumeParserService.js";
import { extractResumeProfile } from "../services/localResumeExtractionService.js";

function getExtractionWarning(data) {
  const missing = [];
  if (!data.displayName) missing.push("name");
  if (!data.skills.length) missing.push("skills");
  if (!data.experience.length) missing.push("work history");
  if (!data.education.length) missing.push("education");
  if (!data.projects.length) missing.push("projects");

  return missing.length
    ? `Local parsing could not confidently identify ${missing.join(", ")}. Review the detected details before applying them.`
    : "";
}

function hasProfileDetails(data) {
  return Boolean(
    data.displayName ||
    data.title ||
    data.location ||
    data.phone ||
    data.bio ||
    data.skills.length ||
    data.experience.length ||
    data.education.length ||
    data.projects.length ||
    data.certificates.length ||
    data.linkedin ||
    data.github ||
    data.twitter ||
    data.website ||
    data.portfolioUrl
  );
}

/**
 * Handle resume upload, local extraction, and DB updates.
 */
async function uploadResume(req, res) {
  try {
    const profileImport = req.body.profileImport === "true";
    const candidateId = profileImport ? req.user?.uid : req.body.candidateId;
    const file = req.file;

    if (!candidateId) {
      return res.status(profileImport ? 401 : 400).json({
        success: false,
        message: profileImport ? "Authentication is required" : "candidateId is required",
      });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: "Resume file is required" });
    }

    // 1. Extract raw text from the file
    const extractedText = await extractTextFromResume(file);

    // Extraction is deterministic and local; no AI provider or API key is used.
    const extractedData = extractResumeProfile(extractedText);
    const warning = getExtractionWarning(extractedData);

    if (!hasProfileDetails(extractedData)) {
      return res.status(422).json({
        success: false,
        message: "No recognizable profile details were found. Try a resume with clearly labeled sections.",
      });
    }

    if (!profileImport && !extractedData.skills.length && !extractedData.role_titles.length) {
      return res.status(422).json({
        success: false,
        message: "No skills or job titles could be identified for matching. Add a clearly labeled Skills or Experience section and try again.",
      });
    }

    if (profileImport) {
      return res.status(200).json({
        success: true,
        message: "Resume analyzed for profile review",
        warning: warning || undefined,
        data: {
          ...extractedData,
          profile: {
            displayName: extractedData.displayName || "",
            title: extractedData.title || extractedData.role_titles?.[0] || "",
            location: extractedData.location || "",
            phone: extractedData.phone || "",
            bio: extractedData.bio || "",
            experience: extractedData.experience || [],
            education: extractedData.education || [],
            projects: extractedData.projects || [],
            certificates: extractedData.certificates || [],
            linkedin: extractedData.linkedin || "",
            github: extractedData.github || "",
            twitter: extractedData.twitter || "",
            website: extractedData.website || "",
            portfolioUrl: extractedData.portfolioUrl || "",
          },
        },
      });
    }

    const db = getDB();
    const resumesCollection = db.collection("resumes");
    const usersCollection = db.collection("users");

    // 3. Save Resume record
    const resumeDoc = {
      candidateId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      extractedText,
      extractedSkills: extractedData.skills || [],
      extractedExperience: extractedData.experience_years || 0,
      extractedTechnologies: extractedData.technologies || [],
      extractedRoles: extractedData.role_titles || [],
      createdAt: new Date(),
    };

    await resumesCollection.insertOne(resumeDoc);

    // 4. Update Candidate Profile
    // We add new skills, avoiding duplicates
    const candidate = await usersCollection.findOne({ firebaseUid: candidateId });
    
    let existingSkills = [];
    if (candidate && candidate.skills) {
      existingSkills = candidate.skills;
    }

    // Merge skills and deduplicate
    const combinedSkills = Array.from(new Set([
      ...existingSkills,
      ...extractedData.skills,
      ...extractedData.technologies
    ]));

    await usersCollection.updateOne(
      { firebaseUid: candidateId },
      {
        $set: {
          resumeUploaded: true,
          skills: combinedSkills,
          yearsOfExperience: extractedData.experience_years,
          updatedAt: new Date()
        }
      }
    );

    res.status(200).json({
      success: true,
      message: "Resume processed successfully",
      warning: warning || undefined,
      data: {
        skills: extractedData.skills,
        technologies: extractedData.technologies,
        experience_years: extractedData.experience_years,
        role_titles: extractedData.role_titles
      }
    });

  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || "Server error during resume processing",
    });
  }
}

export { uploadResume };
