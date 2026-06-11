const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { addTransaction } = require("../sheets");
const { categorizeTransaction } = require("../ai");
const { sendMessage } = require("../whatsapp/bot");

// ── Verify Paystack webhook signature ────────────────────────────────────────
function verifyPaystack(req, res, next) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  next();
}

// ── Handle Paystack events ────────────────────────────────────────────────────
router.post("/paystack", verifyPaystack, async (req, res) => {
  const event = req.body;
  res.status(200).json({ received: true });

  try {
    if (event.event === "charge.success") {
      const data = event.data;
      const amount = data.amount / 100; // Paystack sends kobo
      const description = data.metadata?.custom_fields?.[0]?.value
        || data.narration
        || "Paystack payment";

      const category = await categorizeTransaction(description);

      const transaction = {
        type: "income",
        amount,
        category,
        account: "Paystack",
        source: data.customer?.email || description,
        date: new Date(data.paid_at).toLocaleDateString("en-NG"),
        notes: description,
      };

      await addTransaction(transaction);

      // Notify via WhatsApp
      await sendMessage(
        process.env.YOUR_WHATSAPP_NUMBER,
        `💚 *Payment Received*\n₦${amount.toLocaleString()} from ${transaction.source}\nCategory: ${category}`
      );
    }

    if (event.event === "transfer.success") {
      const data = event.data;
      const amount = data.amount / 100;

      const transaction = {
        type: "expense",
        amount,
        category: "Transfer",
        account: "Paystack",
        source: data.recipient?.name || "Transfer",
        date: new Date(data.createdAt).toLocaleDateString("en-NG"),
        notes: data.reason || "Bank transfer",
      };

      await addTransaction(transaction);

      await sendMessage(
        process.env.YOUR_WHATSAPP_NUMBER,
        `🔴 *Transfer Sent*\n₦${amount.toLocaleString()} to ${transaction.source}`
      );
    }

  } catch (err) {
    console.error("Paystack webhook error:", err);
  }
});

module.exports = router;
