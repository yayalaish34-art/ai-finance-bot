// ── Read split config from .env ───────────────────────────────────────────────
function getSplitRules() {
  return {
    Savings:    parseFloat(process.env.SPLIT_SAVINGS)    || 40,
    Investment: parseFloat(process.env.SPLIT_INVESTMENT) || 20,
    Business:   parseFloat(process.env.SPLIT_BUSINESS)   || 20,
    Personal:   parseFloat(process.env.SPLIT_PERSONAL)   || 10,
    Emergency:  parseFloat(process.env.SPLIT_EMERGENCY)  || 10,
  };
}

// ── Calculate how to split an income amount ───────────────────────────────────
function calculateSplit(amount) {
  const rules = getSplitRules();
  const split = {};

  for (const [bucket, percent] of Object.entries(rules)) {
    split[bucket] = {
      percent,
      amount: Math.round((amount * percent) / 100),
    };
  }

  return split;
}

// ── Format the split as a WhatsApp message ────────────────────────────────────
function formatSplitMessage(split) {
  const lines = Object.entries(split)
    .map(([bucket, { percent, amount }]) =>
      `• ${bucket} (${percent}%): ₪${amount.toLocaleString()}`
    )
    .join("\n");

  return `💡 *Suggested Split:*\n${lines}`;
}

module.exports = { calculateSplit, formatSplitMessage, getSplitRules };
