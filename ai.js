// Nexus AI proxy using Google Gemini (Vercel serverless function, Node 18+).
// Env vars in Vercel: GEMINI_API_KEY (required), ALLOWED_ORIGINS (required, comma list)
// Optional: GEMINI_MODEL, GEMINI_MODEL_QUICK (model IDs from https://aistudio.google.com)
// The API key lives ONLY on the server, never in the browser.
const hits = new Map(); // per-IP counters, in memory only (resets on restart)
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 15;
const MODELS = {
  quick: process.env.GEMINI_MODEL_QUICK || "gemini-2.5-flash-lite",
  default: process.env.GEMINI_MODEL || "gemini-2.5-flash"
};
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (!ALLOWED.length || !ALLOWED.includes(origin)) return res.status(403).json({ error: "forbidden" });
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "not_configured" });

  const ip = (req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  const now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (h.length >= MAX_HITS) return res.status(429).json({ error: "rate_limited" });
  h.push(now); hits.set(ip, h);

  const { messages, tier } = req.body || {};
  const ok = Array.isArray(messages) && messages.length > 0 && messages.length <= 6 &&
    messages.every(m => m && (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" && m.content.length <= 8000);
  if (!ok || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "bad_request" });

  const model = MODELS[tier] || MODELS.default;
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 2048 }
        })
      }
    );
    if (r.status === 429) return res.status(429).json({ error: "rate_limited" });
    if (!r.ok) return res.status(502).json({ error: "upstream" });
    const d = await r.json();
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || "").join("").trim();
    return res.status(200).json({ text: text || "Sorry, I couldn't produce an answer for that. Try rephrasing." });
  } catch (e) {
    return res.status(500).json({ error: "server" });
  }
};
