import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { getUser } from "./hook.js";

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
const user = await getUser("6281122334455");

const character = user.character;

console.log(character);

app.post("/api/v1/create-character", async (req, res) => {
  try {
    const { message } = req.body;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
          this is format character i want to be create, ${message}.
          Create a character definition in JSON format with the following structure:

          {
            "name": "YourAgentName",
            "bio": "A short description of the character, including their purpose and tone.",
            "adjectives": ["list", "of", "3", "adjectives", "describing", "the", "character"],
            "knowledge": ["list of statements that the character knows about themselves or their purpose"],
            "messageExamples": [
              [
                {
                  "name": "User",
                    "content": {"text": "Hello!"}
                },
                {
                  "name": "YourAgentName",
                  "content": {"text": "Friendly greeting response."}
                }
              ]
            ]
          }

          The character should be designed for interacting with users on WhatsApp. Make sure the tone feels natural and personalized. Make the character feel like a smart, reliable, and friendly assistant. You may change the name and behavior based on the use case.

          Output only the JSON.
          `,
        },
      ],
      temperature: 0.7,
    });

    const cleanedResponse = cleanJsonResponse(
      response.choices[0].message.content
    );
    const characterData = JSON.parse(cleanedResponse);

    const { error } = await supabase
      .from("users")
      .insert(["character", characterData])
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

app.post("/api/v1/chat", async (req, res) => {
  try {
    const { message, userId } = req.body;

    // Get user and character data
    const user = await getUser(userId || "6281122334455");
    const characterData = user.character;

    if (!characterData) {
      return res
        .status(400)
        .json({ error: "Character not found for this user" });
    }

    const messages = [
      {
        role: "system",
        content: JSON.stringify(characterData),
      },
      {
        role: "user",
        content: message,
      },
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: messages,
    });

    res.json({ response: response.choices[0].message.content });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is runing on port ${PORT}`);
});
