import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));

app.post("/generate", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Video file မတွေ့ပါ" });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const video = await ai.files.upload({
      file: req.file.path,
      config: {
        mimeType: req.file.mimetype
      }
    });

    let fileInfo = video;

    while (fileInfo.state === "PROCESSING") {
      await new Promise(resolve => setTimeout(resolve, 3000));
      fileInfo = await ai.files.get({ name: video.name });
    }

    if (fileInfo.state === "FAILED") {
      throw new Error("Video processing failed");
    }

    const prompt = `
ဒီ video ထဲက ပြောဆိုထားတဲ့ စကားတွေကို မြန်မာဘာသာနဲ့ subtitle ပြုလုပ်ပါ။

SRT format အတိအကျနဲ့ပဲ ပြန်ပေးပါ။

Format:
1
00:00:00,000 --> 00:00:03,000
မြန်မာစာ

2
00:00:03,000 --> 00:00:06,000
မြန်မာစာ

စကားပြောတဲ့အပိုင်းတွေကို သင့်တော်တဲ့ timestamp နဲ့ ခွဲပေးပါ။
SRT code block မသုံးပါနဲ့။
အခြားရှင်းပြချက် မထည့်ပါနဲ့။
`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          fileData: {
            fileUri: fileInfo.uri,
            mimeType: fileInfo.mimeType
          }
        },
        { text: prompt }
      ]
    });

    let srt = result.text.trim();

    srt = srt
      .replace(/^```srt\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    fs.unlinkSync(req.file.path);

    res.json({ srt });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Subtitle ပြုလုပ်ရာမှာ အမှားဖြစ်နေပါတယ်"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
