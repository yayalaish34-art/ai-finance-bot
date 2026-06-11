require("dotenv").config();
const express = require("express");
const app = express();

app.use((req, res, next) => { res.setHeader("ngrok-skip-browser-warning", "true"); next(); });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const webhookRoutes = require("./src/webhooks/paystack");
const whatsappRoutes = require("./src/whatsapp/bot");

app.use("/webhooks", webhookRoutes);
app.use("/whatsapp", whatsappRoutes);
app.use("/upload", require("./src/upload"));

app.get("/", (req, res) => {
  res.json({ status: "AI Finance Bot is running ✅" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use. Run this to fix it:`);
    console.error(`   netstat -ano | findstr :${PORT}`);
    console.error(`   taskkill /PID <PID> /F`);
  }
  process.exit(1);
});