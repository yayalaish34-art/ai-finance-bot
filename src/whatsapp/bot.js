const express = require("express");
const router = express.Router();
const axios = require("axios");

const WASENDER_API_KEY = process.env.WASENDER_API_KEY;
const WASENDER_BASE_URL = "https://www.wasenderapi.com/api";

// ── Send message with retry ───────────────────────────────────────────────────
async function sendMessage(to, text, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await axios.post(
        `${WASENDER_BASE_URL}/send-message`,
        { to, text },
        {
          headers: {
            Authorization: `Bearer ${WASENDER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );
      console.log(`✅ Message sent to ${to}`);
      return;
    } catch (err) {
      const isRetryable = ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "socket hang up"].some(
        (e) => err.message?.includes(e) || err.code === e
      );
      if (isRetryable && attempt <= retries) {
        console.log(`⚠️ Retry ${attempt}/${retries}...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      console.error("❌ Send error:", err.response?.data || err.message);
      throw err;
    }
  }
}

// ── Per-user message queue — prevents concurrent conflicts ───────────────────
const userQueues = {};

function enqueue(userId, fn) {
  if (!userQueues[userId]) userQueues[userId] = Promise.resolve();
  userQueues[userId] = userQueues[userId].then(fn).catch((err) => {
    console.error(`❌ Queue error for ${userId}:`, err.message);
  });
}

// ── Lazy-load heavy modules ───────────────────────────────────────────────────
let ai, sheets, rules;
function getModules() {
  if (!ai) ai = require("../ai");
  if (!sheets) sheets = require("../sheets");
  if (!rules) rules = require("../rules");
  return { ai, sheets, rules };
}

// ── Pending savings confirmations per user ────────────────────────────────────
const pendingSplits = {};

// ── Dedup: track processed message IDs ───────────────────────────────────────
const processedIds = new Set();

// ── Download media from WaSender ─────────────────────────────────────────────
async function downloadMedia(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WASENDER_API_KEY}` },
    timeout: 30000,
  });
  return Buffer.from(response.data);
}

// ── Extract text from PDF using pdf-parse (free, no API needed) ──────────────
async function extractTextFromPDF(pdfBuffer) {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(pdfBuffer);
    return data.text || "Could not extract text from PDF.";
  } catch (err) {
    console.error("❌ PDF parse error:", err.message);
    throw new Error("Could not read PDF. Make sure it is a text-based PDF, not a scanned image.");
  }
}

// ── Process an incoming message for one user ──────────────────────────────────
// `send` lets callers redirect the bot's replies. Defaults to WhatsApp (WaSender),
// but the web chat injects its own collector so it can show replies in the browser.
async function processMessage(from, text, userName, msgData, send = sendMessage) {
  const { ai: aiMod, sheets: sheetsMod, rules: rulesMod } = getModules();

  // Register user (fire and forget)
  sheetsMod.ensureUser(from, userName).catch((e) =>
    console.error("⚠️ ensureUser error:", e.message)
  );

  const lower = text.toLowerCase().trim();

  // ── Handle media uploads (bank statements) ──────────────────────────────
  const mediaMsg = msgData?.message;
  const hasImage = mediaMsg?.imageMessage;
  const hasDocument = mediaMsg?.documentMessage;

  if (hasImage || hasDocument) {
    try {
      await send(from, "📄 Got it! Analysing your statement, give me a moment...");

      let extractedText;
      const mediaData = hasImage ? hasImage : hasDocument;
      const mediaUrl = mediaData?.url;

      if (!mediaUrl) {
        return await send(from, "⚠️ Could not access that file. Please try sending it again.");
      }

      if (hasImage) {
        // Images can't be read without a vision API — tell user to send PDF instead
        return await send(
          from,
          "📄 Please send your bank statement as a *PDF file* (not a photo). Most banking apps let you download your statement as PDF.\n\nFor Bank Hapoalim, Leumi, Discount, Mizrahi etc: go to your app → Statements → Download PDF → Send here."
        );
      }

      if (hasDocument) {
        const mimeType = hasDocument.mimetype || "application/pdf";
        if (!mimeType.includes("pdf")) {
          return await send(from, "⚠️ Please send a PDF file. Other file types are not supported yet.");
        }
        const buffer = await downloadMedia(mediaUrl);
        extractedText = await extractTextFromPDF(buffer);
      }

      const analysis = await aiMod.analyseStatement(from, userName, extractedText);
      return await send(from, analysis);
    } catch (err) {
      console.error("❌ Media processing error:", err.message);
      return await send(from, `⚠️ ${err.message || "I had trouble reading that file. Try a different PDF."}`);
    }
  }

  // ── Quick commands ────────────────────────────────────────────────────────
  if (lower === "help" || lower === "menu") {
    return await send(from, helpMenu(userName));
  }

  if (lower === "report") {
    const report = await aiMod.generateReport(from, userName);
    return await send(from, report);
  }

  if (lower === "balances") {
    const balances = await sheetsMod.getAccountBalances(from);
    return await send(from, formatBalances(balances));
  }

  if (lower === "yes" && pendingSplits[from]) {
    const { splitPlan, totalAmount } = pendingSplits[from];
    delete pendingSplits[from];
    await sheetsMod.saveSplit(from, splitPlan, totalAmount);
    return await send(from, "✅ Savings split saved!");
  }

  if (lower === "no" && pendingSplits[from]) {
    delete pendingSplits[from];
    return await send(from, "❌ Split cancelled.");
  }

  // ── Log expense ───────────────────────────────────────────────────────────
  const spentMatch = text.match(/^spent\s+(\d+(?:\.\d+)?)\s+(\w+)(?:\s+(.+))?$/i);
  if (spentMatch) {
    const [, amount, category, note] = spentMatch;
    await sheetsMod.logTransaction(from, {
      type: "expense",
      amount: parseFloat(amount),
      category,
      note: note || "",
    });
    aiMod.bustSheetCache(from);
    return await send(
      from,
      `💸 Logged: ₪${Number(amount).toLocaleString()} on ${category}${note ? ` (${note})` : ""}`
    );
  }

  // ── Log income ────────────────────────────────────────────────────────────
  const receivedMatch = text.match(/^received\s+(\d+(?:\.\d+)?)\s+(\w+)(?:\s+(.+))?$/i);
  if (receivedMatch) {
    const [, amount, category, note] = receivedMatch;
    const amountNum = parseFloat(amount);
    await sheetsMod.logTransaction(from, {
      type: "income",
      amount: amountNum,
      category,
      note: note || "",
    });
    aiMod.bustSheetCache(from);
    const splitPlan = rulesMod.calculateSplit(amountNum);
    pendingSplits[from] = { splitPlan, totalAmount: amountNum };
    return await send(from, formatSplitProposal(amountNum, splitPlan));
  }

  // ── AI Q&A ────────────────────────────────────────────────────────────────
  const answer = await aiMod.ask(text, from, userName);
  return await send(from, answer);
}

// ── Incoming webhook ──────────────────────────────────────────────────────────
router.post("/incoming", async (req, res) => {
  console.log("=================================");
  console.log("WHATSAPP WEBHOOK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=================================");

  // Always respond 200 immediately — never keep WhatsApp waiting
  res.sendStatus(200);

  try {
    const payload = req.body;
    if (payload.event !== "messages.received") return;

    const msg = payload.data?.messages;
    if (!msg) return;
    if (msg.key?.fromMe) return;
    if (msg.message?.reactionMessage) return;

    // Dedup
    const msgId = msg.key?.id;
    if (msgId && processedIds.has(msgId)) {
      console.log(`⚠️ Duplicate ignored: ${msgId}`);
      return;
    }
    if (msgId) {
      processedIds.add(msgId);
      setTimeout(() => processedIds.delete(msgId), 10 * 60 * 1000);
    }

    const from = "+" + msg.key.cleanedSenderPn;
    const text = (msg.messageBody || "").trim();
    const userName = msg.pushName || "";

    // Has media even if no text
    const hasMedia = msg.message?.imageMessage || msg.message?.documentMessage;

    if (!text && !hasMedia) return;
    if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]{1,2}$/u.test(text)) return;

    console.log(`📩 From ${from} (${userName}): ${text || "[media]"}`);

    // Enqueue per user — guarantees no concurrent conflicts per user
    enqueue(from, async () => {
  try {
    await processMessage(from, text, userName, msg);
  } catch (err) {
    console.error(`❌ processMessage error for ${from}:`, err.message, err.stack);
  }
});

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ── Formatters ────────────────────────────────────────────────────────────────
function formatSplitProposal(amount, split) {
  let msg = `💰 *Income Received: ₪${amount.toLocaleString()}*\n\nHere's your savings split:\n\n`;
  for (const [bucket, value] of Object.entries(split)) {
    msg += `• ${bucket}: ₪${value.toLocaleString()}\n`;
  }
  msg += `\nReply *YES* to save or *NO* to cancel.`;
  return msg;
}

function formatBalances(balances) {
  if (!balances || !balances.length) return "No balances found yet.";
  let msg = "💼 *Your Balances:*\n\n";
  for (const b of balances) {
    msg += `• ${b.account}: ₪${Number(b.balance).toLocaleString()}\n`;
  }
  return msg;
}

function helpMenu(name) {
  const greeting = name ? name.split(" ")[0] : "there";
  return `🤖 *Manager — Your Finance Assistant*
Hi ${greeting}! Here's what I can do:

*Log Expenses:*
spent 50 transport gett
spent 250 food shufersal

*Log Income:*
received 8000 salary company
received 2000 business client A

*Upload Bank Statement (PDF only):*
Send a PDF 📄 of your bank statement and I'll analyse it.
Most banking apps: Statements → Download PDF → Send here.

*Ask Anything:*
How much did I spend on food?
Where is my money leaking?
What is my savings rate?

*Quick Commands:*
report   → Monthly summary
balances → Account balances
help     → This menu`;
}
module.exports = router;
module.exports.sendMessage = sendMessage;
module.exports.processMessage = processMessage;