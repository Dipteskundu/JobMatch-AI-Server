// controllers/resumeController.js

import { getDB } from "../config/db.js";
import { extractTextFromResume } from "../services/resumeParserService.js";
import { extractSkillsFromResume } from "../services/aiSkillExtractionService.js";

function extractFallbackFromText(text) {
  const source = String(text || "");
  const lower = source.toLowerCase();
  const knownTech = [
    "JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Express", "MongoDB",
    "PostgreSQL", "MySQL", "Firebase", "Python", "Java", "C++", "C", "Tailwind CSS",
    "Docker", "Kubernetes", "AWS", "Azure", "GCP", "Git", "Redux", "HTML", "CSS",
  ];
  const technologies = knownTech.filter((technology) => (
    technology === "C"
      ? /(^|[^a-z0-9+#])C([^a-z0-9+#]|$)/i.test(source)
      : lower.includes(technology.toLowerCase())
  ));

  return {
    skills: technologies,
    experience_years: 0,
    technologies,
    role_titles: [],
  };
}

/**
 * Handle resume upload, parsing, AI extraction, and DB updates.
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

    // 2. Perform AI skill extraction (fallback safely if AI is unavailable)
    let extractedData;
    let warning = "";
    try {
      extractedData = await extractSkillsFromResume(extractedText);
    } catch (aiError) {
      extractedData = extractFallbackFromText(extractedText);
      warning = "AI extraction was unavailable, so basic keyword extraction was used.";
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
    res.status(500).json({
      success: false,
      message: error.message || "Server error during resume processing"
    });
  }
}

export { uploadResume };
