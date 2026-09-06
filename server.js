import express from "express";
import multer from "multer";
import fs from "fs";

const app = express();

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

app.use(express.static("public"));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

if (!API_KEY) {
  console.error("GEMINI_API_KEY is missing");
}

// ===============================
// GEMINI REST API
// ===============================

async function generateContent(contents) {

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        contents
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      "Gemini API request failed"
    );
  }

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  if (!text) {
    throw new Error("Gemini က စာသားပြန်မပေးပါ");
  }

  return text;
}


// ===============================
// CLEAN SRT
// ===============================

function cleanSrt(text) {

  return text
    .replace(/^```srt\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}


// ===============================
// SRT → MYANMAR SRT
// ===============================

app.post(
  "/translate-srt",
  upload.single("srt"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error: "SRT file မတွေ့ပါ"
        });
      }

      const originalSrt =
        fs.readFileSync(
          req.file.path,
          "utf8"
        );

      if (!originalSrt.trim()) {
        throw new Error(
          "SRT file အလွတ်ဖြစ်နေပါတယ်"
        );
      }

      const prompt = `
Translate the following SRT subtitle into natural,
easy-to-understand Myanmar Burmese.

IMPORTANT RULES:

1. Keep every subtitle number EXACTLY the same.
2. Keep every timestamp EXACTLY the same.
3. Do NOT change timestamp formatting.
4. Do NOT add or remove subtitle entries.
5. Translate ONLY the subtitle dialogue.
6. Preserve HTML tags if present.
7. Preserve line breaks when appropriate.
8. Make the Myanmar translation natural and conversational.
9. Do not translate names unnecessarily.
10. Return ONLY valid SRT.
11. Do NOT use Markdown code blocks.
12. Do NOT add explanations.

SOURCE SRT:

${originalSrt}
`;

      const result = await generateContent([
        {
          role: "user",
          parts: [
            {
              text: prompt
            }
          ]
        }
      ]);

      const translatedSrt =
        cleanSrt(result);

      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      res.json({
        srt: translatedSrt
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
          "SRT translation error"
      });
    }
  }
);


// ===============================
// VIDEO → MYANMAR SRT
// ===============================

app.post(
  "/generate",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error: "Video file မတွေ့ပါ"
        });
      }

      const filePath = req.file.path;
      const mimeType = req.file.mimetype;
      const fileSize = fs.statSync(filePath).size;

      // --------------------------------
      // 1. Start resumable upload
      // --------------------------------

      const startResponse = await fetch(
        "https://generativelanguage.googleapis.com/upload/v1beta/files",
        {
          method: "POST",
          headers: {
            "x-goog-api-key": API_KEY,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length":
              String(fileSize),
            "X-Goog-Upload-Header-Content-Type":
              mimeType,
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            file: {
              display_name: req.file.originalname
            }
          })
        }
      );

      if (!startResponse.ok) {

        const errorText =
          await startResponse.text();

        throw new Error(
          `File upload start failed: ${errorText}`
        );
      }

      const uploadUrl =
        startResponse.headers.get(
          "x-goog-upload-url"
        );

      if (!uploadUrl) {
        throw new Error(
          "Gemini upload URL မရပါ"
        );
      }


      // --------------------------------
      // 2. Upload video
      // --------------------------------

      const videoBuffer =
        fs.readFileSync(filePath);

      const uploadResponse = await fetch(
        uploadUrl,
        {
          method: "POST",
          headers: {
            "Content-Length":
              String(fileSize),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command":
              "upload, finalize"
          },
          body: videoBuffer
        }
      );

      const uploadedFile =
        await uploadResponse.json();

      if (!uploadResponse.ok) {
        throw new Error(
          uploadedFile.error?.message ||
          "Video upload failed"
        );
      }

      const fileUri =
        uploadedFile.file?.uri;

      const fileName =
        uploadedFile.file?.name;

      if (!fileUri || !fileName) {
        throw new Error(
          "Gemini file information မရပါ"
        );
      }


      // --------------------------------
      // 3. Wait until video is READY
      // --------------------------------

      let fileInfo = uploadedFile.file;

      while (
        fileInfo.state === "PROCESSING"
      ) {

        await new Promise(
          resolve =>
            setTimeout(resolve, 5000)
        );

        const statusResponse =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}`,
            {
              headers: {
                "x-goog-api-key":
                  API_KEY
              }
            }
          );

        const statusData =
          await statusResponse.json();

        if (!statusResponse.ok) {
          throw new Error(
            statusData.error?.message ||
            "Video status error"
          );
        }

        fileInfo = statusData.file;
      }

      if (
        fileInfo.state === "FAILED"
      ) {
        throw new Error(
          "Gemini video processing failed"
        );
      }


      // --------------------------------
      // 4. Generate Myanmar SRT
      // --------------------------------

      const prompt = `
Watch this video carefully and create
Myanmar Burmese subtitles.

IMPORTANT:

1. Listen to the spoken dialogue.
2. Translate the dialogue naturally into Myanmar.
3. Create valid SRT format.
4. Include accurate timestamps.
5. Split subtitles into readable segments.
6. Do not add explanations.
7. Do not use Markdown code blocks.
8. Return ONLY the SRT.

Example:

1
00:00:00,000 --> 00:00:03,000
မြန်မာစာ

2
00:00:03,000 --> 00:00:06,000
မြန်မာစာ
`;

      const result =
        await generateContent([
          {
            role: "user",
            parts: [
              {
                text: prompt
              },
              {
                file_data: {
                  mime_type:
                    fileInfo.mimeType ||
                    mimeType,
                  file_uri:
                    fileUri
                }
              }
            ]
          }
        ]);

      const srt =
        cleanSrt(result);


      // --------------------------------
      // 5. Delete temporary file
      // --------------------------------

      try {
        fs.unlinkSync(filePath);
      } catch {}


      res.json({
        srt
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
          "Video subtitle error"
      });
    }
  }
);


// ===============================
// START SERVER
// ===============================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});
