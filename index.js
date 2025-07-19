import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import supabase from "./db.js";
import multer from "multer";
import { Readable } from "stream";
import axios from "axios";
import { default as makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "path";
import fs from "fs/promises"; // Menggunakan fs/promises untuk async/await

dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const client = new OpenAI();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const GENERAL_PURPOSE_ASSISTANT_ID = process.env.GENERAL_PURPOSE_ASSISTANT_ID;

// --- Definisi Tools ---
const trackWalletTool = {
  type: "function",
  function: {
    name: "track_wallet",
    description: "Lacak dan tampilkan informasi saldo wallet berdasarkan address dan chain (ethereum, bsc, polygon).",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "Alamat wallet yang akan dilacak." },
        chain: { type: "string", description: "Chain atau jaringan (ethereum, bsc, atau polygon)." },
      },
      required: ["address", "chain"],
    },
  },
};

// --- Fungsi Eksekusi Tools ---
const toolExecutors = {
  track_wallet: async ({ address, chain }) => {
    let apiUrl = "";
    let apiKey = "";
    let label = chain.toLowerCase();
    if (label === "ethereum") {
      apiUrl = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;
      apiKey = process.env.ETHERSCAN_API_KEY;
    } else if (["bsc", "binance", "binance smart chain"].includes(label)) {
      apiUrl = `https://api.bscscan.com/api?module=account&action=balance&address=${address}&apikey=${process.env.BSCSCAN_API_KEY}`;
      apiKey = process.env.BSCSCAN_API_KEY;
    } else if (["polygon", "matic"].includes(label)) {
      apiUrl = `https://api.polygonscan.com/api?module=account&action=balance&address=${address}&apikey=${process.env.POLYGONSCAN_API_KEY}`;
      apiKey = process.env.POLYGONSCAN_API_KEY;
    } else {
      return `Maaf, chain '${chain}' belum didukung. Coba gunakan ethereum, bsc, atau polygon.`;
    }
    if (!apiKey) return `API key untuk chain '${chain}' belum diatur. Hubungi admin.`;
    try {
      const resp = await axios.get(apiUrl);
      if (resp.data.status === "1") {
        const balance = Number(resp.data.result) / 1e18;
        const symbol = label === "ethereum" ? "ETH" : label === "bsc" ? "BNB" : "MATIC";
        return `Saldo wallet ${address} di jaringan ${chain}: ${balance} ${symbol}`;
      } else {
        return `Gagal mengambil data wallet: ${resp.data.message || "Unknown error"}`;
      }
    } catch (err) {
      return `Terjadi error saat mengambil data wallet: ${err.message}`;
    }
  },
};

// --- Fungsi Utama untuk Berinteraksi dengan OpenAI Assistant ---
async function processAssistantMessage(userId, messageContent, fileBuffer = null, fileName = null, sock = null) {
  let threadId = null;
  try {
    let { data: user, error: userError } = await supabase.from("users").select("thread_id").eq("id", userId).single();

    if (userError && userError.code !== "PGRST116") {
      console.error("Supabase user query error:", userError);
      throw userError;
    }

    if (user && user.thread_id) {
      threadId = user.thread_id;
    } else {
      const thread = await client.beta.threads.create();
      threadId = thread.id;
      const { error: updateError } = await supabase.from("users").upsert({ id: userId, thread_id: threadId }, { onConflict: "id" });
      if (updateError) {
        console.error("Supabase threadId upsert error:", updateError);
        throw updateError;
      }
    }
  } catch (err) {
    console.error("Error mendapatkan atau membuat thread ID:", err);
    return { error: "Gagal mendapatkan atau membuat thread ID.", details: err.message };
  }

  if (!threadId) {
    console.error("Thread ID masih undefined setelah proses akuisisi.");
    return { error: "Gagal mendapatkan thread ID yang valid." };
  }

  const finalThreadId = threadId;

  // Cancel any active runs on this thread before proceeding
  try {
    const runs = await client.beta.threads.runs.list(finalThreadId, { limit: 1 });

    if (runs.data.length > 0) {
      let lastRun = runs.data[0];

      // Check if the last run is in a non-terminal state
      if (["queued", "in_progress", "cancelling"].includes(lastRun.status)) {
        console.log(`An active run (${lastRun.id}) was found with status: ${lastRun.status}. Attempting to cancel.`);

        // Cancel the active run
        lastRun = await client.beta.threads.runs.cancel(finalThreadId, lastRun.id);

        // Poll the run's status until it reaches a terminal state
        while (["queued", "in_progress", "cancelling"].includes(lastRun.status)) {
          await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms between checks
          lastRun = await client.beta.threads.runs.retrieve(finalThreadId, lastRun.id);
          console.log(`... Awaiting cancellation. Current status: ${lastRun.status}`);
        }

        console.log(`Run ${lastRun.id} is now in a terminal state: ${lastRun.status}. Proceeding with new message.`);
      }
    }
  } catch (error) {
    console.error(`Error while checking or cancelling active runs for thread ${finalThreadId}:`, error);
    // Depending on your app's needs, you might want to return an error response here
  }

  let assistantId;
  let finalMessage = messageContent;

  // Logika untuk memilih asisten (default atau berdasarkan nama)
  const words = messageContent.trim().split(" ");
  const potentialName = words[0].replace(/,$/, "");

  const { data: namedAssistant, error: namedError } = await supabase.from("assistants").select("assistant_id, vector_store_id").eq("user_id", userId).ilike("name", potentialName).single();

  let assistantToUse;
  if (namedAssistant) {
    assistantToUse = namedAssistant;
    finalMessage = words.slice(1).join(" ");
  } else {
    const { data: defaultAssistant, error: defaultError } = await supabase.from("assistants").select("assistant_id, vector_store_id").eq("user_id", userId).eq("is_default", true).single();
    if (defaultAssistant) {
      assistantToUse = defaultAssistant;
    } else {
      // Jika tidak ada asisten default di DB, gunakan GENERAL_PURPOSE_ASSISTANT_ID dari .env
      // Pastikan GENERAL_PURPOSE_ASSISTANT_ID ini sudah diatur dengan code_interpreter dan file_search
      assistantToUse = { assistant_id: GENERAL_PURPOSE_ASSISTANT_ID, vector_store_id: null };
    }
  }

  assistantId = assistantToUse.assistant_id;

  let fileIds = [];
  if (fileBuffer && fileName) {
    try {
      const file = await client.files.create({
        file: new Readable({
          read() {
            this.push(fileBuffer);
            this.push(null);
          },
        }),
        purpose: "assistants",
        fileName: fileName,
      });
      fileIds.push(file.id);
      console.log(`File ${fileName} diunggah ke OpenAI dengan ID: ${file.id}`);
    } catch (uploadError) {
      console.error("Error mengunggah file ke OpenAI:", uploadError);
      return { error: "Gagal mengunggah file ke AI.", details: uploadError.message };
    }
  }

  await client.beta.threads.messages.create(finalThreadId, {
    role: "user",
    content: finalMessage,
    attachments: fileIds.length > 0 ? [{ file_id: fileIds[0], tools: [{ type: "code_interpreter" }, { type: "file_search" }] }] : [],
  });

  let run = await client.beta.threads.runs.create(finalThreadId, {
    assistant_id: assistantId,
  });

  while (["queued", "in_progress", "cancelling"].includes(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run = await client.beta.threads.runs.retrieve(finalThreadId, run.id);
  }

  if (run.status === "requires_action") {
    const toolOutputs = [];
    for (const toolCall of run.required_action.submit_tool_outputs.tool_calls) {
      const executor = toolExecutors[toolCall.function.name];
      if (executor) {
        const args = JSON.parse(toolCall.function.arguments);
        const output = await executor(args);
        toolOutputs.push({
          tool_call_id: toolCall.id,
          output: String(output),
        });
      }
    }
    run = await client.beta.threads.runs.submitToolOutputs(finalThreadId, run.id, {
      tool_outputs: toolOutputs,
    });
    while (["queued", "in_progress", "cancelling"].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = await client.beta.threads.runs.retrieve(finalThreadId, run.id);
    }
  }

  if (run.status === "completed") {
    const messages = await client.beta.threads.messages.list(finalThreadId, { order: "desc", limit: 1 });
    const lastMessage = messages.data.find((m) => m.run_id === run.id && m.role === "assistant");

    if (lastMessage) {
      const responses = [];
      for (const content of lastMessage.content) {
        if (content.type === "text") {
          let responseText = content.text.value;
          const annotations = content.text.annotations;

          if (annotations && annotations.length > 0) {
            for (const annotation of annotations) {
              if (annotation.type === "file_path") {
                const fileId = annotation.file_path.file_id;
                try {
                  const fileContent = await client.files.content(fileId);
                  const fileData = await fileContent.arrayBuffer();
                  const tempDir = path.join(__dirname, "temp");
                  await fs.mkdir(tempDir, { recursive: true });
                  const tempFilePath = path.join(tempDir, `openai_file_${fileId}_${Date.now()}`); // Nama file unik
                  await fs.writeFile(tempFilePath, Buffer.from(fileData));

                  responses.push({ type: "document", path: tempFilePath, fileName: `file_${fileId}` });
                  responseText = responseText.replace(annotation.text, `[File ${fileId} telah dikirim]`);
                } catch (fileDownloadError) {
                  console.error(`Error mengunduh file ${fileId} dari OpenAI:`, fileDownloadError);
                  responseText = responseText.replace(annotation.text, `[Gagal mengunduh file ${fileId}]`);
                }
              } else if (annotation.type === "file_citation") {
                // Handle file citation if needed, for now just remove the annotation text
                responseText = responseText.replace(annotation.text, "");
              }
            }
          }
          responses.push({ type: "text", content: responseText.trim() });
        } else if (content.type === "image_file") {
          const fileId = content.image_file.file_id;
          try {
            const fileContent = await client.files.content(fileId);
            const imageData = await fileContent.arrayBuffer();
            const tempDir = path.join(__dirname, "temp");
            await fs.mkdir(tempDir, { recursive: true });
            const tempFilePath = path.join(tempDir, `openai_image_${fileId}_${Date.now()}.png`); // Asumsi PNG
            await fs.writeFile(tempFilePath, Buffer.from(imageData));
            responses.push({ type: "image", path: tempFilePath });
          } catch (imageDownloadError) {
            console.error(`Error mengunduh gambar ${fileId} dari OpenAI:`, imageDownloadError);
            responses.push({ type: "text", content: `[Gagal mengunduh gambar ${fileId}]` });
          }
        }
      }
      return { success: true, responses: responses };
    } else {
      return { success: true, responses: [{ type: "text", content: "Saya tidak dapat menemukan jawaban yang sesuai." }] };
    }
  } else {
    console.error("Run failed with status:", run.status, run.last_error);
    return { error: "Terjadi kesalahan pada AI.", details: run.last_error?.message || "Unknown error" };
  }
}

// --- Endpoint untuk Manajemen Asisten ---
// (Tetap sama seperti sebelumnya)
app.post("/api/v1/assistants", async (req, res) => {
  const { userId, name, instructions, description } = req.body;
  if (!userId || !name || !instructions) {
    return res.status(400).json({ error: "userId, name, dan instructions diperlukan." });
  }

  let assistant = null;
  let vectorStore = null;

  try {
    console.log("Membuat asisten...");
    assistant = await client.beta.assistants.create({
      name: name,
      instructions: instructions,
      model: "gpt-4o-mini",
      tools: [{ type: "code_interpreter" }, { type: "file_search" }],
    });
    console.log(`Asisten dibuat dengan ID: ${assistant.id}`);

    console.log("Membuat Vector Store...");
    vectorStore = await client.vectorStores.create({
      name: `Vector Store untuk ${name}`,
    });
    console.log(`Vector Store dibuat dengan ID: ${vectorStore.id}`);

    console.log("Menautkan Vector Store ke Asisten...");
    await client.beta.assistants.update(assistant.id, {
      tool_resources: { file_search: { vector_store_ids: [vectorStore.id] } },
    });
    console.log("Asisten berhasil ditautkan.");

    const { count: userAssistantCount } = await supabase.from("assistants").select("*", { count: "exact", head: true }).eq("user_id", userId);

    const { data, error: insertError } = await supabase
      .from("assistants")
      .insert({
        user_id: userId,
        assistant_id: assistant.id,
        name: name,
        description: description,
        instructions: instructions,
        is_default: userAssistantCount === 0,
        vector_store_id: vectorStore.id,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    res.status(201).json({
      message: "Asisten dengan File Search berhasil dibuat dan ditautkan.",
      assistant: data,
    });
  } catch (error) {
    console.error("Terjadi kesalahan dalam proses pembuatan asisten:", error);

    if (assistant) {
      try {
        await client.beta.assistants.del(assistant.id);
        console.log(`Pembersihan: Asisten ${assistant.id} dihapus.`);
      } catch (delError) {
        console.error(`Gagal menghapus asisten ${assistant.id} saat pembersihan:`, delError);
      }
    }
    if (vectorStore) {
      try {
        await client.vectorStores.del(vectorStore.id);
        console.log(`Pembersihan: Vector Store ${vectorStore.id} dihapus.`);
      } catch (delError) {
        console.error(`Gagal menghapus Vector Store ${vectorStore.id} saat pembersihan:`, delError);
      }
    }

    res.status(500).json({
      error: "Gagal membuat asisten.",
      details: error.message,
    });
  }
});

// --- Endpoint untuk Upload File ---
// (Tetap sama seperti sebelumnya)
app.post("/api/v1/assistants/:assistantId/files", upload.array("files"), async (req, res) => {
  try {
    const { assistantId } = req.params;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Setidaknya satu file diperlukan." });
    }

    const { data: assistant, error: dbError } = await supabase.from("assistants").select("vector_store_id").eq("assistant_id", assistantId).single();

    if (dbError || !assistant || !assistant.vector_store_id) {
      return res.status(404).json({ error: "Asisten atau Vector Store terkait tidak ditemukan." });
    }
    const vectorStoreId = assistant.vector_store_id;

    const fileStreams = req.files.map((file) => {
      const readableStream = new Readable();
      readableStream.push(file.buffer);
      readableStream.push(null);
      readableStream.path = file.originalname;
      return readableStream;
    });

    console.log(`Mengunggah ${fileStreams.length} file ke Vector Store ${vectorStoreId}...`);
    const fileBatch = await client.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, { files: fileStreams });

    console.log("Status batch file:", fileBatch.status);
    console.log("Jumlah file:", fileBatch.file_counts);

    res.status(200).json({
      message: `Batch file berhasil diproses untuk Vector Store ${vectorStoreId}.`,
      batch_id: fileBatch.id,
      status: fileBatch.status,
      file_counts: fileBatch.file_counts,
    });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).json({ error: "Gagal meng-upload file.", details: error.message });
  }
});

// --- Endpoint untuk Chat ---

app.post("/api/v1/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: "userId dan message diperlukan." });
    }

    let threadId = null;
    try {
      let { data: user, error: userError } = await supabase.from("users").select("thread_id").eq("id", userId).single();

      if (userError && userError.code !== "PGRST116") {
        console.error("Supabase user query error:", userError);
        throw userError;
      }

      if (user && user.thread_id) {
        threadId = user.thread_id;
      } else {
        const thread = await client.beta.threads.create();
        threadId = thread.id;
        const { error: updateError } = await supabase.from("users").upsert({ id: userId, thread_id: threadId }, { onConflict: "id" });
        if (updateError) {
          console.error("Supabase threadId upsert error:", updateError);
          throw updateError;
        }
      }
    } catch (err) {
      console.error("Error mendapatkan atau membuat thread ID:", err);
      return res.status(500).json({ error: "Gagal mendapatkan atau membuat thread ID.", details: err.message });
    }

    if (!threadId) {
      console.error("Thread ID masih undefined setelah proses akuisisi.");
      return res.status(500).json({ error: "Gagal mendapatkan thread ID yang valid." });
    }

    const finalThreadId = threadId;

    // Cancel any active runs on this thread before proceeding
    try {
      const activeRuns = await client.beta.threads.runs.list(finalThreadId, { limit: 1 });
      if (activeRuns.data.length > 0) {
        const lastRun = activeRuns.data[0];
        if (["queued", "in_progress", "cancelling"].includes(lastRun.status)) {
          console.log(`Cancelling active run ${lastRun.id} for thread ${finalThreadId}`);
          await client.beta.threads.runs.cancel(finalThreadId, lastRun.id);
        }
      }
    } catch (cancelError) {
      console.error(`Error cancelling active runs for thread ${finalThreadId}:`, cancelError);
    }

    const words = message.trim().split(" ");
    const potentialName = words[0].replace(/,$/, "");

    let assistantId;
    let finalMessage = message;

    const { data: namedAssistant, error: namedError } = await supabase.from("assistants").select("assistant_id, vector_store_id").eq("user_id", userId).ilike("name", potentialName).single();

    let assistantToUse;
    if (namedAssistant) {
      assistantToUse = namedAssistant;
      finalMessage = words.slice(1).join(" ");
    } else {
      const { data: defaultAssistant, error: defaultError } = await supabase.from("assistants").select("assistant_id, vector_store_id").eq("user_id", userId).eq("is_default", true).single();
      if (defaultAssistant) {
        assistantToUse = defaultAssistant;
      } else {
        assistantToUse = { assistant_id: GENERAL_PURPOSE_ASSISTANT_ID, vector_store_id: null };
      }
    }

    assistantId = assistantToUse.assistant_id;

    await client.beta.threads.messages.create(finalThreadId, {
      role: "user",
      content: finalMessage,
    });

    let run = await client.beta.threads.runs.create(finalThreadId, {
      assistant_id: assistantId,
    });

    while (["queued", "in_progress", "cancelling"].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const runsList = await client.beta.threads.runs.list(finalThreadId, { limit: 1, order: "desc" });
      if (runsList.data && runsList.data.length > 0 && runsList.data[0].id === run.id) {
        run = runsList.data[0];
      } else {
        console.warn(`Run ${run.id} tidak ditemukan di list teratas, mencoba retrieve langsung.`);
        run = await client.beta.threads.runs.retrieve(finalThreadId, run.id);
      }
    }

    if (run.status === "requires_action") {
      const toolOutputs = [];
      for (const toolCall of run.required_action.submit_tool_outputs.tool_calls) {
        const executor = toolExecutors[toolCall.function.name];
        if (executor) {
          const args = JSON.parse(toolCall.function.arguments);
          const output = await executor(args);
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: String(output),
          });
        }
      }
      run = await client.beta.threads.runs.submitToolOutputs(finalThreadId, run.id, {
        tool_outputs: toolOutputs,
      });
      while (["queued", "in_progress", "cancelling"].includes(run.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const runsList = await client.beta.threads.runs.list(finalThreadId, { limit: 1, order: "desc" });
        if (runsList.data && runsList.data.length > 0 && runsList.data[0].id === run.id) {
          run = runsList.data[0];
        } else {
          console.warn(`Run ${run.id} tidak ditemukan di list teratas setelah submit tool outputs, mencoba retrieve langsung.`);
          run = await client.beta.threads.runs.retrieve(finalThreadId, run.id);
        }
      }
    }

    if (run.status === "completed") {
      const messages = await client.beta.threads.messages.list(finalThreadId);
      const lastMessage = messages.data.find((m) => m.run_id === run.id && m.role === "assistant");

      if (lastMessage && lastMessage.content[0].type === "text") {
        let responseText = lastMessage.content[0].text.value;
        const annotations = lastMessage.content[0].text.annotations;

        for (const annotation of annotations) {
          responseText = responseText.replace(annotation.text, "");
        }

        const formattedResponse = responseText.trim().replace(/\n/g, "<br />");

        res.json({ response: formattedResponse });
      } else {
        res.json({ response: "Saya tidak dapat menemukan jawaban yang sesuai." });
      }
    } else {
      console.error("Run failed with status:", run.status, run.last_error);
      res.status(500).json({ error: "Terjadi kesalahan pada AI.", details: run.last_error });
    }
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
