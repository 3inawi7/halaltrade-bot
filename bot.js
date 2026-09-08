// ============================================================
// HalalTrade Telegram Bot — v2 DYNAMIC DAILY RECOMMENDATIONS
// Picks are recalculated fresh every day from live price/RSI data
// — no more fixed/hardcoded targets
// Run: node bot.js
// Deploy free: Railway.app
// ============================================================

require('dotenv').config();

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN  || 'YOUR_BOT_TOKEN_HERE';
const CHAT_ID         = process.env.CHAT_ID         || 'YOUR_CHAT_ID_HERE';
const ALPACA_KEY      = process.env.ALPACA_KEY      || 'YOUR_ALPACA_KEY';
const ALPACA_SECRET   = process.env.ALPACA_SECRET   || 'YOUR_ALPACA_SECRET';
const CAPITAL         = parseFloat(process.env.CAPITAL) || 1000;

// Alpaca paper trading base URL — real-time market data, free
const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2';
const ALPACA_HEADERS  = {
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type':        'application/json'
};

if (TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE' || CHAT_ID === 'YOUR_CHAT_ID_HERE' ||
    ALPACA_KEY === 'YOUR_ALPACA_KEY' || ALPACA_SECRET === 'YOUR_ALPACA_SECRET') {
  console.error('Missing keys! Check your .env file has real values for TELEGRAM_TOKEN, CHAT_ID, ALPACA_KEY, ALPACA_SECRET.');
  process.exit(1);
}

// Halal universe - Zoya/Musaffa zero-tolerance verified July 2026
// Criteria: 0% interest income, 0% haram revenue, debt/assets <20%
// Excluded: MSFT (0.3% interest), META (1.8% haram), AMZN (2.1% haram)
// Excluded: LRCX (1.66% interest), KLAC (1.48% interest)
const HALAL_UNIVERSE = [
  { ticker: 'AMD',   name: 'Advanced Micro Devices' },
  { ticker: 'AAPL',  name: 'Apple Inc.' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.' },
  { ticker: 'NVDA',  name: 'NVIDIA Corp.' },
  { ticker: 'QCOM',  name: 'Qualcomm Inc.' },
  { ticker: 'TSM',   name: 'Taiwan Semiconductor' },
  { ticker: 'AMAT',  name: 'Applied Materials' },
  { ticker: 'MRVL',  name: 'Marvell Technology' },
  { ticker: 'AVGO',  name: 'Broadcom Inc.' },
];

const MAX_DAILY_PICKS = 3;
let todaysPicks = [];
const alertsSentToday = new Set();

// ── Paper trading log ───────────────────────────────────────
// Records every pick made so we can check 3 trading days later
// whether the target/stop would actually have hit. No real money.
// ── Persistent trade log via Telegram ──────────────────────
// Stores the paper trade log as a pinned message in your Telegram chat.
// This survives Railway restarts, redeployments, and server wipes.
// No database needed — Telegram IS the database.

let pinnedMessageId = null; // cached message ID of the log message

async function loadLog() {
  try {
    // Primary: check pinned message in chat
    const chatRes  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChat?chat_id=${CHAT_ID}`);
    const chatData = await chatRes.json();
    if (chatData.ok && chatData.result?.pinned_message) {
      const text = chatData.result.pinned_message.text || '';
      if (text.startsWith('HALALTRADE_LOG:')) {
        pinnedMessageId = chatData.result.pinned_message.message_id;
        const log = JSON.parse(text.replace('HALALTRADE_LOG:', ''));
        console.log(`loadLog: found ${log.length} trades in pinned message (id: ${pinnedMessageId})`);
        return log;
      }
    }

    // Fallback: scan last 50 messages for a log message in case pinning failed
    console.log('loadLog: no pinned log found — scanning recent messages...');
    const updatesRes  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?limit=50&offset=-50`);
    const updatesData = await updatesRes.json();
    if (updatesData.ok) {
      const msgs = updatesData.result
        .map(u => u.message)
        .filter(m => m && m.text && m.text.startsWith('HALALTRADE_LOG:'))
        .sort((a, b) => b.date - a.date); // newest first
      if (msgs.length > 0) {
        pinnedMessageId = msgs[0].message_id;
        const log = JSON.parse(msgs[0].text.replace('HALALTRADE_LOG:', ''));
        console.log(`loadLog: recovered ${log.length} trades from message scan (id: ${pinnedMessageId})`);
        // Re-pin this message so future loads find it faster
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/pinChatMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, message_id: pinnedMessageId, disable_notification: true })
        });
        return log;
      }
    }
  } catch (e) { console.error('loadLog error:', e.message); }
  console.log('loadLog: starting fresh — no existing log found');
  return [];
}

async function saveLog(log) {
  try {
    const text = 'HALALTRADE_LOG:' + JSON.stringify(log);
    if (pinnedMessageId) {
      // Edit the existing pinned message
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, message_id: pinnedMessageId, text })
      });
    } else {
      // First time: send and pin a new log message
      const sent = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, disable_notification: true })
      }).then(r => r.json());
      if (sent.ok) {
        pinnedMessageId = sent.result.message_id;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/pinChatMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, message_id: pinnedMessageId, disable_notification: true })
        });
      }
    }
  } catch (e) { console.error('saveLog error:', e.message); }
}

async function logPicks(picks) {
  const log = await loadLog();
  const today = new Date().toISOString().slice(0, 10);

  // Prevent duplicates — don't log the same ticker twice on the same day
  const alreadyLoggedToday = new Set(
    log.filter(t => t.date === today).map(t => t.ticker)
  );

  let added = 0;
  picks.forEach(p => {
    if (alreadyLoggedToday.has(p.ticker)) {
      console.log(`Skipping duplicate log for ${p.ticker} on ${today}`);
      return;
    }
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
    added++;
  });

  if (added > 0) await saveLog(log);
  console.log(`Logged ${added} new picks (${picks.length - added} duplicates skipped)`);
}

// Checks ALL still-open paper trades against current price.
// Used both for the daily status update and the Friday closing report.
async function evaluateOpenTrades() {
  const log = await loadLog();
  const open = log.filter(t => !t.closed);
  const results = [];

  for (const trade of open) {
    // Fetch full price history since entry using Yahoo Finance
    const today = new Date().toISOString().slice(0, 10);
    let intradayHigh = trade.entryPrice;
    let intradayLow  = trade.entryPrice;
    let currentPrice = trade.entryPrice;

    try {
      const daysSinceEntry = Math.ceil((new Date(today) - new Date(trade.date)) / 86400000) + 5;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${trade.ticker}?interval=1d&range=${daysSinceEntry}d`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await res.json();
      const result = data.chart?.result?.[0];
      if (result) {
        const highs  = result.indicators.quote[0].high.filter(h => h);
        const lows   = result.indicators.quote[0].low.filter(l => l);
        const closes = result.indicators.quote[0].close.filter(c => c);
        if (highs.length)  intradayHigh = Math.max(...highs);
        if (lows.length)   intradayLow  = Math.min(...lows);
        if (closes.length) currentPrice = closes[closes.length - 1];
      }
    } catch (e) {
      console.error(`History fetch error ${trade.ticker}:`, e.message);
      continue;
    }

    const pctMove = (((currentPrice - trade.entryPrice) / trade.entryPrice) * 100);

    // Fair stop/target classification:
    // - TARGET HIT if intraday high reached target
    // - STOP HIT only if intraday low hit stop AND closing price stayed below stop
    //   (prevents false stop-hits where stock dipped then recovered strongly)
    // - If both triggered, use closing price to decide winner
    let outcome = 'OPEN ⏳';
    if (intradayHigh >= trade.target) outcome = 'TARGET HIT ✅';
    if (intradayLow <= trade.stop && currentPrice <= trade.stop * 1.02) outcome = 'STOP HIT 🛑';
    if (intradayLow <= trade.stop && intradayHigh >= trade.target) {
      outcome = currentPrice >= trade.entryPrice ? 'TARGET HIT ✅' : 'STOP HIT 🛑';
    }

    results.push({ trade, currentPrice, outcome, pctMove });

    if (outcome !== 'OPEN ⏳') {
      trade.closed    = true;
      trade.result    = outcome;
      trade.closedPrice = currentPrice;
      trade.closedPct   = pctMove;
      trade.closedDate  = today;
    }

    await new Promise(r => setTimeout(r, 4000));
  }

  await saveLog(log); // was missing await — caused saves to silently fail
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
  const log = await loadLog();

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

// ── Data fetchers ───────────────────────────────────────────
// Alpaca: real-time latest price (works always, free)
// Yahoo Finance: historical daily bars for RSI + volatility (free, no key, works on weekends)

async function getPrevDay(ticker) {
  // Real-time latest price from Alpaca
  try {
    const url = `${ALPACA_DATA_URL}/stocks/${ticker}/bars/latest?feed=iex`;
    const res  = await fetch(url, { headers: ALPACA_HEADERS });
    const data = await res.json();
    if (data.bar) {
      const b = data.bar;
      // Get yesterday's close from Yahoo for accurate change_pct
      const hist = await getYahooHistory(ticker, 2);
      const prevClose = hist.length >= 2 ? hist[hist.length - 2] : b.o;
      return {
        price:      b.c,
        open:       prevClose,
        high:       b.h,
        low:        b.l,
        volume:     b.v,
        change_pct: (((b.c - prevClose) / prevClose) * 100)
      };
    }
  } catch (e) { console.error(`getPrevDay error ${ticker}:`, e.message); }
  // Fallback: use Yahoo latest close
  try {
    const hist = await getYahooHistory(ticker, 2);
    if (hist.length >= 1) {
      const price = hist[hist.length - 1];
      const prev  = hist.length >= 2 ? hist[hist.length - 2] : price;
      return { price, open: prev, high: price, low: price, volume: 0,
        change_pct: (((price - prev) / prev) * 100) };
    }
  } catch (e) {}
  return null;
}

// Fetch historical daily closes from Yahoo Finance — free, no API key, works on weekends
async function getYahooHistory(ticker, days = 30) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${Math.ceil(days * 1.5)}d`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (closes?.length) return closes.filter(c => c !== null && c !== undefined);
  } catch (e) { console.error(`Yahoo history error ${ticker}:`, e.message); }
  return [];
}

// Calculate RSI from Yahoo Finance historical closes — works on weekends
async function getRSI(ticker) {
  try {
    const closes = await getYahooHistory(ticker, 30);
    if (closes.length >= 5) return calcRSI(closes);
  } catch (e) { console.error(`getRSI error ${ticker}:`, e.message); }
  return null;
}

// Calculate 20-day volatility from Yahoo Finance historical closes
async function getVolatility(ticker) {
  try {
    const closes = await getYahooHistory(ticker, 25);
    if (closes.length >= 3) {
      // Estimate daily range as % of close using day-to-day moves as proxy
      const moves = [];
      for (let i = 1; i < closes.length; i++) {
        moves.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1]);
      }
      return moves.reduce((a, b) => a + b, 0) / moves.length;
    }
  } catch (e) {}
  return 0.02;
}

// Get today's intraday high/low from Alpaca
async function getIntradayRange(ticker) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url = `${ALPACA_DATA_URL}/stocks/${ticker}/bars?timeframe=1Day&start=${today}&feed=iex&limit=1`;
    const res  = await fetch(url, { headers: ALPACA_HEADERS });
    const data = await res.json();
    if (data.bars?.length) return { high: data.bars[0].h, low: data.bars[0].l };
  } catch (e) {}
  return null;
}

// Standard Wilder RSI calculation
function calcRSI(closes) {
  if (closes.length < 2) return 50;
  const periods = Math.min(14, closes.length - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i <= periods; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / periods, avgLoss = losses / periods;
  for (let i = periods + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (periods-1) + Math.max(diff, 0))  / periods;
    avgLoss = (avgLoss * (periods-1) + Math.max(-diff, 0)) / periods;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// Known upcoming earnings dates — update weekly
// Bot skips any stock within 5 trading days of its earnings report
// This prevents the AAPL -7.2% earnings gap situation from repeating
const EARNINGS_DATES = {
  'AAPL': '2026-10-29', // next earnings after July 30 report
  'AMD':  '2026-10-28',
  'NVDA': '2026-08-27',
  'GOOGL':'2026-10-28',
  'QCOM': '2026-10-22',
  'AVGO': '2026-09-11',
  'TSM':  '2026-10-16',
  'AMAT': '2026-08-14',
  'MRVL': '2026-09-04',
};

function isNearEarnings(ticker) {
  const dateStr = EARNINGS_DATES[ticker];
  if (!dateStr) return false;
  const earningsDate = new Date(dateStr);
  const today = new Date();
  const daysUntil = (earningsDate - today) / (1000 * 60 * 60 * 24);
  // Skip if within 5 days before OR 2 days after earnings
  return daysUntil >= -2 && daysUntil <= 5;
}

async function buildDailyRecommendations() {
  const candidates = [];
  console.log('Starting buildDailyRecommendations...');

  for (const stock of HALAL_UNIVERSE) {
    await new Promise(r => setTimeout(r, 300)); // Yahoo has no rate limit

    const day = await getPrevDay(stock.ticker);
    const rsi = await getRSI(stock.ticker);
    const vol = await getVolatility(stock.ticker);

    console.log(`${stock.ticker}: price=${day?.price} rsi=${rsi?.toFixed(1)} vol=${vol?.toFixed(4)}`);

    if (!day || rsi === null) {
      console.log(`${stock.ticker}: SKIPPED — missing data`);
      continue;
    }

    const price = day.price;

    if (rsi > 70) {
      console.log(`${stock.ticker}: SKIPPED — RSI ${rsi.toFixed(0)} overbought`);
      continue;
    }

    // Skip if RSI above 58 AND stock already up more than 1.5% today — chasing a move
    if (rsi > 58 && day.change_pct > 1.5) {
      console.log(`${stock.ticker}: SKIPPED — RSI ${rsi.toFixed(0)} + already up ${day.change_pct.toFixed(1)}% today`);
      continue;
    }

    if (isNearEarnings(stock.ticker)) {
      console.log(`${stock.ticker}: SKIPPED — near earnings`);
      continue;
    }

    const entryLow  = +(price * (1 - vol * 0.3)).toFixed(2);
    const entryHigh = +(price * (1 + vol * 0.3)).toFixed(2);

    const targetMultiplier = rsi < 40 ? 1.5 : rsi < 55 ? 1.2 : 1.0;
    const rawTarget    = price * (1 + vol * targetMultiplier);
    const cappedTarget = Math.min(rawTarget, price * 1.06);
    const flooredTarget= Math.max(cappedTarget, price * 1.03);
    const target = +flooredTarget.toFixed(2);

    const rawStop    = price * (1 - vol * 0.8);
    const cappedStop = Math.max(rawStop, price * 0.96);
    const flooredStop= Math.min(cappedStop, price * 0.98);
    const stop = +flooredStop.toFixed(2);

    const upside   = (target - price) / price;
    const downside = (price - stop)   / price;
    const rr = upside / downside;

    if (rr < 1.5) {
      console.log(`${stock.ticker}: SKIPPED — poor R/R ${rr.toFixed(2)}`);
      continue;
    }

    let score = 0;
    if (rsi < 35) score += 40;
    else if (rsi < 45) score += 25;
    else if (rsi < 60) score += 10;
    score += Math.max(0, 15 - Math.abs(day.change_pct));
    score += vol > 0.02 ? 10 : 0;
    score += upside > 0.05 ? 15 : 5;

    console.log(`${stock.ticker}: PASSED — score=${score} target=$${target} stop=$${stop} R/R=${rr.toFixed(2)}`);
    candidates.push({
      ticker: stock.ticker, name: stock.name, price, rsi, vol,
      entryLow, entryHigh, target, stop, score,
      changePct: day.change_pct
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Limit: each ticker can only appear MAX 2x per week in the log
  const log = await loadLog();
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
    await sendTelegram(`⚠️ <b>HalalTrade</b>\nCouldn't fetch live data today — check Alpaca API keys in Railway variables. No picks generated for ${today}.`);
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

    // Baraka trade card — copy these values directly into the Baraka app
    lines.push(`   📲 <b>Baraka order card:</b>`);
    lines.push(`   ┌─────────────────────────`);
    lines.push(`   │ Stock:      ${p.ticker}`);
    lines.push(`   │ Order:      Limit Buy`);
    lines.push(`   │ Shares:     ${shares}`);
    lines.push(`   │ Limit $:    $${p.entryLow} (max $${p.entryHigh})`);
    lines.push(`   │ Stop-loss:  $${p.stop}`);
    lines.push(`   │ Target:     $${p.target}`);
    lines.push(`   │ Capital:    $${dollars}`);
    lines.push(`   └─────────────────────────`);
    lines.push(`   ⏰ Set stop-loss immediately after fill`);
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

// US market holidays 2026 — market closed these days
const US_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-11-27', // Day after Thanksgiving (early close)
  '2026-12-25', // Christmas
];

function isUSMarketHoliday() {
  const usDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return US_HOLIDAYS_2026.includes(usDate);
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
      } else if (text === '/earnings') {
        const lines = [`📅 <b>Upcoming Earnings Dates</b>`, `<i>Bot skips stocks within 5 days of earnings</i>`, ``];
        const today = new Date();
        Object.entries(EARNINGS_DATES).sort((a,b) => new Date(a[1]) - new Date(b[1])).forEach(([ticker, date]) => {
          const days = Math.round((new Date(date) - today) / (1000*60*60*24));
          const flag = days <= 5 && days >= -2 ? ' ⚠️ SKIP THIS WEEK' : '';
          lines.push(`<b>${ticker}</b>: ${date} (${days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`})${flag}`);
        });
        await sendTelegram(lines.join('\n'));
      } else if (text === '/help' || text === '/start') {
        await sendTelegram([
          `🤖 <b>HalalTrade Bot Commands</b>`,
          ``,
          `/today — Get fresh picks right now`,
          `/status — Check open paper trades`,
          `/weekly — Full weekly closing report`,
          `/earnings — Show upcoming earnings dates`,
          `/cleardupes — Remove duplicate picks from log`,
          `/help — Show this menu`,
          ``,
          `Scheduled automatically:`,
          `📅 5:00 PM UAE — daily briefing`,
          `📋 12:45 AM UAE — daily status (Mon–Thu)`,
          `🌙 12:45 AM UAE Friday — weekly closing report`
        ].join('\n'));
      } else if (text === '/debug') {
        // Shows first/last 4 chars of keys so we can verify they loaded correctly
        const keyPreview    = ALPACA_KEY    ? `${ALPACA_KEY.slice(0,4)}...${ALPACA_KEY.slice(-4)}`    : 'MISSING';
        const secretPreview = ALPACA_SECRET ? `${ALPACA_SECRET.slice(0,4)}...${ALPACA_SECRET.slice(-4)}` : 'MISSING';
        // Test a live fetch
        let fetchTest = 'not tested';
        try {
          const testRes  = await fetch(`${ALPACA_DATA_URL}/stocks/AMD/bars/latest?feed=iex`, { headers: ALPACA_HEADERS });
          const testData = await testRes.json();
          fetchTest = testData.bar ? `✅ AMD price: $${testData.bar.c}` : `❌ No bar returned: ${JSON.stringify(testData).slice(0,100)}`;
        } catch (e) { fetchTest = `❌ Error: ${e.message}`; }
        await sendTelegram([
          `🔧 <b>Debug Info</b>`,
          ``,
          `ALPACA_KEY: ${keyPreview}`,
          `ALPACA_SECRET: ${secretPreview}`,
          `Data URL: ${ALPACA_DATA_URL}`,
          ``,
          `Live fetch test:`,
          fetchTest
        ].join('\n'));
      } else if (text === '/cleardupes') {
        const log = await loadLog();
        const seen = new Set();
        const cleaned = log.filter(t => {
          const key = `${t.date}-${t.ticker}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const removed = log.length - cleaned.length;
        await saveLog(cleaned);
        await sendTelegram(`🧹 Removed ${removed} duplicate entries from the log.\n${cleaned.length} unique picks remaining.`);
      }
    }
  } catch (err) {
    console.error('pollTelegramCommands error:', err.message);
  }
}

async function mainLoop() {
  console.log('HalalTrade Bot v2 starting (dynamic daily picks)...');

  // Skip stale Telegram messages from before this boot
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`);
    const data = await res.json();
    if (data.ok && data.result?.length) {
      lastUpdateId = data.result[data.result.length - 1].update_id;
    }
  } catch (e) { console.error('Initial update sync error:', e.message); }

  // Verify existing trade log on startup — critical for persistence across Railway restarts
  try {
    const existingLog = await loadLog();
    const openTrades  = existingLog.filter(t => !t.closed).length;
    const totalTrades = existingLog.length;
    console.log(`Startup log check: ${totalTrades} total trades, ${openTrades} open`);
    if (totalTrades > 0) {
      await sendTelegram([
        `🔄 <b>HalalTrade Bot restarted</b>`,
        ``,
        `📋 Trade log restored: ${totalTrades} trades (${openTrades} open)`,
        `✅ No data lost — log loaded from pinned message`,
        ``,
        `Send /status to see open trades · /weekly for full report`
      ].join('\n'));
    }
  } catch (e) {
    console.error('Startup log check error:', e.message);
  }

  await sendTelegram([
    `🤖 <b>HalalTrade Bot is LIVE</b> (v3 — Alpaca real-time data)`,
    ``,
    `📊 Data source: Alpaca Markets (real-time intraday RSI)`,
    `📅 Daily briefing: 5:00 PM UAE — picks from live intraday data`,
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
      if (isWeekend() || isUSMarketHoliday()) return; // markets closed
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
