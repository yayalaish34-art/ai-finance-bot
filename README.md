# AI Finance Bot 💰

A WhatsApp-based personal finance assistant for Nigeria. Log transactions, ask questions about your money, and get automated savings splits — all via WhatsApp.

---

## What It Does

- **Log transactions** by typing on WhatsApp: `spent 5000 transport uber`
- **Auto-capture income** via Paystack webhooks (automatic)
- **AI-powered Q&A**: Ask anything — *"Where is my money leaking?"*
- **Savings split engine**: Income auto-split into buckets (Savings, Investment, etc.)
- **Monthly reports**: Full breakdown on demand
- **Google Sheets storage**: Your permanent financial memory

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo>
cd ai-finance-bot
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
# Open .env and fill in all values
```

### 3. Set Up Google Sheets

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project → Enable **Google Sheets API**
3. Create a **Service Account** → Download the JSON key
4. Copy the `client_email` and `private_key` into your `.env`
5. Create a new Google Sheet with two tabs: **Transactions** and **Accounts**
6. Share the sheet with your service account email (Editor access)
7. Copy the Sheet ID from the URL into your `.env`

Run the setup script:
```bash
node src/sheets/setup.js
```

### 4. Set Up Twilio WhatsApp

1. Sign up at [twilio.com](https://twilio.com)
2. Go to **Messaging → Try it out → Send a WhatsApp message**
3. Follow the sandbox setup instructions
4. Set the incoming webhook URL to: `https://your-domain.com/whatsapp/incoming`
5. Copy your Account SID, Auth Token, and WhatsApp number to `.env`

### 5. Set Up Paystack Webhooks (Optional)

1. Log into your Paystack dashboard
2. Go to **Settings → API Keys & Webhooks**
3. Set webhook URL to: `https://your-domain.com/webhooks/paystack`
4. Copy your Secret Key to `.env`

### 6. Start the Bot

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm start
```

### 7. Expose to Internet (for Testing)

Use [ngrok](https://ngrok.com) to expose your local server:
```bash
npx ngrok http 3000
# Copy the https URL and use it in Twilio + Paystack webhook settings
```

---

## How to Use on WhatsApp

### Log Expenses
```
spent 5000 transport uber
spent 15000 food shoprite groceries
spent 3000 subscription netflix
```

### Log Income
```
received 100000 business client A payment
received 50000 salary company
```

### Ask Questions
```
How much did I spend on food this month?
What is my savings rate?
Where is my money leaking?
Which category do I spend most on?
Am I saving enough?
```

### Quick Commands
```
report     → Full monthly summary
balances   → All account balances
help       → Show menu
```

---

## Savings Split Rules

Edit in `.env`:
```
SPLIT_SAVINGS=40
SPLIT_INVESTMENT=20
SPLIT_BUSINESS=20
SPLIT_PERSONAL=10
SPLIT_EMERGENCY=10
```

When income is received, the bot calculates and shows the split. Reply **YES** to approve.

---

## Project Structure

```
ai-finance-bot/
├── index.js                  # App entry point
├── .env.example              # Environment variable template
├── src/
│   ├── webhooks/
│   │   └── paystack.js       # Handles Paystack payment events
│   ├── sheets/
│   │   ├── index.js          # Read/write Google Sheets
│   │   └── setup.js          # One-time sheet setup script
│   ├── ai/
│   │   └── index.js          # AI categorization + Q&A + reports
│   ├── whatsapp/
│   │   └── bot.js            # WhatsApp message handler
│   └── rules/
│       └── index.js          # Savings split calculator
```

---

## Deployment (Production)

### Option A: Railway (Easiest)
1. Push code to GitHub
2. Connect repo to [railway.app](https://railway.app)
3. Add all environment variables
4. Deploy — Railway gives you a live URL

### Option B: Render
Same as Railway — free tier available at [render.com](https://render.com)

### Option C: VPS (DigitalOcean / Hetzner)
```bash
# On your server
git clone <repo>
npm install
npm install -g pm2
pm2 start index.js --name finance-bot
pm2 save
```

---

## Roadmap

- [ ] Mono/Okra integration for live bank balance reading
- [ ] Automatic Paystack transfers for savings splits
- [ ] Weekly trend analysis reports
- [ ] Spending anomaly alerts
- [ ] Budget goal tracking
- [ ] Multi-currency support
