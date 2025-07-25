import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function createVectorStore() {
  const vectorStore = await openai.vectorStores.create({
    name: "ElainaKnowledgeBase",
  });
  console.log("Vector Store ID:", vectorStore.id);
}

async function uploadFileToVectorStore(filePath, userId, title) {
  if (!process.env.VECTOR_STORE_ID) {
    console.error("VECTOR_STORE_ID belum diisi di .env");
    return;
  }
  const file = await openai.files.create({
    file: fs.createReadStream(filePath),
    purpose: "assistants",
    metadata: {
      user_id: userId,
      title: title || filePath,
      type: filePath.endsWith(".pdf") ? "pdf" : "text",
    },
  });
  await openai.vectorStores.fileBatches.create(process.env.VECTOR_STORE_ID, {
    file_ids: [file.id],
  });
  console.log("File uploaded & added to vector store:", file.id);
}

// --- Cara pakai ---
// node create_vector_store.js create
// node create_vector_store.js upload path/to/file.pdf userId "Judul Knowledge"

const [, , cmd, ...args] = process.argv;
if (cmd === "create") {
  createVectorStore();
} else if (cmd === "upload") {
  const [filePath, userId, title] = args;
  if (!filePath || !userId) {
    console.log(
      "Usage: node create_vector_store.js upload <filePath> <userId> [title]"
    );
    process.exit(1);
  }
  uploadFileToVectorStore(filePath, userId, title);
} else {
  console.log("Usage:");
  console.log("  node create_vector_store.js create");
  console.log(
    "  node create_vector_store.js upload <filePath> <userId> [title]"
  );
}
