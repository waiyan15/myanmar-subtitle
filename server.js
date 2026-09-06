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


// ======================================
// Translation Jobs
// ======================================

const jobs = new Map();


// ======================================
// Gemini REST API + Auto Retry
// ======================================

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

      } else {

        throw new Error(
          `Gemini API မအားသေးပါ။ Retry ${maxRetries} ကြိမ်လုပ်ပြီးပါပြီ။ ${errorMessage}`
        );
      }

    } catch (error) {

      lastError =
        error.message ||
        "Gemini API error";

      const lower =
        lastError.toLowerCase();

      const retryable =
        lower.includes("high demand") ||
        lower.includes("temporarily") ||
        lower.includes("overloaded") ||
        lower.includes("unavailable") ||
        lower.includes("429") ||
        lower.includes("500") ||
        lower.includes("502") ||
        lower.includes("503");

      if (!retryable || attempt === maxRetries) {
        throw new Error(lastError);
      }

      console.log(
        `Retry ${attempt}/${maxRetries}: ${lastError}`
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


// ======================================
// Clean SRT
// ======================================

function cleanSrt(text) {

  return text
    .replace(/```srt/gi, "")
    .replace(/```/g, "")
    .trim();
}


// ======================================
// Parse SRT
// ======================================

function parseSrt(srt) {

  return srt
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);
}


// ======================================
// Translate Batch
// ======================================

async function translateBatch(blocks) {

  const source =
    blocks.join("\n\n");

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
14. Every subtitle entry in the input MUST appear in the output.
15. Do not merge subtitle entries.
16. Do not split subtitle entries.

SRT TO TRANSLATE:

${source}
`;

  return cleanSrt(
    await askGemini(prompt)
  );
}


// ======================================
// Update Job
// ======================================

function updateJob(jobId, data) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  Object.assign(
    job,
    data
  );

  if (job.clients) {

    const message =
      `data: ${JSON.stringify({
        progress: job.progress,
        completed: job.completed,
        total: job.total,
        status: job.status,
        error: job.error || null
      })}\n\n`;

    for (const client of job.clients) {

      try {
        client.write(message);
      } catch {}
    }
  }
}


// ======================================
// Run Translation Job
// ======================================

async function runTranslation(
  jobId,
  filePath
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  try {

    updateJob(
      jobId,
      {
        progress: 0,
        completed: 0,
        status: "SRT ဖိုင်ကို ဖတ်နေပါသည်..."
      }
    );

    const srt =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    if (!srt.trim()) {
      throw new Error(
        "SRT ဖိုင် အလွတ်ဖြစ်နေပါတယ်။"
      );
    }

    const blocks =
      parseSrt(srt);

    if (blocks.length === 0) {
      throw new Error(
        "SRT format မမှန်ပါ။"
      );
    }

    // ==================================
    // IMPORTANT
    // 10 subtitles per Gemini request
    // ==================================

    const BATCH_SIZE = 10;

    const total =
      blocks.length;

    const totalBatches =
      Math.ceil(
        total / BATCH_SIZE
      );

    job.total =
      total;

    updateJob(
      jobId,
      {
        progress: 0,
        completed: 0,
        total,
        status:
          `ဘာသာပြန်နေပါသည်... 0 / ${total}`
      }
    );

    const translated = [];

    // ==================================
    // Translate batch by batch
    // ==================================

    for (
      let i = 0;
      i < totalBatches;
      i++
    ) {

      const start =
        i * BATCH_SIZE;

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

      console.log(
        `Translating batch ${i + 1}/${totalBatches}: ${batchStart}-${batchEnd}`
      );

      // Show current work
      updateJob(
        jobId,
        {
          progress:
            Math.round(
              (start / total) * 100
            ),

          completed:
            start,

          total,

          status:
            `Gemini မှ ${batchStart}-${batchEnd} / ${total} ကို ဘာသာပြန်နေပါသည်...`
        }
      );

      // ==================================
      // Gemini translation
      // ==================================

      const result =
        await translateBatch(batch);

      translated.push(result);

      // ==================================
      // REAL PROGRESS
      // ==================================

      const completed =
        batchEnd;

      const progress =
        Math.round(
          (completed / total) * 100
        );

      updateJob(
        jobId,
        {
          progress,
          completed,
          total,
          status:
            `ဘာသာပြန်ပြီးပါပြီ... ${completed} / ${total}`
        }
      );

      console.log(
        `Progress: ${progress}% (${completed}/${total})`
      );
    }


    // ==================================
    // Final SRT
    // ==================================

    const finalSrt =
      translated
        .join("\n\n")
        .trim();

    if (!finalSrt) {
      throw new Error(
        "ဘာသာပြန်ပြီး SRT မရရှိပါ။"
      );
    }

    job.srt =
      finalSrt;

    updateJob(
      jobId,
      {
        progress: 100,
        completed: total,
        total,
        status: "completed"
      }
    );

    console.log(
      `Translation completed: ${jobId}`
    );

    // Delete uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch {}

    // Close SSE
    setTimeout(() => {

      const currentJob =
        jobs.get(jobId);

      if (!currentJob) {
        return;
      }

      if (currentJob.clients) {

        for (
          const client
          of currentJob.clients
        ) {

          try {
            client.end();
          } catch {}
        }

        currentJob.clients.clear();
      }

    }, 1000);


  } catch (error) {

    console.error(
      "Translation error:",
      error
    );

    updateJob(
      jobId,
      {
        progress: 0,
