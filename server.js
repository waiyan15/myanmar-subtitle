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


// ================================
// Gemini API
// ================================

async function askGemini(prompt, maxRetries = 4) {

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY မတွေ့ပါ။ Render Environment ကို စစ်ပါ။"
    );
  }

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

      const data = await response.json();

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

        const waitSeconds = attempt * 5;

        console.log(
          `Gemini busy. Retry ${attempt}/${maxRetries} after ${waitSeconds}s`
        );

        await new Promise(resolve =>
          setTimeout(resolve, waitSeconds * 1000)
        );
      }

    } catch (error) {

      lastError =
        error.message || "Gemini API error";

      if (attempt === maxRetries) {
        throw new Error(lastError);
      }

      console.log(
        `Retry ${attempt}/${maxRetries}: ${lastError}`
      );

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 5000)
      );
    }
  }

  throw new Error(
    lastError || "Gemini API error"
  );
}


// ================================
// SRT Functions
// ================================

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


// ================================
// Translate
// ================================

async function translateBatch(blocks) {

  const source = blocks.join("\n\n");

  const prompt = `
Translate the following SRT subtitles into natural Myanmar Burmese.

STRICT RULES:

1. Keep subtitle numbers EXACTLY unchanged.
2. Keep timestamps EXACTLY unchanged.
3. Never change timestamps.
4. Never change subtitle numbering.
5. Do not add subtitle numbers.
6. Do not remove subtitle entries.
7. Translate ONLY the spoken dialogue.
8. Keep HTML tags such as <i>, </i>, <b>, </b> unchanged.
9. Keep line breaks where possible.
10. Use natural, easy-to-understand Myanmar Burmese.
11. Do not explain anything.
12. Return ONLY valid SRT.
13. Do NOT use Markdown code blocks.
14. Every subtitle entry MUST appear.
15. Do not merge subtitle entries.
16. Do not split subtitle entries.

SRT TO TRANSLATE:

${source}
`;

  return cleanSrt(
    await askGemini(prompt)
  );
}


// ================================
// Job Update
// ================================

function updateJob(jobId, data) {

  const job = jobs.get(jobId);

  if (!job) return;

  Object.assign(job, data);

  const message =
    `data: ${JSON.stringify({
      progress: job.progress,
      completed: job.completed,
      total: job.total,
      status: job.status,
      error: job.error || null
    })}\n\n`;

  if (job.clients) {

    for (const client of job.clients) {

      try {
        client.write(message);
      } catch {}
    }
  }
}


// ================================
// Translation Worker
// ================================

async function runTranslation(jobId, filePath) {

  const job = jobs.get(jobId);

  if (!job) return;

  try {

    updateJob(jobId, {
      progress: 0,
      completed: 0,
      status: "SRT ဖိုင်ကို ဖတ်နေပါသည်..."
    });

    const srt =
      fs.readFileSync(filePath, "utf8");

    if (!srt.trim()) {
      throw new Error(
        "SRT ဖိုင် အလွတ်ဖြစ်နေပါတယ်။"
      );
    }

    const blocks = parseSrt(srt);

    if (blocks.length === 0) {
      throw new Error(
        "SRT format မမှန်ပါ။"
      );
    }

    // 10 subtitles per request
    const BATCH_SIZE = 10;

    const total = blocks.length;

    job.total = total;

    const translated = [];

    updateJob(jobId, {
      progress: 0,
      completed: 0,
      total,
      status:
        `ဘာသာပြန်နေပါသည်... 0 / ${total}`
    });


    for (
      let start = 0;
      start < total;
      start += BATCH_SIZE
    ) {

      const batch =
        blocks.slice(
          start,
          start + BATCH_SIZE
              );

    const batchStart =
      start + 1;

    const batchEnd =
      Math.min(
        start + batch.length,
        total
      );

    updateJob(jobId, {
      progress:
        Math.round(
          (start / total) * 100
        ),
      completed: start,
      total,
      status:
        `Gemini မှ ${batchStart}-${batchEnd} / ${total} ကို ဘာသာပြန်နေပါသည်...`
    });

    console.log(
      `Translating ${batchStart}-${batchEnd} / ${total}`
    );

    const result =
      await translateBatch(batch);

    translated.push(result);

    const completed = batchEnd;

    const progress =
      Math.round(
        (completed / total) * 100
      );

    updateJob(jobId, {
      progress,
      completed,
      total,
      status:
        `ဘာသာပြန်ပြီးပါပြီ... ${completed} / ${total}`
    });

    console.log(
      `Progress ${progress}%`
    );
  }

  const finalSrt =
    translated.join("\n\n").trim();

  if (!finalSrt) {
    throw new Error(
      "ဘာသာပြန်ပြီး SRT မရရှိပါ။"
    );
  }

  job.srt = finalSrt;

  updateJob(jobId, {
    progress: 100,
    completed: total,
    total,
    status: "completed"
  });

  console.log(
    `Translation completed: ${jobId}`
  );

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

} catch (error) {

  console.error(
    "Translation error:",
    error
  );

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


// ================================
// Upload SRT
// ================================

app.post(
  "/translate-srt",
  upload.single("srt"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error: "SRT ဖိုင် မတွေ့ပါ။"
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
          fs.unlinkSync(req.file.path);
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


// ================================
// REAL-TIME PROGRESS
// ================================

app.get(
  "/progress/:jobId",
  (req, res) => {

    const job =
      jobs.get(req.params.jobId);

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
          res.write(": heartbeat\n\n");
        } catch {}

      }, 15000);

    req.on(
      "close",
      () => {

        clearInterval(heartbeat);

        job.clients.delete(res);
      }
    );
  }
);


// ================================
// GET RESULT
// ================================

app.get(
  "/result/:jobId",
  (req, res) => {

    const job =
      jobs.get(req.params.jobId);

    if (!job) {

      return res.status(404).json({
        error: "Job မတွေ့ပါ။"
      });
    }

    if (job.status === "failed") {

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
        status: job.status,
        progress: job.progress
      });
    }

    res.json({
      success: true,
      srt: job.srt,
      total: job.total
    });

    setTimeout(() => {
      jobs.delete(req.params.jobId);
    }, 60000);
  }
);


// ================================
// START SERVER
// ================================

app.listen(
  PORT,
  () => {
    console.log(
      `Myanmar Subtitle server running on port ${PORT}`
    );
  }
);
