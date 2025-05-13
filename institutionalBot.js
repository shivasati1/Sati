require('dotenv').config();
const axios = require('axios');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

let mongoClient, db, signalsCollection;

async function initMongo() {
  try {
    if (!MONGO_URI) throw new Error("Missing MONGO_URI");
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db("tradingBot");
    signalsCollection = db.collection("insights");
    console.log("MongoDB connected.");
  } catch (err) {
    console.warn("MongoDB not connected:", err.message);
    signalsCollection = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSymbols() {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const res = await axios.get(url);
  return res.data.symbols
    .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .map(s => s.symbol);
}

async function fetchFundingRate(symbol) {
  const res = await axios.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
  return res.data[0]?.fundingRate ?? "N/A";
}

async function fetchOpenInterest(symbol) {
  const res = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
  return res.data?.openInterest ?? "N/A";
}

async function fetchLongShortRatio(symbol) {
  const res = await axios.get(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
  return res.data[0]?.longShortRatio ?? "N/A";
}

async function fetchTakerBuySellRatio(symbol) {
  const res = await axios.get(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`);
  return res.data[0]?.buySellRatio ?? "N/A";
}

async function fetchOrderBookImbalance(symbol) {
  const res = await axios.get(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
  const bidVolume = res.data.bids.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
  const askVolume = res.data.asks.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
  const imbalance = bidVolume - askVolume;
  return imbalance > 0 ? "Strong buy wall detected"
       : imbalance < 0 ? "Strong sell wall detected"
       : "Balanced order book";
}

async function fetchCVD(symbol) {
  const res = await axios.get(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=500`);
  let cvd = 0;
  for (const trade of res.data) {
    const qty = parseFloat(trade.qty);
    cvd += trade.isBuyerMaker ? -qty : qty;
  }
  return cvd > 0 ? "Showing hidden buying"
       : cvd < 0 ? "Showing hidden selling"
       : "Neutral CVD";
}

async function getInsight(prompt) {
  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "meta-llama/llama-4-maverick:free",
    messages: [{ role: "user", content: prompt }]
  }, {
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    }
  });
  return res.data.choices[0].message.content;
}

function extractConfidenceScore(insight) {
  const match = insight.match(/(\d{1,3})\s*%/);
  const score = match ? parseInt(match[1]) : 0;
  return isNaN(score) ? 0 : score;
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "Markdown"
  });
}

async function alreadyAlertedToday(symbol) {
  if (!signalsCollection) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const existing = await signalsCollection.findOne({ symbol, date: { $gte: today } });
  return !!existing;
}

async function saveSignal(symbol, insight, score) {
  if (!signalsCollection) return;
  await signalsCollection.insertOne({
    symbol,
    insight,
    score,
    date: new Date()
  });
}

(async () => {
  await initMongo();

  console.log("Fetching symbols...");
  let symbols = [];
  try {
    symbols = await fetchSymbols();
  } catch (e) {
    console.error("Failed to fetch symbols:", e.message);
    process.exit(1);
  }

  // Round-robin shuffle to avoid detection
  for (const symbol of symbols.sort(() => 0.5 - Math.random()).slice(0, 15)) {
    try {
      console.log(`\nAnalyzing ${symbol}...`);

      if (await alreadyAlertedToday(symbol)) {
        console.log(`Already alerted for ${symbol}, skipping.`);
        continue;
      }

      const fundingRate = await fetchFundingRate(symbol);
      const openInterest = await fetchOpenInterest(symbol);
      const longShortRatio = await fetchLongShortRatio(symbol);
      const takerBuySellRatio = await fetchTakerBuySellRatio(symbol);
      const orderBookImbalance = await fetchOrderBookImbalance(symbol);
      const cvd = await fetchCVD(symbol);

      const prompt = `
Symbol: ${symbol}
Funding Rate: ${fundingRate}
Open Interest: ${openInterest}
Long/Short Ratio: ${longShortRatio}
Taker Buy/Sell Ratio: ${takerBuySellRatio}
Order Book: ${orderBookImbalance}
CVD: ${cvd}

Based on the above, provide institutional-level analysis with:
- Confidence (0–100%)
- Risk Level (low/medium/high)
- Recommended Action (long/short/avoid)
`;

      const insight = await getInsight(prompt);
      const score = extractConfidenceScore(insight);

      console.log(`Insight for ${symbol} [${score}%]: ${insight}`);

      if (score >= 85) {
        await sendTelegram(`🚨 *${symbol} Insight* 🚨\n${insight}`);
        await saveSignal(symbol, insight, score);
        console.log(`Telegram alert sent for ${symbol}`);
      } else {
        console.log(`Skipped ${symbol} (Confidence: ${score}%)`);
      }

      await sleep(3000); // delay to reduce detection
    } catch (err) {
      console.error(`Error with ${symbol}:`, err.message);
    }
  }

  if (mongoClient) await mongoClient.close();
  console.log("\nFinished all symbols.");
})();
