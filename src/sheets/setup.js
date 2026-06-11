/**
 * Run this once to create all required tabs and headers in your Google Sheet.
 * Usage: node src/sheets/setup.js
 */

require("dotenv").config({ path: ".env" });
const { google } = require("googleapis");

async function setup() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;

  console.log("🔧 Setting up Google Sheets for multi-user...\n");

  const tabs = [
    {
      name: "Users",
      range: "Users!A1:E1",
      headers: ["UserId", "Name", "Phone", "JoinedAt", "LastSeen"],
    },
    {
      name: "Transactions",
      range: "Transactions!A1:G1",
      headers: ["UserId", "Date", "Type", "Amount", "Category", "Note", "Timestamp"],
    },
    {
      name: "Accounts",
      range: "Accounts!A1:D1",
      headers: ["UserId", "Account", "Balance", "LastUpdated"],
    },
    {
      name: "Splits",
      range: "Splits!A1:E1",
      headers: ["UserId", "Date", "TotalAmount", "Bucket", "BucketAmount"],
    },
  ];

  for (const tab of tabs) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: tab.range,
        valueInputOption: "RAW",
        requestBody: { values: [tab.headers] },
      });
      console.log(`✅ ${tab.name} sheet headers set`);
    } catch (e) {
      console.log(`⚠️  ${tab.name}: Make sure this tab exists in your sheet first.`);
      console.log(`   Error: ${e.message}`);
    }
  }

  console.log("\n🎉 Setup complete!");
  console.log("👉 Make sure your Google Sheet has these 4 tabs:");
  console.log("   1. Users");
  console.log("   2. Transactions");
  console.log("   3. Accounts");
  console.log("   4. Splits");
}

setup().catch(console.error);