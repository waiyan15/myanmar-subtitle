import express from "express";
import multer from "multer";
import fs from "fs";

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
// Gemini REST API with Auto Retry
// ======================================

async function askGemini(prompt, maxRetries = 3) {

  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY မတွေ့ပါ။ Render Environment ကို စစ်ပါ။");
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
          throw new Error("Gemini က ဘာသာပြန်စာ ပြန်မပေးပါ။");
        }

        return text;
      }


      // Gemini server busy / high demand
      const errorMessage =
        data.error?.message ||
        "Gemini API error";

      lastError = errorMessage;

      const retryable =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        errorMessage.toLowerCase().includes("high demand") ||
        errorMessage.toLowerCase().includes("temporarily");

      if (!retryable) {
        throw new Error(errorMessage);
      }

      if (attempt < maxRetries) {

        console.log(
          `Gemini busy. Retry ${attempt}/${maxRetries}...`
        );

        // 5 sec, 10 sec, 15 sec
        await new Promise(resolve =>
          setTimeout(resolve, attempt * 5000)
        );
      }

    } catch (error) {

      lastError = error.message;

      if (attempt === maxRetries) {
        throw new Error(lastError);
      }

      console.log(
        `Retry ${attempt}/${maxRetries}: ${error.message}`
      );

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 5000)
      );
    }
  }

  throw new Error(lastError || "Gemini API error");
}


// ======================================
// Remove Markdown code blocks
// ======================================

function cleanSrt(text) {

  return text
    .replace(/```srt/gi, "")
    .replace(/```/g, "")
    .trim();
}


// ======================================
// Split SRT into subtitle blocks
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
// Translate one batch
// ======================================

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

SRT TO TRANSLATE:

${source}
`;

  return cleanSrt(
    await askGemini(prompt)
  );
}


// ======================================
// SRT → Myanmar
// ======================================

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

      const srt =
        fs.readFileSync(
          req.file.path,
          "utf8"
        );

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


      // Batch size
      // 30 subtitle entries per Gemini request
      const BATCH_SIZE = 30;

      const totalBatches =
        Math.ceil(blocks.length / BATCH_SIZE);

      const translated = [];


      // Tell browser progress through response headers
      // The frontend uses polling-style requests
      // for each batch.

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

        console.log(
          `Translating batch ${i + 1}/${totalBatches}`
        );

        const result =
          await translateBatch(batch);

        translated.push(result);
      }


      const finalSrt =
        translated.join("\n\n").trim();


      try {
        fs.unlinkSync(req.file.path);
      } catch {}


      res.json({
        success: true,
        srt: finalSrt,
        total: blocks.length
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


// ======================================
// Start
// ======================================

app.listen(PORT, () => {
  console.log(
    `Myanmar Subtitle server running on port ${PORT}`
  );
});
