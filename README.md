# HalalTrade Telegram Bot
Daily halal stock signals + real-time alerts sent to your Telegram.

## What it sends
- 📅 **5:00 PM UAE** — Daily briefing: today's 3 halal picks, entry/target/stop, position sizes for $1,000
- ⚡ **Every 5 min (market hours)** — Price alerts when buy zone / target / stop-loss is hit
- 🌙 **12:30 AM UAE** — End of day P&L summary and capital update

## Setup (10 minutes)

### 1. Create your Telegram Bot
1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Name it: `HalalTradeBot`
4. Copy the **API token** it gives you

### 2. Get your Chat ID
1. Message your new bot (send anything)
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Copy the `id` number from `"chat": {"id": XXXXXX}`

### 3. Get free Polygon.io API key
1. Go to **polygon.io** → Sign up free
2. Copy your API key from dashboard

### 4. Run the bot locally
```bash
npm install
cp .env.example .env
# Edit .env with your tokens
node bot.js
```

### 5. Deploy free (runs 24/7)
**Option A — Railway.app (easiest)**
1. Go to railway.app → New Project → Deploy from GitHub
2. Add environment variables: TELEGRAM_TOKEN, CHAT_ID, POLYGON_KEY
3. Deploy → bot runs forever for free

**Option B — Render.com**
1. New Web Service → connect GitHub repo
2. Build: `npm install` | Start: `node bot.js`
3. Add environment variables → Deploy

**Option C — Run on your laptop**
```bash
node bot.js
# Keep terminal open (or use PM2 to run in background)
npm install -g pm2
pm2 start bot.js --name halaltrade
pm2 save
```

## Halal stocks tracked
- AMD, AAPL, GOOGL (active picks)
- NVDA, QCOM (watchlist)
- All Zoya-verified: 0% interest, 0% haram revenue

## Capital configuration
Edit `CAPITAL = 1000` in bot.js to match your actual amount.
Edit `HALAL_STOCKS` targets/stops as prices change weekly.
