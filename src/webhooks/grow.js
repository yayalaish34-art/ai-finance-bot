const express = require("express");
const router = express.Router();
const crypto = require("crypto");

// ── Config: two valid webhook keys (regular + standing order) ────────────────
const KEYS = [
  process.env.GROW_WEBHOOK_KEY,
  process.env.GROW_WEBHOOK_KEY_2,
].filter(Boolean);

// ── Lazy-load heavy modules ───────────────────────────────────────────────────
let sheets, botSend;
function getModules() {
  if (!sheets) sheets = require("../sheets");
  if (!botSend) botSend = require("../whatsapp/bot").sendMessage;
  return { sheets, botSend };
}

// ── Constant-time key comparison ─────────────────────────────────────────────
function keyMatches(candidate) {
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  return KEYS.some((k) => {
    const b = Buffer.from(String(k));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ── First non-null/non-empty of a list of values ─────────────────────────────
function firstOf(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// ── Dedup: processed external_ids (in-memory, 10 min TTL) ────────────────────
const processedEvents = new Set();
function seenBefore(externalId) {
  if (processedEvents.has(externalId)) return true;
  processedEvents.add(externalId);
  setTimeout(() => processedEvents.delete(externalId), 10 * 60 * 1000);
  return false;
}

// ── Diagnostic ring buffer: last 25 hits (incl. rejected) ────────────────────
const recentHits = [];
function recordHit(hit) {
  recentHits.unshift({ at: new Date().toISOString(), ...hit });
  if (recentHits.length > 25) recentHits.pop();
}

// ── Flatten the 3 possible Grow payload shapes into one flat object ──────────
function flatten(rawBody) {
  if (rawBody && typeof rawBody.data === "object" && rawBody.data !== null) {
    return { ...rawBody, ...rawBody.data };
  }
  return rawBody || {};
}

// ── Main webhook ──────────────────────────────────────────────────────────────
router.post("/grow-webhook", async (req, res) => {
  const rawBody = req.body || {};
  const body = flatten(rawBody);

  // ── Auth: read key from first present location ──────────────────────────────
  const key = firstOf(
    body.webhookKey,        // flat success webhook
    body.webhook_key,       // flat recurring-failure webhook
    req.query.key,          // new paymentLinks system (key only in query)
    req.query.webhookKey
  );

  if (!keyMatches(key)) {
    recordHit({ rejected: true, reason: "invalid key", body });
    return res.status(403).json({ error: "Invalid webhook key" });
  }

  // ── Decide event type ───────────────────────────────────────────────────────
  const errorMessage = firstOf(body.error_message);
  const isFailure = !!errorMessage;

  // ── Read logical fields via all aliases ─────────────────────────────────────
  const transactionCode = firstOf(
    body.transactionCode, body.transaction_code, body.transactionId, body.asmachta
  );
  const payerPhone = firstOf(body.payerPhone, body.phone, body.payer_phone);
  const amount = parseFloat(firstOf(body.paymentSum, body.sum,
    body.periodicalPaymentSum, body.firstPaymentSum)) || 0;
  const paymentDate = firstOf(body.paymentDate);

  try {
    if (isFailure) {
      return await handleFailure(req, res, { body, errorMessage, payerPhone, amount });
    }
    return await handleSuccess(req, res, {
      body, transactionCode, payerPhone, amount, paymentDate,
    });
  } catch (err) {
    console.error("❌ Grow webhook error:", err.message);
    recordHit({ error: err.message, body });
    // 500 so Grow retries; dedup makes retries safe
    return res.status(500).json({ error: "internal" });
  }
});

// ── SUCCESS: record income for the matched user ──────────────────────────────
// NOTE: per requirements we IGNORE the lesson/package mapping entirely.
// Any success — regardless of amount or standing-order — is logged as income.
async function handleSuccess(req, res, { body, transactionCode, payerPhone, amount, paymentDate }) {
  const { sheets: sheetsMod } = getModules();

  // Dedup by transactionCode, else hash(phone|amount|date)
  const externalId = transactionCode
    || crypto.createHash("sha256")
      .update(`${payerPhone}|${amount}|${paymentDate}`).digest("hex");

  if (seenBefore(externalId)) {
    recordHit({ duplicate: true, externalId, body });
    return res.status(200).json({ status: 1, duplicate: true });
  }

  // Route to a user by phone
  const userId = await sheetsMod.findUserByPhone(payerPhone);

  if (!userId) {
    console.log(`⚠️ Grow payment ₪${amount} from ${payerPhone} — no matching user`);
    recordHit({ matched: false, reason: "no user for phone", payerPhone, amount, body });
    // Still 200 — nothing to retry; the payment just isn't tied to a WhatsApp user
    return res.status(200).json({ status: 1, matched: false });
  }

  await sheetsMod.logTransaction(userId, {
    type: "income",
    amount,
    category: "Grow",
    note: firstOf(body.paymentDesc, `Grow payment ${transactionCode || ""}`.trim()),
  });

  console.log(`💚 Grow income ₪${amount} → ${userId} (tx ${transactionCode || "n/a"})`);
  recordHit({ matched: true, userId, amount, externalId, body });
  return res.status(200).json({ status: 1, matched: true, incomeLogged: amount });
}

// ── FAILURE: never touch income; alert via WhatsApp ──────────────────────────
async function handleFailure(req, res, { body, errorMessage, payerPhone, amount }) {
  const { sheets: sheetsMod, botSend } = getModules();

  const regularPaymentId = firstOf(body.regular_payment_id);
  const attempt = firstOf(body.charges_attempts);
  const externalId = regularPaymentId
    ? `grow-fail:${regularPaymentId}:${attempt}`
    : "grow-fail:" + crypto.createHash("sha256")
      .update(`fail|${payerPhone}|${amount}|${errorMessage}|${attempt}`).digest("hex");

  if (seenBefore(externalId)) {
    recordHit({ duplicate: true, externalId, body });
    return res.status(200).json({ status: 1, duplicate: true });
  }

  const reason = String(errorMessage).slice(0, 200);
  console.log(`🔴 Grow payment FAILED from ${payerPhone}: ${reason}`);

  // Alert: the matched user if we can find them, else the bot owner
  const userId = await sheetsMod.findUserByPhone(payerPhone);
  const alertTo = userId || process.env.YOUR_WHATSAPP_NUMBER;
  if (alertTo) {
    await botSend(alertTo,
      `🔴 *Payment Failed*\nAmount: ₪${amount.toLocaleString()}\nReason: ${reason}\n\nPlease check your payment method and try again.`
    ).catch((e) => console.error("⚠️ Grow failure alert send error:", e.message));
  }

  recordHit({ matched: !!userId, failed: true, externalId, body });
  return res.status(200).json({ status: 1, matched: !!userId, failed: true });
}

// ── Diagnostic: last 25 hits ─────────────────────────────────────────────────
router.get("/grow-webhook/recent", (req, res) => {
  if (!keyMatches(req.query.key)) {
    return res.status(403).json({ error: "Invalid webhook key" });
  }
  res.json({ count: recentHits.length, hits: recentHits });
});

module.exports = router;
