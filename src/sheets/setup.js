/**
 * Run this once to create all required tabs and headers in your Google Sheet.
 * Creates any missing tabs automatically, then sets the header row on each.
 * Usage: node src/sheets/setup.js
 */

require("dotenv").config({ path: ".env" });
const { google } = require("googleapis");

const TABS = [
  {
    name: "Users",
    headers: ["UserId", "Name", "Phone", "JoinedAt", "LastSeen"],
  },
  {
    name: "Transactions",
    headers: ["UserId", "Date", "Type", "Amount", "Category", "Note", "Timestamp"],
  },
  {
    name: "Accounts",
    headers: ["UserId", "Account", "Balance", "LastUpdated"],
  },
  {
    name: "Splits",
    headers: ["UserId", "Date", "TotalAmount", "Bucket", "BucketAmount"],
  },
];

async function setup() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;

  console.log("🔧 Setting up Google Sheets for multi-user...\n");

  // 1. Find out which tabs already exist
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));

  // 2. Create any missing tabs in a single batch
  const toCreate = TABS.filter((t) => !existing.has(t.name));
  if (toCreate.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: toCreate.map((t) => ({
          addSheet: { properties: { title: t.name } },
        })),
      },
    });
    toCreate.forEach((t) => console.log(`➕ Created tab: ${t.name}`));
  }

  // 3. Write header row on every tab
  for (const tab of TABS) {
    const lastCol = String.fromCharCode(64 + tab.headers.length); // A, B, C...
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab.name}!A1:${lastCol}1`,
      valueInputOption: "RAW",
      requestBody: { values: [tab.headers] },
    });
    console.log(`✅ ${tab.name} sheet headers set`);
  }

  console.log("\n🎉 Setup complete! Your sheet now has 4 tabs: Users, Transactions, Accounts, Splits");
}

setup().catch((e) => {
  console.error("❌ Setup failed:", e.message);
  process.exit(1);
});
