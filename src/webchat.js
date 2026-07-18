const express = require("express");
const router = express.Router();
const { processMessage } = require("./whatsapp/bot");

// Fixed test identity — all web-chat messages are logged to this user in Sheets.
const WEB_USER_ID = process.env.WEBCHAT_USER_ID || "+972532495154";
const WEB_USER_NAME = process.env.WEBCHAT_USER_NAME || "Web Tester";

// ── Chat API: run a message through the real bot logic ───────────────────────
router.post("/message", async (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.json({ replies: [] });

  // Collector: instead of sending to WhatsApp, gather replies to return.
  const replies = [];
  const collect = async (_to, message) => { replies.push(message); };

  try {
    await processMessage(WEB_USER_ID, text, WEB_USER_NAME, null, collect);
    res.json({ replies });
  } catch (err) {
    console.error("❌ Webchat error:", err.message);
    res.json({ replies: [`⚠️ Error: ${err.message}`] });
  }
});

// ── Chat page ─────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>Manager — צ'אט פיננסי</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #0b141a; color: #e9edef; height: 100vh; display: flex; flex-direction: column; }
    header { background: #202c33; padding: 14px 18px; font-size: 18px; font-weight: 600; border-bottom: 1px solid #2a3942; display: flex; align-items: center; gap: 10px; }
    header .dot { width: 9px; height: 9px; border-radius: 50%; background: #00a884; }
    #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 78%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.4; font-size: 15px; }
    .user { align-self: flex-start; background: #005c4b; }
    .bot { align-self: flex-end; background: #202c33; }
    .meta { font-size: 12px; color: #8696a0; align-self: center; margin: 4px 0; }
    form { display: flex; gap: 8px; padding: 12px; background: #202c33; border-top: 1px solid #2a3942; }
    input { flex: 1; padding: 12px 14px; border-radius: 22px; border: none; background: #2a3942; color: #e9edef; font-size: 15px; }
    input:focus { outline: 1px solid #00a884; }
    button { padding: 0 20px; border-radius: 22px; border: none; background: #00a884; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
  </style>
</head>
<body>
  <header><span class="dot"></span> Manager — עוזר פיננסי (מצב בדיקה)</header>
  <div id="log">
    <div class="meta">הקלד הודעה כמו בוואטסאפ. נסה: <b>help</b> · <b>spent 50 food lunch</b> · <b>report</b></div>
  </div>
  <form id="f">
    <input id="t" placeholder="כתוב הודעה..." autocomplete="off" autofocus>
    <button id="b" type="submit">שלח</button>
  </form>
  <script>
    const log = document.getElementById("log");
    const form = document.getElementById("f");
    const input = document.getElementById("t");
    const btn = document.getElementById("b");

    function add(text, who) {
      const d = document.createElement("div");
      d.className = "msg " + who;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      add(text, "user");
      input.value = "";
      btn.disabled = true;
      try {
        const res = await fetch("/chat/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        (data.replies || []).forEach(r => add(r, "bot"));
        if (!data.replies || !data.replies.length) add("(אין תגובה)", "bot");
      } catch (err) {
        add("⚠️ שגיאת רשת — האם השרת רץ?", "bot");
      }
      btn.disabled = false;
      input.focus();
    });
  </script>
</body>
</html>`);
});

module.exports = router;
