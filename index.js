import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { getUser } from "./hook.js";
import {
  Agent,
  fileSearchTool,
  run,
  tool,
  webSearchTool,
} from "@openai/agents";
import { z } from "zod";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const client = new OpenAI();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Helper function to clean JSON response from markdown formatting
function cleanJsonResponse(response) {
  // Remove markdown code blocks if present
  let cleaned = response.replace(/```json\s*/g, "").replace(/```\s*$/g, "");
  // Remove any leading/trailing whitespace
  cleaned = cleaned.trim();
  return cleaned;
}

// Example of how to use getUser function
const user = await getUser("6282223334444");

console.log(user.character);

app.post("/api/v1/create-character", async (req, res) => {
  try {
    const { message, waNumber } = req.body;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: `
          this is format character i want to be create, ${message}.
          Create a character definition in JSON format with the following structure:

          {
            "owner": "Name"
            "name_agent": "YourAgentName",
            "bio": "A short description of the character, including their purpose and tone.",
            "adjectives": ["list", "of", "3", "adjectives", "describing", "the", "character"],
            "knowledge": ["list of statements that the character knows about themselves or their purpose"],
            "messageExamples": [
              [
                {
                  "name": "user" or "owner",
                  "content": {"text": "Hello!"}
                },
                {
                  "name": "YourAgentName",
                  "content": {"text": "Friendly greeting response."}
                }
              ]
            ],
            "task": ["list", "of", "tasks", "or", "instructions", "for", "the", "character"]
          }

          The character should be designed for interacting with users on WhatsApp. Make sure the tone feels natural and personalized. Make the character feel like a smart, reliable, and friendly assistant. You may change the name and behavior based on the use case. For adjective, knowledge, message examples, and task are not filled with your user who helps to make.
      
          Output only the JSON.
          `,
      temperature: 0.7,
    });

    const cleanedResponse = cleanJsonResponse(response.output_text);
    const characterData = JSON.parse(cleanedResponse);

    const { error } = await supabase
      .from("users")
      .update({ character: characterData })
      .eq("id", waNumber)
      .select();

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Database error" });
    }

    res.json({ response: characterData });
  } catch (error) {
    console.error("Create character error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/v1/update-character", async (req, res) => {
  try {
    const { waNumber, message } = req.body;
    if (!waNumber || !message) {
      return res
        .status(400)
        .json({ error: "waNumber and message are required" });
    }

    // Generate karakter baru dari prompt menggunakan OpenAI (sama seperti create-character)
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: `
          this is format character i want to be update, ${message}.
          Create a character definition in JSON format with the following structure:

          {
            "owner": "Name"
            "name_agent": "YourAgentName",
            "bio": "A short description of the character, including their purpose and tone.",
            "adjectives": ["list", "of", "3", "adjectives", "describing", "the", "character"],
            "knowledge": ["list of statements that the character knows about themselves or their purpose"],
            "messageExamples": [
              [
                {
                 "name": "user" or "owner",
                  "content": {"text": "Hello!"}
                },
                {
                  "name": "YourAgentName",
                  "content": {"text": "Friendly greeting response."}
                }
              ]
            ],
            "task": ["list", "of", "tasks", "or", "instructions", "for", "the", "character"]
          }

          The character should be designed for interacting with users on WhatsApp. Make sure the tone feels natural and personalized. Make the character feel like a smart, reliable, and friendly assistant. You may change the name and behavior based on the use case. For adjective, knowledge, message examples, and task are not filled with your user who helps to make.
      
          Output only the JSON.
          `,
      temperature: 0.7,
    });

    const cleanedResponse = cleanJsonResponse(response.output_text);
    const characterData = JSON.parse(cleanedResponse);

    const { error } = await supabase
      .from("users")
      .update({ character: characterData })
      .eq("id", waNumber)
      .select();

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Database error" });
    }

    res.json({
      success: true,
      message: "Character updated successfully",
      character: characterData,
    });
  } catch (error) {
    console.error("Update character error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const trackWalletTool = tool({
  name: "track_wallet",
  description:
    "Lacak dan tampilkan informasi saldo wallet berdasarkan address dan chain (ethereum, bsc, polygon).",
  parameters: z.object({
    address: z.string(),
    chain: z.string(),
  }),
  async execute({ address, chain }) {
    let apiUrl = "";
    let apiKey = "";
    let label = chain.toLowerCase();
    if (label === "ethereum") {
      apiUrl = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;
      apiKey = process.env.ETHERSCAN_API_KEY;
    } else if (
      label === "bsc" ||
      label === "binance" ||
      label === "binance smart chain"
    ) {
      apiUrl = `https://api.bscscan.com/api?module=account&action=balance&address=${address}&apikey=${process.env.BSCSCAN_API_KEY}`;
      apiKey = process.env.BSCSCAN_API_KEY;
    } else if (label === "polygon" || label === "matic") {
      apiUrl = `https://api.polygonscan.com/api?module=account&action=balance&address=${address}&apikey=${process.env.POLYGONSCAN_API_KEY}`;
      apiKey = process.env.POLYGONSCAN_API_KEY;
    } else {
      return `Maaf, chain '${chain}' belum didukung. Coba gunakan ethereum, bsc, atau polygon.`;
    }
    if (!apiKey) {
      return `API key untuk chain '${chain}' belum diatur. Hubungi admin.`;
    }
    try {
      const resp = await axios.get(apiUrl);
      if (resp.data.status === "1") {
        // Saldo biasanya dalam wei, konversi ke ETH/BNB/MATIC
        const balance = Number(resp.data.result) / 1e18;
        let symbol =
          label === "ethereum" ? "ETH" : label === "bsc" ? "BNB" : "MATIC";
        return `Saldo wallet ${address} di jaringan ${chain}: ${balance} ${symbol}`;
      } else {
        return `Gagal mengambil data wallet: ${
          resp.data.message || "Unknown error"
        }`;
      }
    } catch (err) {
      return `Terjadi error saat mengambil data wallet: ${err.message}`;
    }
  },
});

function createAgentFromCharacter(characterData) {
  if (!characterData.name_agent) {
    throw new Error(
      "Character data must have 'name_agent' field. Please update character."
    );
  }

  // Generate tools dari task
  const dynamicTaskTools = (characterData.task || []).map((task, idx) =>
    tool({
      name: `task_${idx + 1}`,
      description: `Lakukan tugas berikut: ${task}`,
      parameters: z.object({}),
      execute: async () => `Tugas \"${task}\" telah dijalankan.`,
    })
  );

  return new Agent({
    name: characterData.name_agent,
    instructions: `
      ${characterData.bio}
      Adjektif: ${characterData.adjectives.join(", ")}
      Pengetahuan: ${characterData.knowledge.join("; ")}
      Tugas kamu:
      - Selalu merespons sebagai karakter ini, jaga nada, kepribadian, dan pengetahuan sesuai data di atas.
      - Jangan pernah keluar dari karakter.
      - Jangan sebutkan bahwa kamu adalah AI kecuali diminta.
      - Balas secara natural seolah-olah kamu benar-benar ${
        characterData.name_agent
      },
      - Jika ada pertanyaan di luar pengetahuan karakter, jawab dengan cara yang tetap sesuai karakter.
      - Jika user meminta untuk melacak wallet, gunakan tool track_wallet.
      Contoh gaya bicara:
      ${(characterData.messageExamples || [])
        .map(
          (ex, i) =>
            `Contoh ${i + 1}:\n` +
            ex.map((e) => `${e.name_agent}: ${e.content.text}`).join("\n")
        )
        .join("\n\n")}
    `,
    tools: [...dynamicTaskTools, trackWalletTool, webSearchTool()],
  });
}

app.post("/api/v1/chat", async (req, res) => {
  try {
    const { message, userId } = req.body;

    // Get user and character data
    const user = await getUser(userId || "");
    const characterData = user.character;

    if (!characterData) {
      return res
        .status(400)
        .json({ error: "Character not found for this user" });
    }

    // Ambil seluruh riwayat percakapan user
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("role, message")
      .eq("user_id", userId)
      .order("timestamp", { ascending: true });

    if (historyError) {
      console.error("History fetch error:", historyError);
    }

    // Gabungkan riwayat ke dalam satu string
    const chatHistory = (history || [])
      .map(
        (msg) =>
          `${msg.role === "user" ? "User" : "Assistant"}: ${msg.message.text}`
      )
      .join("\n");

    // Gabungkan dengan pesan terbaru
    const fullPrompt = `${chatHistory}${
      chatHistory ? "\n" : ""
    }User: ${message}\nAssistant:`;

    // Buat agent dari karakter user
    const agent = createAgentFromCharacter(characterData);

    // Jalankan agent dengan input berisi seluruh riwayat + pesan terbaru
    const result = await run(agent, fullPrompt);

    // Simpan pesan user & AI ke database
    await supabase.from("messages").insert([
      {
        user_id: userId,
        role: "user",
        message: { text: String(message) },
        timestamp: new Date(),
      },
      {
        user_id: userId,
        role: "assistant",
        message: { text: String(result.finalOutput) },
        timestamp: new Date(),
      },
    ]);

    res.json({ response: result.finalOutput });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is runing on port ${PORT}`);
});
