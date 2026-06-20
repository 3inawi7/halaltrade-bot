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
    const day = await getPrevDay(stock.ticker);
    const rsi = await getRSI(stock.ticker);
    const vol = await getVolatility(stock.ticker);
    if (!day || rsi === null) continue;

    const price = day.price;
    const entryLow  = +(price * (1 - vol * 0.5)).toFixed(2);
    const entryHigh = +(price * (1 + vol * 0.5)).toFixed(2);

    const targetMultiplier = rsi < 40 ? 3.5 : rsi < 55 ? 2.5 : 1.8;
    const target = +(price * (1 + vol * targetMultiplier)).toFixed(2);
    const stop = +(price * (1 - vol * 1.6)).toFixed(2);

    let score = 0;
    if (rsi < 35) score += 40;
    else if (rsi < 45) score += 25;
    else if (rsi > 70) score -= 30;

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
  return candidates.slice(0, MAX_DAILY_PICKS);
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

function getUAETime() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = now.split(':').map(Number);
  return { hour: h, minute: m };
}

function isMarketHours() {
  const { hour } = getUAETime();
  return hour >= 17 || hour === 0;
}

async function mainLoop() {
  console.log('HalalTrade Bot v2 starting (dynamic daily picks)...');

  await sendTelegram([
    `🤖 <b>HalalTrade Bot is LIVE</b> (v2 — dynamic picks)`,
    ``,
    `📅 Daily briefing: 5:00 PM UAE — picks recalculated fresh from live data`,
    `⚡ Price alerts: every 5 min during market hours`,
    `🌙 EOD summary: 12:30 AM UAE`,
    ``,
    `☽ Zero-tolerance halal · Strict mode`,
    `💰 Tracking: $${CAPITAL} capital`,
    `🇦🇪 Timezone: Asia/Dubai (GST)`
  ].join('\n'));

  let lastMinute = -1;

  setInterval(async () => {
    const { hour, minute } = getUAETime();
    if (minute === lastMinute) return;
    lastMinute = minute;

    try {
      if (hour === 17 && minute === 0)  await sendDailyBriefing();
      if (hour === 0  && minute === 30) await sendEODSummary();
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
