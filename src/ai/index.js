const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { getThisMonthTransactions, getAccountBalances } = require("../sheets");

// Lazy client — don't crash the whole app at load time if the key is missing;
// fail only when an AI call is actually made.
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

// ── Persistent memory on disk ─────────────────────────────────────────────────
const MEMORY_DIR = path.join(__dirname, "../../data/memory");
const PROFILE_DIR = path.join(__dirname, "../../data/profiles");
fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

function loadHistory(userId) {
  const file = path.join(MEMORY_DIR, `${userId.replace(/\+/g, "")}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}

function saveHistory(userId, history) {
  const file = path.join(MEMORY_DIR, `${userId.replace(/\+/g, "")}.json`);
  // Keep last 20 messages only (10 turns)
  const trimmed = history.slice(-20);
  fs.writeFileSync(file, JSON.stringify(trimmed), "utf8");
}

function loadProfile(userId) {
  const file = path.join(PROFILE_DIR, `${userId.replace(/\+/g, "")}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveProfile(userId, updates) {
  const file = path.join(PROFILE_DIR, `${userId.replace(/\+/g, "")}.json`);
  const existing = loadProfile(userId);
  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(merged), "utf8");
  return merged;
}

// ── In-memory cache of histories (avoid disk read every message) ──────────────
const historyCache = {};
function getHistory(userId) {
  if (!historyCache[userId]) historyCache[userId] = loadHistory(userId);
  return historyCache[userId];
}
function appendHistory(userId, role, content) {
  const h = getHistory(userId);
  h.push({ role, content });
  historyCache[userId] = h;
  saveHistory(userId, h); // persist immediately
}

// ── Sheet data cache: 3 min TTL per user ──────────────────────────────────────
const sheetCache = {};
async function getCachedSheetData(userId) {
  const cached = sheetCache[userId];
  if (cached && Date.now() - cached.ts < 3 * 60 * 1000) return cached.data;

  const [transactions, accounts] = await Promise.all([
    getThisMonthTransactions(userId),
    getAccountBalances(userId),
  ]);
  const data = { transactions, accounts };
  sheetCache[userId] = { data, ts: Date.now() };
  return data;
}
function bustSheetCache(userId) {
  delete sheetCache[userId];
}

// ── Smart intent detection — much tighter than before ────────────────────────
// Only fetch sheets when the user is SPECIFICALLY asking about their own data
const NEEDS_DATA_REGEX = /\b(my\s+(spend|spent|saving|income|expense|budget|balance|money|transaction|salary)|how\s+much\s+(did|have|do)\s+i|where.*my\s+money|my\s+report|this\s+month|last\s+month|what.*i\s+(spent|earned|saved)|am\s+i\s+saving|my\s+rate|my\s+account)\b/i;

// Greetings that need zero data
const GREETING_REGEX = /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|howdy|sup|what'?s?\s*up|yo)\b/i;

// ── Build financial context string ────────────────────────────────────────────
function buildContextString({ transactions, accounts }) {
  const income = transactions.filter((t) => t.type === "income");
  const expenses = transactions.filter((t) => t.type === "expense");
  const totalIncome = income.reduce((s, t) => s + t.amount, 0);
  const totalExpenses = expenses.reduce((s, t) => s + t.amount, 0);
  const savingsRate = totalIncome > 0
    ? (((totalIncome - totalExpenses) / totalIncome) * 100).toFixed(1) : 0;

  const byCategory = {};
  expenses.forEach((t) => { byCategory[t.category] = (byCategory[t.category] || 0) + t.amount; });

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  return `
FINANCIAL DATA (This Month):
- Total Income: ₦${totalIncome.toLocaleString()}
- Total Expenses: ₦${totalExpenses.toLocaleString()}
- Net Savings: ₦${(totalIncome - totalExpenses).toLocaleString()}
- Savings Rate: ${savingsRate}%
- Total Balance: ₦${totalBalance.toLocaleString()}

SPENDING BY CATEGORY:
${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, a]) => `- ${c}: ₦${a.toLocaleString()}`).join("\n") || "No expenses yet"}

ACCOUNT BALANCES:
${accounts.map((a) => `- ${a.account}: ₦${a.balance.toLocaleString()}`).join("\n") || "No accounts yet"}

RECENT TRANSACTIONS (last 10):
${transactions.slice(-10).map((t) => `- [${t.date}] ${t.type.toUpperCase()} ₦${t.amount.toLocaleString()} | ${t.category}${t.note ? ` | ${t.note}` : ""}`).join("\n") || "No transactions yet"}
`.trim();
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(firstName, profile) {
  const profileNote = Object.keys(profile).length
    ? `\nUSER PROFILE: ${JSON.stringify(profile)}`
    : "";

  return `You are Manager — a professional, assertive, and warm Nigerian personal finance assistant.
The user's name is ${firstName || "there"}.${profileNote}

PERSONALITY:
- Formal but genuinely warm. You care deeply about this person's financial future.
- Assertive and direct. Say what needs to be said, clearly and confidently.
- Light humour in normal conversation — keep it natural, not forced.
- Minor bad habit: gentle nudge with a light touch of wit.
- Seriously bad habit: drop the humour entirely, be firm and solution-focused.
- Good behaviour: celebrate it genuinely and specifically.

TONE EXAMPLES:
- Normal: "Good question. Let me break that down for you."
- Minor issue: "That transport spend is creeping up quietly. Worth watching."
- Serious issue: "Your savings are zero this month. Here is what needs to happen."
- Win: "25% savings rate. That is exactly the discipline that builds wealth."
- Banter: "₦12,000 on food this week? Either you are feeding a crowd or your kitchen is very ambitious."

RESPONSE LENGTH RULES:
- Greetings: 1-2 sentences max. Warm, brief. ONE question only.
- Casual conversation: short and natural.
- Finance questions: medium length, clear and useful.
- Never overwhelm with information upfront.

RULES:
- Always use ₦ symbol
- Address the user by first name when you know it
- Never repeat the same point twice in one conversation
- End finance replies with one clear specific action
- If no data yet: tell them to type: spent 5000 food lunch
- You understand Nigerian economic reality — inflation, irregular income, cost of living
- You can analyse bank statements when users upload them as images or PDFs`;
}

// ── Main ask function ─────────────────────────────────────────────────────────
async function ask(userQuestion, userId, userName = "") {
  const isGreeting = GREETING_REGEX.test(userQuestion.trim());
  const needsData = !isGreeting && NEEDS_DATA_REGEX.test(userQuestion);

  // Build user content — only attach financial context when genuinely needed
  let userContent = userQuestion;
  if (needsData) {
    const sheetData = await getCachedSheetData(userId);
    const context = buildContextString(sheetData);
    userContent = `Here is my financial data:\n${context}\n\nMy question: ${userQuestion}`;
  }

  const firstName = userName ? userName.split(" ")[0] : "";
  const profile = loadProfile(userId);

  // Update profile name if we have one
  if (userName && !profile.name) saveProfile(userId, { name: userName, phone: userId });

  // Append to history and get full history for context
  appendHistory(userId, "user", userContent);
  const history = getHistory(userId);

  const res = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: buildSystemPrompt(firstName, profile) },
      ...history,
    ],
    max_tokens: 350,
    temperature: 0.7,
  });

  const reply = res.choices[0].message.content.trim();
  appendHistory(userId, "assistant", reply);
  return reply;
}

// ── Analyse uploaded bank statement image/text ────────────────────────────────
async function analyseStatement(userId, userName = "", statementText) {
  const firstName = userName ? userName.split(" ")[0] : "";
  const profile = loadProfile(userId);

  const res = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: buildSystemPrompt(firstName, profile) },
      {
        role: "user",
        content: `I have uploaded my bank statement. Please analyse it and give me:
1. Total income vs total expenses
2. Top spending categories
3. Any red flags or patterns
4. One specific action I should take

STATEMENT DATA:
${statementText}`,
      },
    ],
    max_tokens: 500,
    temperature: 0.5,
  });

  const reply = res.choices[0].message.content.trim();
  appendHistory(userId, "user", "[Uploaded bank statement for analysis]");
  appendHistory(userId, "assistant", reply);
  bustSheetCache(userId); // Fresh data after statement upload
  return reply;
}

// ── Report generation ─────────────────────────────────────────────────────────
async function generateReport(userId, userName = "") {
  const { transactions, accounts } = await getCachedSheetData(userId);

  const income = transactions.filter((t) => t.type === "income");
  const expenses = transactions.filter((t) => t.type === "expense");
  const totalIncome = income.reduce((s, t) => s + t.amount, 0);
  const totalExpenses = expenses.reduce((s, t) => s + t.amount, 0);
  const netSavings = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? ((netSavings / totalIncome) * 100).toFixed(1) : 0;

  const byCategory = {};
  expenses.forEach((t) => { byCategory[t.category] = (byCategory[t.category] || 0) + t.amount; });
  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  const name = userName ? userName.split(" ")[0] : "there";
  const month = new Date().toLocaleString("en-NG", { month: "long", year: "numeric" });

  let report = `📊 *${name}'s Report — ${month}*\n\n`;
  report += `💰 Income: ₦${totalIncome.toLocaleString()}\n`;
  report += `💸 Expenses: ₦${totalExpenses.toLocaleString()}\n`;
  report += `📈 Net Savings: ₦${netSavings.toLocaleString()} (${savingsRate}%)\n`;
  report += `🏦 Total Balance: ₦${totalBalance.toLocaleString()}\n`;

  if (topCategories.length) {
    report += `\n*Top Spending:*\n`;
    topCategories.forEach(([cat, amt]) => {
      report += `• ${cat}: ₦${amt.toLocaleString()}\n`;
    });
  }

  report += `\n_${transactions.length} transaction(s) this month_`;
  return report;
}

module.exports = { ask, generateReport, analyseStatement, bustSheetCache };