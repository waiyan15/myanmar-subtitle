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

async function askGemini(prompt, maxRetries = 3) {

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
            ]
          })
        }
      );


      const data = await response.json();


      if (response.ok) {

        const text =
          data.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("") || "";


        if (!text) {
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
        lower.includes("overloaded");


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
    lastError ||
    "Gemini API error"
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

function updateJob(
  jobId,
  data
) {

  const job =
    jobs.get(jobId);


  if (!job) {
    return;
  }


  Object.assign(
    job,
    data
  );


  // Send update to connected browser
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
        status: "ဘာသာပြန်ရန် ပြင်ဆင်နေပါသည်..."
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


    const BATCH_SIZE = 30;


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
    // Translate Batch by Batch
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
        `Translating batch ${i + 1}/${totalBatches}`
      );


      updateJob(
        jobId,
        {
          status:
            `ဘာသာပြန်နေပါသည်... ${batchStart}-${batchEnd} / ${total}`
        }
      );


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
            `ဘာသာပြန်နေပါသည်... ${completed} / ${total}`
        }
      );
    }


    // ==================================
    // Final SRT
    // ==================================

    const finalSrt =
      translated
        .join("\n\n")
        .trim();


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


    // Close SSE clients after short delay
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
        status: "failed",
        error:
          error.message ||
          "ဘာသာပြန်ရာတွင် Error ဖြစ်နေပါတယ်။"
      }
    );


    try {
      fs.unlinkSync(filePath);
    } catch {}


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
  }
}


// ======================================
// Start Translation
// ======================================

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


      jobs.set(
        jobId,
        {
          progress: 0,
          completed: 0,
          total: 0,
          status: "starting",
          srt: null,
          error: null,
          clients: new Set()
        }
      );


      // Start translation in background
      runTranslation(
        jobId,
        req.file.path
      );


      // Immediately return Job ID
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


// ======================================
// REAL-TIME PROGRESS SSE
// ======================================

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
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );


    if (res.flushHeaders) {
      res.flushHeaders();
    }


    job.clients.add(res);


    // Send current progress immediately
    const initial =
      `data: ${JSON.stringify({
        progress: job.progress,
        completed: job.completed,
        total: job.total,
        status: job.status,
        error: job.error || null
      })}\n\n`;


    try {
      res.write(initial);
    } catch {}


    // Keep connection alive
    const heartbeat =
      setInterval(() => {

        try {
          res.write(": heartbeat\n\n");
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


// ======================================
// Get Final Result
// ======================================

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
        status: job.status,
        progress: job.progress
      });

    }


    const result =
      job.srt;


    res.json({
      success: true,
      srt: result,
      total: job.total
    });


    /*
     * Delete job after result has been downloaded.
     */

    setTimeout(() => {
      jobs.delete(
        req.params.jobId
      );
    }, 60000);

  }
);


// ======================================
// Start Server
// ======================================

app.listen(
  PORT,
  () => {

    console.log(
      `Myanmar Subtitle server running on port ${PORT}`
    );

  }
);
