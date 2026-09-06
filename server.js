import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const app = express();
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

app.use(express.static("public"));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function cleanSrt(text) {
  return text
    .replace(/^```srt\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

// ===============================
// VIDEO → MYANMAR SRT
// ===============================
app.post("/generate", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Video file မတွေ့ပါ"
      });
    }

    const video = await ai.files.upload({
      file: req.file.path,
      config: {
        mimeType: req.file.mimetype
      }
    });

    let fileInfo = video;

    while (fileInfo.state === "PROCESSING") {
      await new Promise(resolve => setTimeout(resolve, 3000));
      fileInfo = await ai.files.get({
        name: video.name
      });
    }

    if (fileInfo.state === "FAILED") {
      throw new Error("Video processing failed");
    }

    const prompt = `
ဒီ video ထဲက ပြောဆိုထားတဲ့ စကားတွေကို
သဘာဝကျတဲ့ မြန်မာဘာသာနဲ့ subtitle ပြုလုပ်ပါ။

SRT format အတိအကျနဲ့ပဲ ပြန်ပေးပါ။

ဥပမာ:

1
00:00:00,000 --> 00:00:03,000
မြန်မာစာ

2
00:00:03,000 --> 00:00:06,000
မြန်မာစာ

Timestamp တွေကို သင့်တော်အောင် ခွဲပေးပါ။

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
        {
          text: prompt
        }
      ]
    });

    const srt = cleanSrt(result.text);

    try {
      fs.unlinkSync(req.file.path);
    } catch {}

    res.json({
      srt
    });

  } catch (error) {

    console.error(error);

    try {
      if (req.file?.path) {
        fs.unlinkSync(req.file.path);
      }
    } catch {}

    res.status(500).json({
      error: error.message || "Video subtitle error"
    });
  }
});

// ===============================
// SRT → MYANMAR SRT
// ===============================
app.post("/translate-srt", upload.single("srt"), async (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({
        error: "SRT file မတွေ့ပါ"
      });
    }

    const originalSrt = fs.readFileSync(
      req.file.path,
      "utf8"
    );

    if (!originalSrt.trim()) {
      throw new Error("SRT file အလွတ်ဖြစ်နေပါတယ်");
    }

    const prompt = `
အောက်မှာပေးထားတဲ့ SRT subtitle ကို
သဘာဝကျပြီး နားလည်လွယ်တဲ့ မြန်မာဘာသာနဲ့ ဘာသာပြန်ပါ။

အရေးကြီးဆုံး စည်းမျဉ်းများ:

1. Subtitle နံပါတ်တွေကို လုံးဝမပြောင်းပါနဲ့။
2. Timestamp တွေကို လုံးဝမပြောင်းပါနဲ့။
3. Timestamp အစီအစဉ်ကို မပြောင်းပါနဲ့။
4. HTML tags, formatting tags တွေရှိရင် မဖျက်ပါနဲ့။
5. Subtitle စာသားကိုပဲ မြန်မာလို ဘာသာပြန်ပါ။
6. လူနာမည်၊ နေရာနာမည်တွေကို သင့်တော်သလို အသံထွက်အတိုင်း ရေးပါ။
7. စကားပြောပုံကို သဘာဝကျအောင် ဘာသာပြန်ပါ။
8. မူရင်း subtitle အရေအတွက်ကို မပြောင်းပါနဲ့။
9. SRT format အတိုင်း အတိအကျ ပြန်ပေးပါ။
10. အခြားရှင်းပြချက် မထည့်ပါနဲ့။
11. Markdown code block မသုံးပါနဲ့။

မူရင်း SRT:

${originalSrt}
`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          text: prompt
        }
      ]
    });

    const translatedSrt = cleanSrt(result.text);

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
      error: error.message || "SRT translation error"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
