const cron = require("node-cron");
const OpenAI = require("openai");
const { getThisMonthTransactions, getAllTransactions } = require("./sheets");
const { getSplitRules } = require("./rules");

let _openai;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is missing — set it in your environment (Railway → Variables).");
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}
const fmt = (n) => "₦" + Math.abs(n).toLocaleString();

async function analyseSpending() {
  const transactions = await getThisMonthTransactions();
  const rules = getSplitRules();
  const totalIncome = transactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const spentByCategory = {};
  transactions.filter((t) => t.type === "expense").forEach((t) => {
    const key = t.category?.toUpperCase() || "OTHER";
    spentByCategory[key] = (spentByCategory[key] || 0) + t.amount;
  });
  const totalExpenses = Object.values(spentByCategory).reduce((s, v) => s + v, 0);
  const netSavings = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? ((netSavings / totalIncome) * 100).toFixed(1) : 0;
  const bucketAnalysis = rules.map((rule) => {
    const budgeted = Math.round((totalIncome * rule.percent) / 100);
    const spent = spentByCategory[rule.key] || 0;
    const remaining = budgeted - spent;
    const overspent = spent > budgeted;
    const pctUsed = budgeted > 0 ? ((spent / budgeted) * 100).toFixed(0) : 0;
    return { ...rule, budgeted, spent, remaining, overspent, pctUsed: parseFloat(pctUsed) };
  });
  return {
    totalIncome, totalExpenses, netSavings, savingsRate,
    bucketAnalysis,
    overspentBuckets: bucketAnalysis.filter((b) => b.overspent),
    transactions,
  };
}

async function detectHabits() {
  const transactions = await getAllTransactions();
  if (transactions.length < 3) return null;
  const expenses = transactions.filter((t) => t.type === "expense");
  const categoryCount = {};
  expenses.forEach((t) => { categoryCount[t.category] = (categoryCount[t.category] || 0) + 1; });
  const topCategory = Object.entries(categoryCount).sort((a, b) => b[1] - a[1])[0];
  const weekendSpend = expenses.filter((t) => { const d = new Date(t.timestamp || t.date); return d.getDay() === 0 || d.getDay() === 6; }).reduce((s, t) => s + t.amount, 0);
  const weekdaySpend = expenses.filter((t) => { const d = new Date(t.timestamp || t.date); return d.getDay() > 0 && d.getDay() < 6; }).reduce((s, t) => s + t.amount, 0);
  const totalIncome = transactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = expenses.reduce((s, t) => s + t.amount, 0);
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome * 100).toFixed(1) : 0;
  return {
    topCategory: topCategory?.[0], topCategoryCount: topCategory?.[1],
    weekendSpend, weekdaySpend, weekendHigher: weekendSpend > weekdaySpend,
    savingsRate: parseFloat(savingsRate), totalIncome, totalExpense,
  };
}

async function getHabitInsight(habits, analysis) {
  if (!habits) return null;
  const prompt = `You are a Nigerian financial coach offering these products:
1. Financial Coaching Session
2. Savings Challenge Program (90-day plan)
3. Investment Starter Plan (Nigeria)
4. Budget Mastery Course

User data:
- Savings rate: ${habits.savingsRate}%
- Top spending: ${habits.topCategory} (${habits.topCategoryCount} times)
- Weekend spending: ₦${habits.weekendSpend.toLocaleString()} vs weekday: ₦${habits.weekdaySpend.toLocaleString()}
- Overspent categories: ${analysis.overspentBuckets.map(b => b.label).join(", ") || "none"}

Give ONE honest observation and naturally suggest ONE product that fits.
Format exactly:
INSIGHT: [observation]
SUGGESTION: [product suggestion]`;

  const res = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 200,
  });
  return res.choices[0].message.content.trim();
}

async function buildWeeklyReport() {
  const analysis = await analyseSpending();
  const habits = await detectHabits();
  const aiInsight = await getHabitInsight(habits, analysis);

  let msg = `📊 *Your Weekly Financial Report*\n\n`;
  msg += `💚 Income: ${fmt(analysis.totalIncome)}\n`;
  msg += `🔴 Spent: ${fmt(analysis.totalExpenses)}\n`;
  msg += `💰 Saved: ${fmt(analysis.netSavings)} (${analysis.savingsRate}%)\n\n`;
  msg += `*Budget vs Actual:*\n`;
  analysis.bucketAnalysis.filter((b) => b.budgeted > 0).forEach((b) => {
    const icon = b.overspent ? "🔴" : b.pctUsed > 80 ? "🟡" : "🟢";
    msg += `${icon} ${b.emoji} ${b.label}: ${fmt(b.spent)} of ${fmt(b.budgeted)}\n`;
  });
  if (analysis.overspentBuckets.length > 0) {
    msg += `\n⚠️ *Overspent:*\n`;
    analysis.overspentBuckets.forEach((b) => {
      msg += `• ${b.label}: over by ${fmt(b.spent - b.budgeted)}\n`;
    });
  }
  const totalRemaining = analysis.bucketAnalysis.reduce((s, b) => s + Math.max(0, b.remaining), 0);
  msg += `\n💳 *Remaining: ${fmt(totalRemaining)}*\n`;
  if (aiInsight) {
    const parts = aiInsight.split("SUGGESTION:");
    const insight = parts[0].replace("INSIGHT:", "").trim();
    const suggestion = parts[1]?.trim();
    msg += `\n💡 *Insight:*\n${insight}\n`;
    if (suggestion) msg += `\n🎯 *For you:*\n${suggestion}\n`;
  }
  msg += `\nReply *status*, *left*, or *insight* for more.`;
  return msg;
}

async function buildStatusMessage() {
  const analysis = await analyseSpending();
  let msg = `📈 *Today's Money Status*\n\n`;
  msg += `💚 Income: ${fmt(analysis.totalIncome)}\n`;
  msg += `🔴 Spent: ${fmt(analysis.totalExpenses)}\n`;
  msg += `💰 Saved: ${fmt(analysis.netSavings)}\n\n`;
  if (analysis.overspentBuckets.length > 0) {
    msg += `⚠️ *Over budget:*\n`;
    analysis.overspentBuckets.forEach((b) => {
      msg += `• ${b.label}: over by ${fmt(b.spent - b.budgeted)}\n`;
    });
  } else {
    msg += `✅ All categories within budget. Keep it up!\n`;
  }
  return msg;
}

async function buildRemainingMessage() {
  const analysis = await analyseSpending();
  let msg = `💳 *Budget Remaining This Month*\n\n`;
  analysis.bucketAnalysis.filter((b) => b.budgeted > 0).forEach((b) => {
    if (b.overspent) {
      msg += `🔴 ${b.emoji} ${b.label}: OVER by ${fmt(b.spent - b.budgeted)}\n`;
    } else {
      msg += `🟢 ${b.emoji} ${b.label}: ${fmt(b.remaining)} left\n`;
    }
  });
  return msg;
}

async function buildInsightMessage() {
  const analysis = await analyseSpending();
  const habits = await detectHabits();
  if (!habits || analysis.transactions.length < 3) {
    return "You need at least 3 transactions before I can analyse your habits. Keep logging!";
  }
  const aiInsight = await getHabitInsight(habits, analysis);
  if (!aiInsight) return "Not enough data yet. Keep logging for a week.";
  const parts = aiInsight.split("SUGGESTION:");
  const insight = parts[0].replace("INSIGHT:", "").trim();
  const suggestion = parts[1]?.trim();
  let msg = `🧠 *Your Money Habit Analysis*\n\n${insight}\n\n`;
  if (habits.weekendHigher) msg += `📅 Weekend spending (${fmt(habits.weekendSpend)}) is higher than weekdays (${fmt(habits.weekdaySpend)}). Watch your weekends.\n\n`;
  if (habits.savingsRate < 20) msg += `📉 Savings rate is ${habits.savingsRate}% — below the 20% minimum.\n\n`;
  if (suggestion) msg += `🎯 *What could help:*\n${suggestion}`;
  return msg;
}

function startWeeklyReport(sendMessageFn, userNumber) {
  cron.schedule("0 8 * * 1", async () => {
    try {
      const report = await buildWeeklyReport();
      await sendMessageFn(userNumber, report);
      console.log("✅ Weekly report sent");
    } catch (err) {
      console.error("Weekly report error:", err.message);
    }
  }, { timezone: "Africa/Lagos" });
  console.log("✅ Weekly report scheduled — every Monday 8am");
}

module.exports = {
  buildWeeklyReport, buildStatusMessage,
  buildRemainingMessage, buildInsightMessage,
  startWeeklyReport,
};