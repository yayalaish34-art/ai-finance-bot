const { google } = require("googleapis");

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ── In-memory state ───────────────────────────────────────────────────────────
const knownUsers = new Map(); // userId -> name
let usersLoaded = false;

const userCache = {};
const CACHE_DURATION = 5 * 60 * 1000;

function getCache(userId) {
  const c = userCache[userId];
  if (c && Date.now() - c.time < CACHE_DURATION) return c.data;
  return null;
}
function setCache(userId, data) {
  userCache[userId] = { data, time: Date.now() };
}
function clearCache(userId) {
  delete userCache[userId];
}

// ── Load all users into memory on startup ─────────────────────────────────────
async function loadAllUsers() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Users!A:B",
    });
    const rows = res.data.values || [];
    rows.slice(1).forEach((r) => { if (r[0]) knownUsers.set(r[0], r[1] || ""); });
    usersLoaded = true;
    console.log(`✅ Loaded ${knownUsers.size} users into memory`);
  } catch (e) {
    console.error("⚠️ Could not preload users:", e.message);
    usersLoaded = true; // don't block forever
  }
}

// Call this once at startup
loadAllUsers();

// ── Register or update user ───────────────────────────────────────────────────
async function ensureUser(userId, name) {
  // Wait for initial load
  if (!usersLoaded) await new Promise((r) => setTimeout(r, 500));

  // Already known — skip sheets entirely
  if (knownUsers.has(userId)) return { isNew: false, name: knownUsers.get(userId) || name };

  // New user — write to sheet
  const sheets = getSheets();
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Users!A:E",
    valueInputOption: "RAW",
    requestBody: { values: [[userId, name || "", userId, now, now]] },
  });

  knownUsers.set(userId, name || "");
  console.log(`👤 New user: ${name} (${userId})`);
  return { isNew: true, name: name || "" };
}

// ── Write a new transaction row ───────────────────────────────────────────────
async function logTransaction(userId, transaction) {
  const sheets = getSheets();
  const { type, amount, category, note } = transaction;

  const row = [
    userId,
    new Date().toLocaleDateString("en-NG"),
    type,
    amount,
    category,
    note || "",
    new Date().toISOString(),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Transactions!A:G",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  clearCache(userId);
  console.log(`✅ [${userId}] ${type} ₦${amount} (${category})`);
  return row;
}

// ── Read all transactions for a user ─────────────────────────────────────────
async function getAllTransactions(userId) {
  const cached = getCache(userId);
  if (cached) return cached.transactions;

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Transactions!A:G",
  });

  const rows = res.data.values || [];
  const transactions = rows.slice(1)
    .filter((r) => r[0] === userId)
    .map(([, date, type, amount, category, note, timestamp]) => ({
      date, type, amount: parseFloat(amount) || 0, category, note, timestamp,
    }));

  setCache(userId, { transactions });
  return transactions;
}

// ── Read transactions for current month ──────────────────────────────────────
async function getThisMonthTransactions(userId) {
  const all = await getAllTransactions(userId);
  const now = new Date();
  return all.filter((t) => {
    const d = new Date(t.timestamp || t.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
}

// ── Save savings split ────────────────────────────────────────────────────────
async function saveSplit(userId, splitPlan, totalAmount) {
  const sheets = getSheets();
  const date = new Date().toISOString();
  const rows = Object.entries(splitPlan).map(([bucket, amount]) => [
    userId, date, totalAmount, bucket, amount,
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Splits!A:E",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

// ── Get account balances for a user ──────────────────────────────────────────
async function getAccountBalances(userId) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Accounts!A:D",
  });
  const rows = res.data.values || [];
  return rows.slice(1)
    .filter((r) => r[0] === userId)
    .map(([, account, balance]) => ({ account, balance: parseFloat(balance) || 0 }));
}

// ── Find a known user by phone (last-9-digits match) ─────────────────────────
// Used by the Grow webhook to route an incoming payment to the right user.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

async function findUserByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  if (!usersLoaded) await new Promise((r) => setTimeout(r, 500));
  for (const userId of knownUsers.keys()) {
    if (normalizePhone(userId) === target) return userId;
  }
  return null;
}

module.exports = {
  ensureUser,
  logTransaction,
  getAllTransactions,
  getThisMonthTransactions,
  saveSplit,
  getAccountBalances,
  findUserByPhone,
  normalizePhone,
};