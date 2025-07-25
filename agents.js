import { z } from "zod";
import { Agent, run, tool } from "@openai/agents";
import dotenv from "dotenv";

dotenv.config();

// --- Sub-Agent: MarketMaven Agent ---
const marketMavenAgent = new Agent({
  name: "MarketMaven_Agent",
  instructions: [
    "Anda adalah MarketMaven Agent, spesialis analisis dan strategi pemasaran digital.",
    "Tugas Anda: memantau tren, menganalisis audiens, mengoptimalkan kampanye, dan membuat laporan performa pemasaran.",
    "Selalu berikan insight yang actionable dan berbasis data.",
  ].join(" "),
});

// --- Sub-Agent: ContentCrafter Agent ---
const contentCrafterAgent = new Agent({
  name: "ContentCrafter_Agent",
  instructions: [
    "Anda adalah ContentCrafter Agent, ahli manajemen dan pembuatan konten media sosial.",
    "Tugas Anda: membuat ide konten, caption, hashtag, menjadwalkan postingan, mengadaptasi konten untuk tiap platform, dan memantau brand mention.",
    "Pastikan konten selalu relevan, menarik, dan sesuai persona brand.",
  ].join(" "),
});

// --- Sub-Agent: CareConnect Agent ---
const careConnectAgent = new Agent({
  name: "CareConnect_Agent",
  instructions: [
    "Anda adalah CareConnect Agent, spesialis layanan pelanggan dan interaksi digital.",
    "Tugas Anda: memberikan respons otomatis, personalisasi interaksi, menangani keluhan awal, dan mengumpulkan feedback pelanggan.",
    "Fokus pada respons cepat, akurat, dan menjaga kepuasan pelanggan.",
  ].join(" "),
});

// --- PersonaPro AI Orchestrator ---
const personaProAIOrchestrator = new Agent({
  name: "PersonaPro_AI",
  instructions: [
    "Anda adalah PersonaPro AI, AI Agent multifungsi untuk media sosial, pemasaran, dan layanan pelanggan.",
    "Tugas utama Anda adalah menerima permintaan, memahami kebutuhan, dan mengarahkan tugas ke sub-agent yang tepat:",
    "- Untuk pertanyaan/masalah layanan pelanggan, arahkan ke CareConnect Agent.",
    "- Untuk pembuatan/manajemen konten, arahkan ke ContentCrafter Agent.",
    "- Untuk analisis atau laporan pemasaran, arahkan ke MarketMaven Agent.",
    "Jangan selesaikan tugas sendiri, selalu delegasikan ke sub-agent yang relevan.",
    "Pastikan solusi yang diberikan konsisten dengan persona brand dan efisien.",
  ].join(" "),
  tools: [
    marketMavenAgent.asTool({
      toolName: "analyze_and_report_marketing",
      toolDescription:
        "Analisis tren, audiens, optimasi kampanye, dan pembuatan laporan performa pemasaran.",
    }),
    contentCrafterAgent.asTool({
      toolName: "manage_and_create_content",
      toolDescription:
        "Pembuatan ide konten, caption, hashtag, penjadwalan postingan, adaptasi konten, dan pemantauan brand mention.",
    }),
    careConnectAgent.asTool({
      toolName: "customer_service_and_interaction",
      toolDescription:
        "Respons otomatis, personalisasi interaksi, penanganan keluhan awal, dan pengumpulan feedback pelanggan.",
    }),
  ],
});

// // --- Contoh Penggunaan PersonaPro AI ---
// async function main() {
//   console.log("--- Pengujian PersonaPro AI ---");

//   // Skenario 1: Permintaan analisis pemasaran
//   let result1 = await run(
//     personaProAIOrchestrator,
//     "Tolong analisis performa kampanye Instagram bulan ini dan berikan insight untuk optimasi selanjutnya."
//   );
//   console.log(
//     "\nPesan Pengguna: Tolong analisis performa kampanye Instagram bulan ini dan berikan insight untuk optimasi selanjutnya."
//   );
//   console.log("PersonaPro AI Merespons:");
//   console.log(result1.finalOutput);

//   // Skenario 2: Permintaan pembuatan konten
//   let result2 = await run(
//     personaProAIOrchestrator,
//     "Buatkan ide konten dan caption untuk promosi produk baru di Twitter dan Instagram."
//   );
//   console.log(
//     "\nPesan Pengguna: Buatkan ide konten dan caption untuk promosi produk baru di Twitter dan Instagram."
//   );
//   console.log("PersonaPro AI Merespons:");
//   console.log(result2.finalOutput);

//   // Skenario 3: Pertanyaan layanan pelanggan
//   let result3 = await run(
//     personaProAIOrchestrator,
//     "Pelanggan menanyakan status pengiriman pesanan melalui DM Instagram, bagaimana respon yang tepat?"
//   );
//   console.log(
//     "\nPesan Pengguna: Pelanggan menanyakan status pengiriman pesanan melalui DM Instagram, bagaimana respon yang tepat?"
//   );
//   console.log("PersonaPro AI Merespons:");
//   console.log(result3.finalOutput);
// }

// main().catch(console.error); // Dihapus agar tidak menjalankan pengujian otomatis
export { personaProAIOrchestrator };
