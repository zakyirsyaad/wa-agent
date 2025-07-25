import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { personaProAIOrchestrator } from "./agents.js";
import multer from "multer";
const upload = multer();

dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const client = new OpenAI();

app.post("/api/v1/character/add-knowledge/text", async (req, res) => {
  try {
    const { userId, title, text } = req.body;
    if (!userId || !text) {
      return res.status(400).json({ error: "userId dan text wajib diisi" });
    }
    // Upload text sebagai file sementara ke OpenAI
    const tmpFilePath = `tmp_${Date.now()}.txt`;
    require("fs").writeFileSync(tmpFilePath, text, "utf8");
    const file = await client.files.create({
      file: require("fs").createReadStream(tmpFilePath),
      purpose: "assistants",
      metadata: { user_id: userId, title: title || null, type: "text" },
    });
    require("fs").unlinkSync(tmpFilePath);
    // Tambahkan file ke vector store
    await client.vectorStores.fileBatches.create(process.env.VECTOR_STORE_ID, {
      file_ids: [file.id],
    });
    res.json({ success: true, file_id: file.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post(
  "/api/v1/character/add-knowledge/pdf",
  upload.single("file"),
  async (req, res) => {
    try {
      const { userId, title } = req.body;
      if (!userId || !req.file) {
        return res.status(400).json({ error: "userId dan file wajib diisi" });
      }
      // Upload PDF ke OpenAI
      const file = await client.files.create({
        file: req.file.buffer,
        filename: req.file.originalname,
        purpose: "assistants",
        metadata: {
          user_id: userId,
          title: title || req.file.originalname,
          type: "pdf",
        },
      });
      // Tambahkan file ke vector store
      await client.vectorStores.fileBatches.create(
        process.env.VECTOR_STORE_ID,
        { file_ids: [file.id] }
      );
      res.json({ success: true, file_id: file.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.get("/api/v1/character/knowledge", async (req, res) => {
  res.status(501).json({
    error: "Not implemented. Knowledge base now in vector store OpenAI.",
  });
});

const defaultAgentInstructions = personaProAIOrchestrator.instructions;
const agentInstructionsMap = {
  personapro_ai:
    personaProAIOrchestrator.instructions +
    "\nJawab tanpa markdown, heading, atau bullet. Gunakan format yang mudah dibaca di WhatsApp.",
  marketmaven:
    "Anda adalah MarketMaven Agent, spesialis analisis dan strategi pemasaran digital. Tugas Anda: memantau tren, menganalisis audiens, mengoptimalkan kampanye, dan membuat laporan performa pemasaran. Selalu berikan insight yang actionable dan berbasis data. Jawab tanpa markdown, heading, atau bullet. Gunakan format yang mudah dibaca di WhatsApp.",
  contentcrafter:
    "Anda adalah ContentCrafter Agent, ahli manajemen dan pembuatan konten media sosial. Tugas Anda: membuat ide konten, caption, hashtag, menjadwalkan postingan, mengadaptasi konten untuk tiap platform, dan memantau brand mention. Pastikan konten selalu relevan, menarik, dan sesuai persona brand. Jawab tanpa markdown, heading, atau bullet. Gunakan format yang mudah dibaca di WhatsApp.",
  careconnect:
    "Anda adalah CareConnect Agent, spesialis layanan pelanggan dan interaksi digital. Tugas Anda: memberikan respons otomatis, personalisasi interaksi, menangani keluhan awal, dan mengumpulkan feedback pelanggan. Fokus pada respons cepat, akurat, dan menjaga kepuasan pelanggan. Jawab tanpa markdown, heading, atau bullet. Gunakan format yang mudah dibaca di WhatsApp.",
};

app.post("/api/v1/character/chat", async (req, res) => {
  try {
    const { userId, message, agent, history } = req.body;
    const agentKey = (agent || "personapro_ai").toLowerCase();
    const instructions =
      agentInstructionsMap[agentKey] || agentInstructionsMap["personapro_ai"];
    // Gabungkan history + pesan terbaru
    let openaiInput;
    if (history && Array.isArray(history) && history.length > 0) {
      openaiInput = history.concat([{ role: "user", content: message }]);
    } else {
      openaiInput = message;
    }
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: openaiInput,
      instructions,
      tools: [{ type: "web_search" }],
    });
    const output = response.output?.find((o) => o.type === "message");
    const text = output?.content?.[0]?.text;
    res.json({ response: text || "Maaf, tidak ada jawaban." });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is runing on port ${PORT}`);
});
