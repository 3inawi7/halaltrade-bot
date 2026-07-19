// ============================================================
// HalalTrade Telegram Bot — v2 DYNAMIC DAILY RECOMMENDATIONS
// Picks are recalculated fresh every day from live price/RSI data
// — no more fixed/hardcoded targets
// Run: node bot.js
// Deploy free: Railway.app
// ============================================================

require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHAT_ID        = process.env.CHAT_ID        || 'YOUR_CHAT_ID_HERE';
const POLYGON_KEY    = process.env.POLYGON_KEY    || 'YOUR_POLYGON_KEY';
const CAPITAL        = parseFloat(process.env.CAPITAL) || 1000;

if (TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE' || CHAT_ID === 'YOUR_CHAT_ID_HERE' || POLYGON_KEY === 'YOUR_POLYGON_KEY') {
  console.error('Missing keys! Check your .env file has real values for TELEGRAM_TOKEN, CHAT_ID, POLYGON_KEY.');
  process.exit(1);
}

// Halal universe - Zoya zero-tolerance verified
// No price targets here anymore - those are calculated fresh daily.
const HALAL_UNIVERSE = [
  { ticker: 'AMD',   name: 'Advanced Micro Devices' },
  { ticker: 'AAPL',  name: 'Apple Inc.' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.' },
  { ticker: 'NVDA',  name: 'NVIDIA Corp.' },
  { ticker: 'QCOM',  name: 'Qualcomm Inc.' },
  { ticker: 'AVGO',  name: 'Broadcom Inc.' },
];

const MAX_DAILY_PICKS = 3;
let todaysPicks = [];
const alertsSentToday = new Set();

// ── Paper trading log ───────────────────────────────────────
// Records every pick made so we can check 3 trading days later
// whether the target/stop would actually have hit. No real money.
const fs = require('fs');
const path = require('path');
const LOG_FILE = path.join(__dirname, 'data', 'paper_trades.json');

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch (e) { console.error('loadLog error:', e.message); }
  return [];
}

function saveLog(log) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) { console.error('saveLog error:', e.message); }
}

function logPicks(picks) {
  const log = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  picks.forEach(p => {
    log.push({
      date: today,
      ticker: p.ticker,
      entryPrice: p.price,
      entryLow: p.entryLow,
      entryHigh: p.entryHigh,
      target: p.target,
      stop: p.stop,
      rsi: p.rsi,
      closed: false,
      result: null
    });
  });
  saveLog(log);
}

// Checks ALL still-open paper trades against current price.
// Used both for the daily status update and the Friday closing report.
async function evaluateOpenTrades() {
  const log = loadLog();
  const open = log.filter(t => !t.closed);
  const results = [];

  for (const trade of open) {
    const day = await getPrevDay(trade.ticker);
    const intraday = await getIntradayRange(trade.ticker);
    if (!day) continue;

    const currentPrice = day.price;
    const intradayHigh = intraday?.high || currentPrice;
    const intradayLow  = intraday?.low  || currentPrice;

    // Use intraday low to detect stop hits — a stop can be breached
    // intraday even if the stock closes above it by end of day.
    // Use intraday high to detect target hits similarly.
    let outcome = 'OPEN ⏳';
    if (intradayLow  <= trade.stop)   outcome = 'STOP HIT 🛑';
    if (intradayHigh >= trade.target) outcome = 'TARGET HIT ✅';
    // If both hit in same day, stop takes priority (conservative)
    if (intradayLow <= trade.stop && intradayHigh >= trade.target) outcome = 'STOP HIT 🛑';

    const pctMove = (((currentPrice - trade.entryPrice) / trade.entryPrice) * 100);

    results.push({ trade, currentPrice, outcome, pctMove });

    // Auto-close trades that hit target or stop so they don't get re-reported forever
    if (outcome !== 'OPEN ⏳') {
      trade.closed = true;
      trade.result = outcome;
      trade.closedPrice = currentPrice;
      trade.closedPct = pctMove;
      trade.closedDate = new Date().toISOString().slice(0, 10);
    }

    await new Promise(r => setTimeout(r, 4000)); // rate limit safety
  }

  saveLog(log);
  return results;
}

// Daily status update — sent every trading day, shows all open paper positions
async function sendDailyPaperStatus() {
  const results = await evaluateOpenTrades();
  if (results.length === 0) return; // nothing open, skip silently

  const lines = [`📋 <b>Paper Trade Status</b> — ${new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' })}`, ``];

  results.forEach(r => {
    lines.push(`<b>${r.trade.ticker}</b> (picked ${r.trade.date})`);
    lines.push(`   Entry: $${r.trade.entryPrice} → Now: $${r.currentPrice.toFixed(2)} (${r.pctMove >= 0 ? '+' : ''}${r.pctMove.toFixed(1)}%)`);
    lines.push(`   Status: <b>${r.outcome}</b>`);
    lines.push(``);
  });

  lines.push(`<i>Paper trading — no real money involved. Tracking accuracy before going live.</i>`);
  await sendTelegram(lines.join('\n'));
  console.log(`[${new Date().toISOString()}] Daily paper status sent — ${results.length} open trades`);
}

// Friday closing report — full week summary of wins/losses/open
async function sendFridayClosingReport() {
  await evaluateOpenTrades(); // refresh prices and auto-close any that hit target/stop today
  const log = loadLog();

  const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thisWeek = log.filter(t => t.date >= oneWeekAgo);

  if (thisWeek.length === 0) {
    await sendTelegram(`📊 <b>Weekly Closing Report</b>\nNo picks logged this week.`);
    return;
  }

  const wins   = thisWeek.filter(t => t.result === 'TARGET HIT ✅').length;
  const losses = thisWeek.filter(t => t.result === 'STOP HIT 🛑').length;
  const open   = thisWeek.filter(t => !t.closed).length;
  const closedCount = wins + losses;
  const winRate = closedCount > 0 ? ((wins / closedCount) * 100).toFixed(0) : 'N/A';

  const lines = [
    `🌙 <b>Weekly Closing Report — Paper Trading</b>`,
    `📅 Week ending ${new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' })}`,
    ``,
    `<b>━━━ ALL PICKS THIS WEEK ━━━</b>`,
    ``
  ];

  thisWeek.forEach(t => {
    const finalPrice = t.closed ? t.closedPrice : null;
    const pct = t.closed ? t.closedPct : null;
    lines.push(`<b>${t.ticker}</b> (${t.date})`);
    lines.push(`   Entry: $${t.entryPrice} | Target: $${t.target} | Stop: $${t.stop}`);
    if (t.closed) {
      lines.push(`   Closed: $${finalPrice.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) — <b>${t.result}</b>`);
    } else {
      lines.push(`   Status: <b>Still open ⏳</b>`);
    }
    lines.push(``);
  });

  lines.push(`<b>━━━ WEEK SUMMARY ━━━</b>`);
  lines.push(`✅ Wins: ${wins}  |  🛑 Losses: ${losses}  |  ⏳ Still open: ${open}`);
  lines.push(`📊 Win rate (closed trades): ${winRate}%`);
  lines.push(``);

  if (closedCount >= 3) {
    if (parseFloat(winRate) >= 60) lines.push(`🟢 Solid week — logic performing reasonably.`);
    else if (parseFloat(winRate) >= 40) lines.push(`🟡 Mixed week — keep observing before risking capital.`);
    else lines.push(`🔴 Weak week — would NOT recommend going live yet on this data.`);
  } else {
    lines.push(`📊 Not enough closed trades yet for a reliable read. Keep paper trading.`);
  }

  lines.push(``);
  lines.push(`<i>This is paper trading only — no real money. Use this track record to decide when (or if) to go live.</i>`);

  await sendTelegram(lines.join('\n'));
  console.log(`[${new Date().toISOString()}] Friday closing report sent`);
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const data = await res.json();
  if (!data.ok) console.error('Telegram error:', JSON.stringify(data));
  return data;
}

async function getPrevDay(ticker) {
  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.results?.length) {
      const r = data.results[0];
      return { price: r.c, open: r.o, high: r.h, low: r.l, volume: r.v,
        change_pct: (((r.c - r.o) / r.o) * 100) };
    }
  } catch (e) { console.error(`prevDay error ${ticker}:`, e.message); }
  return null;
}

// Fetches today's intraday high and low from Polygon.
// Critical for correct stop/target detection — a stop can be
// breached intraday even if the stock recovers to close above it.
async function getIntradayRange(ticker) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${today}/${today}?adjusted=true&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.results?.length) {
      return { high: data.results[0].h, low: data.results[0].l };
    }
  } catch (e) {}
  return null;
}

async function getRSI(ticker) {
  try {
    const url = `https://api.polygon.io/v1/indicators/rsi/${ticker}?timespan=day&window=14&series_type=close&limit=1&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.results?.values?.length) return data.results.values[0].value;
  } catch (e) {}
  return null;
}

async function getVolatility(ticker) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fromDate}/${to}?adjusted=true&sort=desc&limit=20&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.results?.length >= 5) {
      const ranges = data.results.map(d => (d.h - d.l) / d.c);
      const avgRangePct = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      return avgRangePct;
    }
  } catch (e) {}
  return 0.02;
}

async function buildDailyRecommendations() {
  const candidates = [];

  for (const stock of HALAL_UNIVERSE) {
    // Small delay between tickers to stay under Polygon's free-tier rate limit (5 req/min)
    await new Promise(r => setTimeout(r, 4000));

    const day = await getPrevDay(stock.ticker);
    const rsi = await getRSI(stock.ticker);
    const vol = await getVolatility(stock.ticker);
    if (!day || rsi === null) {
      console.log(`Skipped ${stock.ticker} — missing data (day:${!!day}, rsi:${rsi})`);
      continue;
    }

    const price = day.price;

    // Hard exclude: RSI above 70 = overbought, never buy
    if (rsi > 70) {
      console.log(`Skipped ${stock.ticker} — RSI ${rsi.toFixed(0)} overbought`);
      continue;
    }

    const entryLow  = +(price * (1 - vol * 0.3)).toFixed(2);
    const entryHigh = +(price * (1 + vol * 0.3)).toFixed(2);

    // Target: capped at +6% max, scaled by RSI (oversold = higher target)
    // Using Math.min to enforce hard 6% cap regardless of volatility
    const targetMultiplier = rsi < 40 ? 1.5 : rsi < 55 ? 1.2 : 1.0;
    const rawTarget = price * (1 + vol * targetMultiplier);
    const cappedTarget = Math.min(rawTarget, price * 1.06); // never more than +6%
    const target = +cappedTarget.toFixed(2);

    // Stop: capped at -4% max
    const rawStop = price * (1 - vol * 0.8);
    const cappedStop = Math.max(rawStop, price * 0.96); // never more than -4%
    const stop = +cappedStop.toFixed(2);

    let score = 0;
    if (rsi < 35) score += 40;
    else if (rsi < 45) score += 25;
    else if (rsi < 60) score += 10;

    score += Math.max(0, 15 - Math.abs(day.change_pct));
    score += vol > 0.02 ? 10 : 0;
    score += (target - price) / price > 0.05 ? 15 : 5;

    candidates.push({
      ticker: stock.ticker, name: stock.name, price, rsi, vol,
      entryLow, entryHigh, target, stop, score,
      changePct: day.change_pct
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Limit: each ticker can only appear MAX 2x per week in the log
  // This prevents AMD dominating every single day
  const log = loadLog();
  const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thisWeekCounts = {};
  log.filter(t => t.date >= oneWeekAgo).forEach(t => {
    thisWeekCounts[t.ticker] = (thisWeekCounts[t.ticker] || 0) + 1;
  });

  const filtered = candidates.filter(c => (thisWeekCounts[c.ticker] || 0) < 2);
  return filtered.slice(0, MAX_DAILY_PICKS);
}

function classifySignal(price, pick) {
  const inEntry  = price >= pick.entryLow && price <= pick.entryHigh;
  const oversold = pick.rsi < 40;
  const atStop   = price <= pick.stop * 1.015;
  const atTarget = price >= pick.target * 0.975;

  if (atStop)              return { signal: 'EXIT NOW — stop approaching',  emoji: '🚨', priority: 'CRITICAL' };
  if (atTarget)            return { signal: 'TAKE PROFIT — target reached', emoji: '💰', priority: 'CRITICAL' };
  if (inEntry && oversold) return { signal: 'STRONG BUY — oversold + zone', emoji: '⭐', priority: 'HIGH'     };
  if (inEntry)             return { signal: 'BUY ZONE — entry range hit',   emoji: '🟢', priority: 'HIGH'     };
  return                          { signal: 'WATCHING — no action yet',     emoji: '👁',  priority: 'LOW'      };
}

function allocationFor(index) {
  const weights = [0.5, 0.3, 0.2];
  return weights[index] ?? 0.15;
}

async function sendDailyBriefing() {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai'
  });

  console.log('Building fresh daily recommendations...');
  todaysPicks = await buildDailyRecommendations();
  alertsSentToday.clear();

  if (todaysPicks.length === 0) {
    await sendTelegram(`⚠️ <b>HalalTrade</b>\nCouldn't fetch live data today — check Polygon API key/limits. No picks generated for ${today}.`);
    return;
  }

  logPicks(todaysPicks); // record for paper-trade tracking

  const lines = [
    `☽ <b>HalalTrade Daily Briefing</b>`,
    `📅 ${today}`,
    `💰 Capital: $${CAPITAL} | 🎯 Target: +3–7% this week`,
    `⏰ US Market opens in 30 min (5:30 PM UAE)`,
    `🔄 <i>Picks recalculated fresh from today's live data</i>`,
    ``,
    `<b>━━━ TODAY'S PICKS (halal verified) ━━━</b>`,
    ``
  ];

  todaysPicks.forEach((p, i) => {
    const alloc    = allocationFor(i);
    const dollars  = Math.round(CAPITAL * alloc);
    const shares   = (dollars / p.price).toFixed(2);
    const upside   = (((p.target - p.price) / p.price) * 100).toFixed(1);
    const downside = (((p.price - p.stop)   / p.price) * 100).toFixed(1);
    const profit   = (dollars * parseFloat(upside)   / 100).toFixed(0);
    const lossAmt  = (dollars * parseFloat(downside) / 100).toFixed(0);
    const rsiTag   = p.rsi < 40 ? 'oversold' : p.rsi > 70 ? 'overbought' : 'neutral';

    lines.push(`${i === 0 ? '⭐' : '🟢'} <b>${p.ticker}</b> — ${p.name}`);
    lines.push(`   💵 Price: <b>$${p.price.toFixed(2)}</b>  |  RSI: ${p.rsi.toFixed(0)} (${rsiTag})  |  ${p.changePct >= 0 ? '📈' : '📉'} ${p.changePct.toFixed(2)}%`);
    lines.push(`   🎯 Entry: $${p.entryLow}–$${p.entryHigh}`);
    lines.push(`   ✅ Target: $${p.target} (+${upside}%)  |  🛑 Stop: $${p.stop} (-${downside}%)`);
    lines.push(`   💼 Buy: $${dollars} = ${shares} shares`);
    lines.push(`   💰 Max profit: +$${profit}  |  Max loss: -$${lossAmt}`);
    lines.push(`   ☽ 0% interest · 0% haram`);
    lines.push(``);
  });

  lines.push(`<b>━━━ RULES ━━━</b>`);
  lines.push(`1️⃣ Limit orders only — never market orders`);
  lines.push(`2️⃣ Set stop-losses immediately after buying`);
  lines.push(`3️⃣ Close all by Friday midnight UAE`);
  lines.push(`4️⃣ Max loss rule: stop trading for the week if down $50`);
  lines.push(``);
  lines.push(`<i>Educational only. Not financial advice. Verify on Zoya before trading.</i>`);

  await sendTelegram(lines.join('\n'));
  console.log(`[${new Date().toISOString()}] Daily briefing sent — picks: ${todaysPicks.map(p => p.ticker).join(', ')}`);
}

async function checkPriceAlerts() {
  if (todaysPicks.length === 0) return;

  for (let i = 0; i < todaysPicks.length; i++) {
    const pick = todaysPicks[i];
    const day = await getPrevDay(pick.ticker);
    if (!day) continue;

    const sig = classifySignal(day.price, pick);
    if (sig.priority === 'LOW') continue;

    const alertKey = `${pick.ticker}-${sig.signal}`;
    if (alertsSentToday.has(alertKey)) continue;
    alertsSentToday.add(alertKey);

    const dollars  = Math.round(CAPITAL * allocationFor(i));
    const shares   = (dollars / day.price).toFixed(2);
    const upside   = (((pick.target - day.price) / day.price) * 100).toFixed(1);
    const downside = (((day.price - pick.stop)   / day.price) * 100).toFixed(1);

    const msg = [
      `${sig.emoji} <b>HALALTRADE ALERT — ${pick.ticker}</b>`,
      ``,
      `⚡ Signal: <b>${sig.signal}</b>`,
      `💵 Price: <b>$${day.price.toFixed(2)}</b>  |  ${day.change_pct >= 0 ? '📈' : '📉'} ${day.change_pct.toFixed(2)}%`,
      ``,
      `🎯 Target: $${pick.target} (+${upside}%)`,
      `🛑 Stop:   $${pick.stop} (-${downside}%)`,
      `💼 Size:   $${dollars} = ${shares} shares`,
      ``,
      sig.priority === 'CRITICAL' ? `🚨 <b>ACTION REQUIRED NOW</b>` : `📲 Review and act if in entry zone`,
      ``,
      `☽ Halal ✅ | ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai' })} UAE`
    ].join('\n');

    await sendTelegram(msg);
    console.log(`[${new Date().toISOString()}] Alert: ${pick.ticker} — ${sig.signal}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

async function sendEODSummary() {
  if (todaysPicks.length === 0) return;

  const lines = [
    `🌙 <b>HalalTrade EOD Summary</b>`,
    `📅 ${new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' })}`,
    ``,
    `<b>━━━ CLOSING PRICES & P&L ━━━</b>`,
    ``
  ];

  let totalPL = 0;

  for (let i = 0; i < todaysPicks.length; i++) {
    const pick = todaysPicks[i];
    const day = await getPrevDay(pick.ticker);
    if (!day) continue;

    const dollars = Math.round(CAPITAL * allocationFor(i));
    const dayPL   = (dollars * day.change_pct / 100);
    totalPL      += dayPL;

    const e = day.change_pct >= 0 ? '📈' : '📉';
    lines.push(`${e} <b>${pick.ticker}</b>: $${day.price.toFixed(2)} (${day.change_pct >= 0 ? '+' : ''}${day.change_pct.toFixed(2)}%)`);
    lines.push(`   P&L on $${dollars}: ${dayPL >= 0 ? '+' : ''}$${dayPL.toFixed(2)}`);

    if (day.price >= pick.target * 0.97)      lines.push(`   ✅ TARGET REACHED — consider taking profit`);
    else if (day.price <= pick.stop * 1.015)  lines.push(`   🚨 NEAR STOP-LOSS — review position`);
    lines.push(``);
  }

  const weeklyPct = ((totalPL / CAPITAL) * 100).toFixed(2);
  lines.push(`<b>━━━ TODAY'S TOTAL ━━━</b>`);
  lines.push(`📊 P&L: ${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)} (${totalPL >= 0 ? '+' : ''}${weeklyPct}%)`);
  lines.push(`💰 Capital now: $${(CAPITAL + totalPL).toFixed(2)}`);
  lines.push(``);
  lines.push(`⏰ Next briefing: Tomorrow 5:00 PM UAE — fresh picks recalculated`);
  lines.push(`☽ Stay halal · Stay disciplined`);

  await sendTelegram(lines.join('\n'));
  console.log(`[${new Date().toISOString()}] EOD summary sent`);
}

function isWeekend() {
  // Get day-of-week in UAE time, then check what US market day that corresponds to.
  // Simplify: check the US/Eastern day-of-week directly, since that's what matters for NYSE/NASDAQ.
  const usDay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return usDay === 'Sat' || usDay === 'Sun';
}

function getUAETime() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = now.split(':').map(Number);
  return { hour: h, minute: m };
}

function isMarketHours() {
  const { hour } = getUAETime();
  return hour >= 17 || hour === 0;
}

function isFriday() {
  // This fires at 12:45 AM UAE, right after the US market closes.
  // At that moment in US/Eastern it's already past midnight into the
  // next calendar day, so we check "yesterday" in US time to get the
  // actual trading day that just closed.
  const usDate = new Date(Date.now() - 6 * 3600000); // back up ~6h to land in the prior US trading day
  const usDay = usDate.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return usDay === 'Fri';
}

// ── Telegram command listener ───────────────────────────────
// Lets you trigger any report on demand by messaging the bot,
// instead of waiting for the scheduled times.
let lastUpdateId = 0;

async function pollTelegramCommands() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const text = update.message?.text?.trim().toLowerCase();
      const fromChatId = String(update.message?.chat?.id || '');
      if (!text || fromChatId !== String(CHAT_ID)) continue; // only respond to your own chat

      console.log(`[${new Date().toISOString()}] Command received: ${text}`);

      if (text === '/today' || text === '/picks') {
        if (isWeekend()) {
          await sendTelegram([
            `⚠️ <b>Markets are closed today (weekend)</b>`,
            ``,
            `US markets open Monday 5:30 PM UAE time.`,
            `These picks are based on Friday's closing prices — not actionable until Monday.`,
            ``,
            `Send /today on Monday after 5:00 PM UAE for live picks.`
          ].join('\n'));
        }
        await sendTelegram('🔄 Generating picks from latest data (note: weekend prices)...');
        await sendDailyBriefing();
      } else if (text === '/status') {
        await sendTelegram('🔄 Checking open paper trades...');
        await sendDailyPaperStatus();
      } else if (text === '/weekly' || text === '/friday') {
        await sendTelegram('🔄 Building weekly closing report...');
        await sendFridayClosingReport();
      } else if (text === '/help' || text === '/start') {
        await sendTelegram([
          `🤖 <b>HalalTrade Bot Commands</b>`,
          ``,
          `/today — Get fresh picks right now`,
          `/status — Check open paper trades`,
          `/weekly — Full weekly closing report`,
          `/help — Show this menu`,
          ``,
          `Scheduled automatically:`,
          `📅 5:00 PM UAE — daily briefing`,
          `📋 12:45 AM UAE — daily status (Mon–Thu)`,
          `🌙 12:45 AM UAE Friday — weekly closing report`
        ].join('\n'));
      }
    }
  } catch (err) {
    console.error('pollTelegramCommands error:', err.message);
  }
}

async function mainLoop() {
  console.log('HalalTrade Bot v2 starting (dynamic daily picks)...');

  // Skip any old/stale messages sent before this boot (e.g. your earlier
  // chat-ID lookup test messages) so the bot doesn't reprocess them as commands.
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`);
    const data = await res.json();
    if (data.ok && data.result?.length) {
      lastUpdateId = data.result[data.result.length - 1].update_id;
    }
  } catch (e) { console.error('Initial update sync error:', e.message); }

  await sendTelegram([
    `🤖 <b>HalalTrade Bot is LIVE</b> (v2 — dynamic picks)`,
    ``,
    `📅 Daily briefing: 5:00 PM UAE — picks recalculated fresh from live data`,
    `⚡ Price alerts: every 5 min during market hours`,
    `📋 Daily status: 12:45 AM UAE (Mon–Thu)`,
    `🌙 Weekly closing report: 12:45 AM UAE Friday`,
    ``,
    `☽ Zero-tolerance halal · Strict mode`,
    `💰 Tracking: $${CAPITAL} capital`,
    `🇦🇪 Timezone: Asia/Dubai (GST)`,
    ``,
    `💬 Send /help anytime to trigger reports on demand`
  ].join('\n'));

  let lastMinute = -1;

  // Poll for incoming Telegram commands every 3 seconds
  setInterval(() => pollTelegramCommands(), 3 * 1000);

  setInterval(async () => {
    const { hour, minute } = getUAETime();
    if (minute === lastMinute) return;
    lastMinute = minute;

    try {
      if (isWeekend()) return; // markets closed Sat/Sun — skip all messages
      if (hour === 17 && minute === 0)  await sendDailyBriefing();
      if (hour === 0  && minute === 30) await sendEODSummary();

      // End-of-day paper trade report: Friday gets the full weekly close,
      // every other trading day gets a lighter daily status update.
      if (hour === 0 && minute === 45) {
        if (isFriday()) await sendFridayClosingReport();
        else             await sendDailyPaperStatus();
      }

      if (isMarketHours() && minute % 5 === 0) await checkPriceAlerts();
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  }, 30 * 1000);
}

mainLoop();

// Manual test mode: run "node bot.js test" to trigger an immediate
// daily briefing without waiting for 5 PM UAE time.
if (process.argv[2] === 'test') {
  setTimeout(() => sendDailyBriefing(), 2000);
}

// Manual test: run "node bot.js paperstatus" to test the daily
// open-trades status update immediately.
if (process.argv[2] === 'paperstatus') {
  setTimeout(() => sendDailyPaperStatus(), 2000);
}

// Manual test: run "node bot.js friday" to test the weekly
// closing report immediately (works any day, for testing).
if (process.argv[2] === 'friday') {
  setTimeout(() => sendFridayClosingReport(), 2000);
}
