const express = require("express");
const router = express.Router();
const multer = require("multer");
const _pdfParseMod = require("pdf-parse");
const PDFParse = _pdfParseMod.PDFParse || (_pdfParseMod.default && _pdfParseMod.default.PDFParse);
console.log('pdf-parse exports:', Object.keys(_pdfParseMod || {}));
const { addTransaction } = require("./sheets");
const { categorizeTransaction } = require("./ai");
const { sendMessage } = require("./whatsapp/bot");

const upload = multer({ storage: multer.memoryStorage() });

// ── Upload page ───────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Finance Bot — Upload Statement</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #f0f4f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: white; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        h1 { color: #1A7A4A; font-size: 24px; margin-bottom: 8px; }
        p { color: #666; font-size: 14px; margin-bottom: 24px; }
        .upload-area { border: 2px dashed #1A7A4A; border-radius: 12px; padding: 32px; text-align: center; cursor: pointer; margin-bottom: 20px; background: #f9fdf9; }
        .upload-area:hover { background: #e8f5ee; }
        .upload-icon { font-size: 48px; margin-bottom: 12px; }
        .upload-text { color: #1A7A4A; font-weight: bold; margin-bottom: 4px; }
        .upload-sub { color: #999; font-size: 13px; }
        input[type=file] { display: none; }
        .btn { background: #1A7A4A; color: white; border: none; border-radius: 10px; padding: 14px 24px; font-size: 16px; width: 100%; cursor: pointer; font-weight: bold; }
        .btn:hover { background: #155f3a; }
        .btn:disabled { background: #aaa; cursor: not-allowed; }
        .result { margin-top: 20px; padding: 16px; border-radius: 10px; font-size: 14px; display: none; }
        .result.success { background: #e8f5ee; color: #1A7A4A; border: 1px solid #1A7A4A; }
        .result.error { background: #fdeaea; color: #c0392b; border: 1px solid #c0392b; }
        .file-name { color: #1A7A4A; font-size: 13px; margin-top: 8px; font-weight: bold; }
        .loading { display: none; text-align: center; margin-top: 16px; color: #666; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>💰 Upload Bank Statement</h1>
        <p>Upload your PDF bank statement. The bot will extract all transactions and save them to your Google Sheet automatically.</p>
        
        <div class="upload-area" onclick="document.getElementById('fileInput').click()">
          <div class="upload-icon">📄</div>
          <div class="upload-text">Click to select PDF</div>
          <div class="upload-sub">Supports Opay, GTBank, Access, Moniepoint</div>
        </div>
        <div class="file-name" id="fileName"></div>
        
        <input type="file" id="fileInput" accept=".pdf" onchange="handleFile(this)">
        
        <button class="btn" id="uploadBtn" onclick="uploadFile()" disabled>
          Upload & Analyse
        </button>
        
        <div class="loading" id="loading">
          ⏳ Reading your statement... this takes about 10 seconds
        </div>
        
        <div class="result" id="result"></div>
      </div>

      <script>
        let selectedFile = null;

        function handleFile(input) {
          selectedFile = input.files[0];
          if (selectedFile) {
            document.getElementById("fileName").textContent = "Selected: " + selectedFile.name;
            document.getElementById("uploadBtn").disabled = false;
          }
        }

        async function uploadFile() {
          if (!selectedFile) return;

          document.getElementById("uploadBtn").disabled = true;
          document.getElementById("loading").style.display = "block";
          document.getElementById("result").style.display = "none";

          const formData = new FormData();
          formData.append("statement", selectedFile);

          try {
            const res = await fetch("/upload/statement", {
              method: "POST",
              body: formData
            });
            const data = await res.json();

            document.getElementById("loading").style.display = "none";
            const resultEl = document.getElementById("result");
            resultEl.style.display = "block";

            if (data.success) {
              resultEl.className = "result success";
              resultEl.innerHTML = "✅ <strong>Done!</strong><br><br>" +
                "📊 Transactions found: <strong>" + data.count + "</strong><br>" +
                "💚 Income: <strong>₦" + data.totalIncome + "</strong><br>" +
                "🔴 Expenses: <strong>₦" + data.totalExpenses + "</strong><br><br>" +
                "Everything saved to your Google Sheet. Check WhatsApp for your summary!";
            } else {
              resultEl.className = "result error";
              resultEl.innerHTML = "❌ " + (data.error || "Something went wrong. Try again.");
            }
          } catch (err) {
            document.getElementById("loading").style.display = "none";
            const resultEl = document.getElementById("result");
            resultEl.style.display = "block";
            resultEl.className = "result error";
            resultEl.innerHTML = "❌ Upload failed. Make sure the bot is running.";
          }

          document.getElementById("uploadBtn").disabled = false;
        }
      </script>
    </body>
    </html>
  `);
});

// ── Process uploaded PDF ──────────────────────────────────────────────────────
router.post("/statement", upload.single("statement"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ success: false, error: "No file uploaded" });
    }

    // Parse PDF using new PDFParse v2 API
    let text = '';
    if (PDFParse) {
      const parser = new PDFParse({ data: req.file.buffer });
      const pdfData = await parser.getText();
      text = pdfData.text;
      await parser.destroy();
    } else {
      // Fallback to old function API if present
      const pdfParse = _pdfParseMod.default || _pdfParseMod;
      const pdfData = await (typeof pdfParse === 'function' ? pdfParse(req.file.buffer) : pdfParse(req.file.buffer));
      text = pdfData.text;
    }

    if (!text || text.trim().length < 50) {
      return res.json({ success: false, error: "Could not read PDF. Make sure it is not a scanned image." });
    }

    // Extract transactions using AI
    const transactions = await extractTransactionsFromText(text);

    if (!transactions || transactions.length === 0) {
      return res.json({ success: false, error: "No transactions found in this statement. The format may not be supported yet." });
    }

    // Save in batches of 5 with delay to avoid Google quota
    let totalIncome = 0;
    let totalExpenses = 0;
    const batchSize = 5;
    for (let i = 0; i < transactions.length; i += batchSize) {
      const batch = transactions.slice(i, i + batchSize);
      await Promise.all(batch.map(t => addTransaction(t)));
      for (const t of batch) {
        if (t.type === "income") totalIncome += t.amount;
        else totalExpenses += t.amount;
      }
      if (i + batchSize < transactions.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Send WhatsApp summary
    const summary =
      `📄 *Bank Statement Uploaded*\n\n` +
      `✅ ${transactions.length} transactions extracted\n` +
      `💚 Income: ₦${totalIncome.toLocaleString()}\n` +
      `🔴 Expenses: ₦${totalExpenses.toLocaleString()}\n` +
      `💰 Net: ₦${(totalIncome - totalExpenses).toLocaleString()}\n\n` +
      `All saved to your Google Sheet. Reply *report* to see your full summary.`;

    await sendMessage(process.env.YOUR_WHATSAPP_NUMBER, summary);

    res.json({
      success: true,
      count: transactions.length,
      totalIncome: totalIncome.toLocaleString(),
      totalExpenses: totalExpenses.toLocaleString(),
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.json({ success: false, error: "Failed to process statement: " + err.message });
  }
});

// ── AI transaction extractor ──────────────────────────────────────────────────
async function extractTransactionsFromText(text) {
  const OpenAI = require("openai");
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing — set it in your environment (Railway → Variables).");
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Split text into chunks of 3000 chars each
  const chunkSize = 3000;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }

  const allTransactions = [];

  for (let i = 0; i < chunks.length; i++) {
    const sample = chunks[i];

    const prompt = `
You are a Nigerian bank statement parser.
Extract ALL transactions from this bank statement text.
For each transaction return a JSON array with this exact format:
[
  {
    "date": "DD/MM/YYYY",
    "type": "income" or "expense",
    "amount": number,
    "category": one of [Food, Transport, Utilities, Business, Investment, Entertainment, Healthcare, Shopping, Subscription, Transfer, Other],
    "source": "description of transaction",
    "account": "bank name if visible"
  }
]

Rules:
- Credits/deposits = income
- Debits/withdrawals = expense
- Amount must be a plain number, no commas or symbols
- If date is unclear use today
- Reply with ONLY the JSON array, no explanation

Bank statement text:
${sample}
`;

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
      });

      const content = (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ? res.choices[0].message.content.trim() : '';
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const valid = parsed.filter(t => t.amount > 0 && (t.type === "income" || t.type === "expense"));
        allTransactions.push(...valid);
        console.log(`✅ Chunk ${i + 1}: found ${valid.length} transactions`);
      }
    } catch (err) {
      console.log(`⚠️ Chunk ${i + 1} failed:`, err.message || err);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // Remove duplicates based on date + amount + type + source
  const seen = new Set();
  const unique = allTransactions.filter(t => {
    const key = `${t.date}-${t.type}-${t.amount}-${t.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`✅ Total unique transactions: ${unique.length}`);
  return unique;
}

module.exports = router;