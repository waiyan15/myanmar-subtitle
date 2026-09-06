import express from "express";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

fs.mkdirSync("uploads", { recursive: true });

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use(express.static("public"));

const jobs = new Map();


// ========================================
// Gemini File Upload
// ========================================

async function uploadToGemini(filePath, maxRetries = 4) {

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY မတွေ့ပါ။ Render Environment ကို စစ်ပါ။"
    );
  }

  const fileData = fs.readFileSync(filePath);
  const fileSize = fileData.length;

  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {

    try {

      // Step 1: Start resumable upload
      const startResponse = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(API_KEY.trim())}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(fileSize),
            "X-Goog-Upload-Header-Content-Type": "text/plain",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            file: {
              display_name: "subtitle.srt"
            }
          })
        }
      );

      if (!startResponse.ok) {

        const errorText =
          await startResponse.text();

        throw new Error(
          `Gemini File Upload Start Error: ${errorText}`
        );
      }

      const uploadUrl =
        startResponse.headers.get(
          "x-goog-upload-url"
        );

      if (!uploadUrl) {
        throw new Error(
          "Gemini upload URL မရရှိပါ။"
        );
      }

      // Step 2: Upload actual SRT file
      const uploadResponse = await fetch(
        uploadUrl,
        {
          method: "POST",
          headers: {
            "Content-Length": String(fileSize),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize"
          },
          body: fileData
        }
      );

      const uploadText =
        await uploadResponse.text();

      if (!uploadResponse.ok) {

        throw new Error(
          `Gemini File Upload Error: ${uploadText}`
        );
      }

      const uploadResult =
        JSON.parse(uploadText);

      const file =
        uploadResult.file;

      if (!file?.uri) {
        throw new Error(
          "Gemini File URI မရရှိပါ။"
        );
      }

      console.log(
        "Gemini file uploaded:",
        file.name,
        file.uri
      );

      return file;

    } catch (error) {

      lastError =
        error.message ||
        "Gemini file upload error";

      if (attempt === maxRetries) {
        throw new Error(lastError);
      }

      const waitSeconds =
        attempt * 5;

      console.log(
        `File upload retry ${attempt}/${maxRetries} after ${waitSeconds}s`
      );

      await new Promise(resolve =>
        setTimeout(
          resolve,
          waitSeconds * 1000
        )
      );
    }
  }

  throw new Error(
    lastError || "Gemini file upload error"
  );
}


// ========================================
// Delete Gemini File
// ========================================

async function deleteGeminiFile(fileName) {

  if (!fileName || !API_KEY) {
    return;
  }

  try {

    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(API_KEY.trim())}`,
      {
        method: "DELETE"
      }
    );

    console.log(
      "Gemini file deleted:",
      fileName
    );

  } catch (error) {

    console.log(
      "Gemini file delete failed:",
      error.message
    );
  }
}


// ========================================
// Gemini Generate Content
// ========================================

async function askGeminiFile(
  file,
  maxRetries = 4
) {

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY မတွေ့ပါ။ Render Environment ကို စစ်ပါ။"
    );
  }

  const prompt = `
Translate the SRT subtitle file into natural Myanmar Burmese.

STRICT RULES:

1. Keep subtitle numbers EXACTLY unchanged.
2. Keep timestamps EXACTLY unchanged.
3. NEVER change timestamps.
4. NEVER change subtitle numbering.
5. Do not add subtitle entries.
6. Do not remove subtitle entries.
7. Translate ONLY spoken dialogue.
8. Keep HTML tags such as <i>, </i>, <b>, </b> unchanged.
9. Keep subtitle line structure where possible.
10. Use natural, easy-to-understand Myanmar Burmese.
11. Do not explain anything.
12. Return ONLY valid SRT.
13. Do NOT use Markdown code blocks.
14. Every subtitle entry MUST appear.
15. Do not merge subtitle entries.
16. Do not split subtitle entries.
17. Preserve every subtitle timestamp exactly.
18. Preserve every subtitle number exactly.
19. The output must contain the same number of subtitle entries as the original file.

Return ONLY the translated SRT.
`;

  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {

    try {

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY.trim()
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: prompt
                  },
                  {
                    file_data: {
                      mime_type:
                        file.mimeType ||
                        "text/plain",
                      file_uri: file.uri
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.2
            }
          })
        }
      );

      const data =
        await response.json();

      if (response.ok) {

        const text =
          data.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("") || "";

        if (!text.trim()) {
          throw new Error(
            "Gemini က ဘာသာပြန်စာ ပြန်မပေးပါ။"
          );
        }

        return text;
      }

      const errorMessage =
        data.error?.message ||
        "Gemini API error";

      lastError = errorMessage;

      const lower =
        errorMessage.toLowerCase();

      const retryable =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        lower.includes("high demand") ||
        lower.includes("temporarily") ||
        lower.includes("overloaded") ||
        lower.includes("unavailable");

      if (!retryable) {
        throw new Error(errorMessage);
      }

      if (attempt < maxRetries) {

        const waitSeconds =
          attempt * 5;

        console.log(
          `Gemini busy. Retry ${attempt}/${maxRetries} after ${waitSeconds}s`
        );

        await new Promise(resolve =>
          setTimeout(
            resolve,
            waitSeconds * 1000
          )
        );
      }

    } catch (error) {

      lastError =
        error.message ||
        "Gemini API error";

      if (attempt === maxRetries) {
        throw new Error(lastError);
      }

      console.log(
        `Gemini retry ${attempt}/${maxRetries}: ${lastError}`
      );

      await new Promise(resolve =>
        setTimeout(
          resolve,
          attempt * 5000
        )
      );
    }
  }

  throw new Error(
    lastError || "Gemini API error"
  );
}


// ========================================
// SRT Functions
// ========================================

function cleanSrt(text) {

  return text
    .replace(/```srt/gi, "")
    .replace(/```/g, "")
    .trim();
}


function parseSrt(srt) {

  return srt
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);
}


// ========================================
// Validate SRT
// ========================================

function getSubtitleInfo(block) {

  const lines =
    block
      .split("\n")
      .map(line => line.trim());

  const number =
    lines[0] || "";

  const timestamp =
    lines[1] || "";

  return {
    number,
    timestamp
  };
}


function validateTranslatedSrt(
  originalSrt,
  translatedSrt
) {

  const originalBlocks =
    parseSrt(originalSrt);

  const translatedBlocks =
    parseSrt(translatedSrt);

  if (
    originalBlocks.length !==
    translatedBlocks.length
  ) {

    throw new Error(
      `Subtitle အရေအတွက် မကိုက်ညီပါ။ Original ${originalBlocks.length} ခု / Gemini ${translatedBlocks.length} ခု`
    );
  }

  for (
    let i = 0;
    i < originalBlocks.length;
    i++
  ) {

    const original =
      getSubtitleInfo(
        originalBlocks[i]
      );

    const translated =
      getSubtitleInfo(
        translatedBlocks[i]
      );

    if (
      original.number !==
      translated.number
    ) {

      throw new Error(
        `Subtitle နံပါတ် ${i + 1} မှာ မကိုက်ညီပါ။`
      );
    }

    if (
      original.timestamp !==
      translated.timestamp
    ) {

      throw new Error(
        `Subtitle ${original.number} ရဲ့ timestamp ပြောင်းသွားပါတယ်။`
      );
    }
  }

  return true;
}


// ========================================
// Job Update
// ========================================

function updateJob(jobId, data) {

  const job =
    jobs.get(jobId);

  if (!job) return;

  Object.assign(
    job,
    data
  );

  const message =
    `data: ${JSON.stringify({
      progress: job.progress,
      completed: job.completed,
      total: job.total,
      status: job.status,
      error: job.error || null
    })}\n\n`;

  if (job.clients) {

    for (
      const client
      of job.clients
    ) {

      try {
        client.write(message);
      } catch {}
    }
  }
}


// ========================================
// Translation Worker
// ========================================

async function runTranslation(
  jobId,
  filePath
) {

  const job =
    jobs.get(jobId);

  if (!job) return;

  let geminiFile = null;

  try {

    // ------------------------------------
    // Read SRT
    // ------------------------------------

    updateJob(jobId, {
      progress: 5,
      completed: 0,
      total: 0,
      status:
        "SRT ဖိုင်ကို ဖတ်နေပါသည်..."
    });

    const originalSrt =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    if (!originalSrt.trim()) {

      throw new Error(
        "SRT ဖိုင် အလွတ်ဖြစ်နေပါတယ်။"
      );
    }

    const blocks =
      parseSrt(originalSrt);

    if (blocks.length === 0) {

      throw new Error(
        "SRT format မမှန်ပါ။"
      );
    }

    const total =
      blocks.length;

    job.total = total;

    updateJob(jobId, {
      progress: 10,
      completed: 0,
      total,
      status:
        `SRT ${total} ခု တွေ့ရှိပါသည်။ Gemini သို့ ဖိုင်တင်နေပါသည်...`
    });


    // ------------------------------------
    // Upload whole SRT to Gemini
    // ------------------------------------

    console.log(
      `Uploading whole SRT to Gemini: ${total} subtitles`
    );

    geminiFile =
      await uploadToGemini(
        filePath
      );

    updateJob(jobId, {
      progress: 25,
      completed: 0,
      total,
      status:
        "SRT ဖိုင် Gemini သို့ တင်ပြီးပါပြီ။"
    });


    // ------------------------------------
    // Translate whole file
    // ------------------------------------

    updateJob(jobId, {
      progress: 30,
      completed: 0,
      total,
      status:
        "Gemini က SRT ဖိုင်တစ်ခုလုံးကို ဘာသာပြန်နေပါသည်..."
    });

    console.log(
      "Gemini translating whole SRT..."
    );

    const translated =
      cleanSrt(
        await askGeminiFile(
          geminiFile
        )
      );


    // ------------------------------------
    // Validate
    // ------------------------------------

    updateJob(jobId, {
      progress: 90,
      completed: 0,
      total,
      status:
        "ဘာသာပြန်ထားသော SRT ကို စစ်ဆေးနေပါသည်..."
    });

    validateTranslatedSrt(
      originalSrt,
      translated
    );


    // ------------------------------------
    // Done
    // ------------------------------------

    job.srt =
      translated;

    updateJob(jobId, {
      progress: 100,
      completed: total,
      total,
      status: "completed"
    });

    console.log(
      `Translation completed: ${jobId}`
    );


    // ------------------------------------
    // Delete uploaded Gemini file
    // ------------------------------------

    if (geminiFile?.name) {

      await deleteGeminiFile(
        geminiFile.name
      );
    }

    try {
      fs.unlinkSync(filePath);
    } catch {}


    // Close SSE connections
    setTimeout(() => {

      const currentJob =
        jobs.get(jobId);

      if (!currentJob) return;

      for (
        const client
        of currentJob.clients
      ) {

        try {
          client.end();
        } catch {}
      }

      currentJob.clients.clear();

    }, 1000);


  } catch (error) {

    console.error(
      "Translation error:",
      error
    );

    if (geminiFile?.name) {

      await deleteGeminiFile(
        geminiFile.name
      );
    }

    updateJob(jobId, {
      progress: 0,
      status: "failed",
      error:
        error.message ||
        "ဘာသာပြန်ရာတွင် Error ဖြစ်နေပါတယ်။"
    });

    try {
      fs.unlinkSync(filePath);
    } catch {}


    setTimeout(() => {

      const currentJob =
        jobs.get(jobId);

      if (!currentJob) return;

      for (
        const client
        of currentJob.clients
      ) {

        try {
          client.end();
        } catch {}
      }

      currentJob.clients.clear();

    }, 1000);
  }
}


// ========================================
// Upload SRT
// ========================================

app.post(
  "/translate-srt",
  upload.single("srt"),
  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({
          error:
            "SRT ဖိုင် မတွေ့ပါ။"
        });
      }

      const jobId =
        crypto.randomUUID();

      jobs.set(jobId, {
        progress: 0,
        completed: 0,
        total: 0,
        status: "starting",
        srt: null,
        error: null,
        clients: new Set()
      });

      runTranslation(
        jobId,
        req.file.path
      );

      res.json({
        success: true,
        jobId
      });

    } catch (error) {

      console.error(error);

      try {

        if (req.file?.path) {
          fs.unlinkSync(
            req.file.path
          );
        }

      } catch {}

      res.status(500).json({
        error:
          error.message ||
          "ဘာသာပြန်ရာတွင် Error ဖြစ်နေပါတယ်။"
      });
    }
  }
);


// ========================================
// REAL-TIME PROGRESS
// ========================================

app.get(
  "/progress/:jobId",
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).end();
    }

    res.setHeader(
      "Content-Type",
      "text/event-stream"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-transform"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );

    if (res.flushHeaders) {
      res.flushHeaders();
    }

    job.clients.add(res);

    res.write(
      `data: ${JSON.stringify({
        progress: job.progress,
        completed: job.completed,
        total: job.total,
        status: job.status,
        error: job.error || null
      })}\n\n`
    );

    const heartbeat =
      setInterval(() => {

        try {
          res.write(
            ": heartbeat\n\n"
          );
        } catch {}

      }, 15000);

    req.on(
      "close",
      () => {

        clearInterval(
          heartbeat
        );

        job.clients.delete(
          res
        );
      }
    );
  }
);


// ========================================
// GET RESULT
// ========================================

app.get(
  "/result/:jobId",
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Job မတွေ့ပါ။"
      });
    }

    if (
      job.status === "failed"
    ) {

      return res.status(500).json({
        error:
          job.error ||
          "ဘာသာပြန်မအောင်မြင်ပါ။"
      });
    }

    if (
      job.status !== "completed" ||
      !job.srt
    ) {

      return res.status(202).json({
        status:
          job.status,
        progress:
          job.progress
      });
    }

    res.json({
      success: true,
      srt: job.srt,
      total: job.total
    });

    setTimeout(() => {

      jobs.delete(
        req.params.jobId
      );

    }, 60000);
  }
);


// ========================================
// START SERVER
// ========================================

app.listen(
  PORT,
  () => {

    console.log(
      `Myanmar Subtitle server running on port ${PORT}`
    );

  }
);
