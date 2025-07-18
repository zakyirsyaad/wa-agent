import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import supabase from "./db.js"; // Menggunakan koneksi Supabase dari db.js
import { z } from "zod";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const client = new OpenAI();

// ID Asisten General Purpose (Default)
// Anda harus membuat satu asisten di dashboard OpenAI sebagai fallback.
const GENERAL_PURPOSE_ASSISTANT_ID = process.env.GENERAL_PURPOSE_ASSISTANT_ID;

// --- Definisi Tools ---
// Tools ini akan kita referensikan saat membuat asisten

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
// Objek untuk memetakan nama tool ke fungsi eksekusinya
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

// --- Endpoint untuk Manajemen Asisten ---

app.post("/api/v1/assistants", async (req, res) => {
  try {
    const { userId, name, instructions, description } = req.body;
    if (!userId || !name || !instructions) {
      return res.status(400).json({ error: "userId, name, dan instructions diperlukan." });
    }

    // Membuat asisten di OpenAI
    const assistant = await client.beta.assistants.create({
      name: name,
      instructions: instructions,
      tools: [trackWalletTool, { type: "code_interpreter" }, { type: "file_search" }], // Updated from 'retrieval' to 'file_search'
      model: "gpt-4o-mini",
    });

    // Cek apakah user sudah punya asisten lain, jika tidak, jadikan ini default
    const { data: userAssistants, error: countError } = await supabase.from("assistants").select("id", { count: "exact" }).eq("user_id", userId);

    if (countError) throw countError;

    // Simpan asisten ke database
    const { data, error } = await supabase
      .from("assistants")
      .insert({
        user_id: userId,
        assistant_id: assistant.id,
        name: name,
        description: description,
        instructions: instructions,
        is_default: userAssistants.length === 0, // Jadi default jika ini yg pertama
      })
      .select();

    if (error) throw error;

    res.status(201).json({ message: "Asisten berhasil dibuat.", assistant: data[0] });
  } catch (error) {
    console.error("Error creating assistant:", error);
    res.status(500).json({ error: "Gagal membuat asisten." });
  }
});

// --- Endpoint untuk Chat ---

app.post("/api/v1/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: "userId dan message diperlukan." });
    }

    // 1. Dapatkan atau Buat Thread ID untuk User
    let { data: user, error: userError } = await supabase.from("users").select("thread_id").eq("id", userId).single();

    if (userError && userError.code !== "PGRST116") throw userError; // Abaikan error jika user not found

    let threadId;
    if (user && user.thread_id) {
      threadId = user.thread_id;
    } else {
      const thread = await client.beta.threads.create();
      threadId = thread.id;
      // Simpan threadId ke user
      const { error: updateError } = await supabase.from("users").upsert({ id: userId, thread_id: threadId }, { onConflict: "id" });
      if (updateError) throw updateError;
    }

    console.log("Thread ID:", threadId); // Debug log

    // Validate threadId before proceeding
    if (!threadId) {
      console.error("Thread ID is undefined or null");
      return res.status(500).json({ error: "Failed to create or retrieve thread ID" });
    }

    // Store threadId in a const to prevent accidental reassignment
    const finalThreadId = threadId;

    // 2. Pilih Asisten yang Akan Digunakan
    const words = message.trim().split(" ");
    const potentialName = words[0].replace(/,$/, ""); // Hapus koma jika ada (misal: "Fina,")

    let assistantId;
    let finalMessage = message;

    const { data: namedAssistant, error: namedError } = await supabase
      .from("assistants")
      .select("assistant_id")
      .eq("user_id", userId)
      .ilike("name", potentialName) // Case-insensitive search
      .single();

    if (namedAssistant) {
      assistantId = namedAssistant.assistant_id;
      finalMessage = words.slice(1).join(" "); // Hapus nama dari pesan
    } else {
      const { data: defaultAssistant, error: defaultError } = await supabase.from("assistants").select("assistant_id").eq("user_id", userId).eq("is_default", true).single();

      if (defaultAssistant) {
        assistantId = defaultAssistant.assistant_id;
      } else {
        assistantId = GENERAL_PURPOSE_ASSISTANT_ID;
      }
    }

    console.log("Assistant ID:", assistantId); // Debug log

    // Validate assistantId before proceeding
    if (!assistantId) {
      console.error("Assistant ID is undefined or null");
      return res.status(500).json({ error: "Failed to retrieve assistant ID" });
    }

    // 3. Jalankan Siklus Chat
    await client.beta.threads.messages.create(finalThreadId, {
      role: "user",
      content: finalMessage,
    });

    let run = await client.beta.threads.runs.create(finalThreadId, {
      assistant_id: assistantId,
    });

    console.log("Run ID:", run.id); // Debug log

    // Polling untuk status run
    while (["queued", "in_progress", "cancelling"].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Tunggu 1 detik
      console.log("About to retrieve run with threadId:", finalThreadId, "runId:", run.id);

      // Use list method instead of retrieve to avoid SDK bug
      const runs = await client.beta.threads.runs.list(finalThreadId, { limit: 1 });
      if (runs.data && runs.data.length > 0) {
        run = runs.data[0];
        console.log("Run status:", run.status); // Debug log
      } else {
        console.error("No runs found for thread");
        break;
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
      // Polling lagi setelah submit tool output
      while (["queued", "in_progress", "cancelling"].includes(run.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log("About to retrieve run after tool output with threadId:", finalThreadId, "runId:", run.id);

        // Use list method instead of retrieve to avoid SDK bug
        const runs = await client.beta.threads.runs.list(finalThreadId, { limit: 1 });
        if (runs.data && runs.data.length > 0) {
          run = runs.data[0];
          console.log("Run status after tool output:", run.status); // Debug log
        } else {
          console.error("No runs found for thread after tool output");
          break;
        }
      }
    }

    if (run.status === "completed") {
      const messages = await client.beta.threads.messages.list(finalThreadId);
      const lastMessage = messages.data.find((m) => m.run_id === run.id && m.role === "assistant");

      if (lastMessage && lastMessage.content[0].type === "text") {
        res.json({ response: lastMessage.content[0].text.value });
      } else {
        res.json({ response: "Saya tidak dapat menemukan jawaban yang sesuai." });
      }
    } else {
      console.error("Run failed with status:", run.status);
      if (run.last_error) {
        console.error("Run error details:", run.last_error);
      }
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
