const axios = require("axios");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' };

const client = new MongoClient(process.env.MONGO_URI);
let db;

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms + Math.random() * 300));
}

async function fetchSymbols() {
  const url = "https://fapi.binance.com/fapi/v1/exchangeInfo";
  const res = await axios.get(url, { headers });
  return res.data.symbols
    .filter(s => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
    .map(s => s.symbol);
}

async function fetchLightMetrics(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const res = await axios.get(url, { headers });
    const data = res.data;

    return {
      symbol,
      fundingRate: parseFloat(data.lastFundingRate || 0).toFixed(6),
      volume: parseFloat(data.volume).toFixed(2),
      priceChangePercent: data.priceChangePercent + "%",
    };
  } catch (err) {
    console.error(`Light fetch failed for ${symbol}`);
    return null;
  }
}

async function analyzeWithAI(symbolData) {
  const prompt = `Symbol: ${symbolData.symbol}
Funding Rate: ${symbolData.fundingRate}
Volume: ${symbolData.volume}
24h Change: ${symbolData.priceChangePercent}

Give a brief institutional insight:
- Confidence (0-100%)
- Risk (low/medium/high)
- Suggested action (long/short/avoid)`;

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "meta-llama/llama-4-maverick:free",
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data.choices[0].message.content;
}

function extractConfidenceScore(text) {
  const match = text.match(/(\d{1,3})\s*%/);
  return match ? parseInt(match[1]) : 0;
}

async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: msg,
    parse_mode: "Markdown"
  });
}

async function alreadyAnalyzed(symbol, date) {
  return await db.collection("signals").findOne({ symbol, date });
}

async function storeSignal(symbol, date, insight, score) {
  await db.collection("signals").insertOne({ symbol, date, insight, score });
}

(async () => {
  try {
    await client.connect();
    db = client.db("institutionalBot");

    const date = new Date().toISOString().split("T")[0];
    const symbols = await fetchSymbols();
    const startIndex = Math.floor(Math.random() * (symbols.length - 10));
    const batch = symbols.slice(startIndex, startIndex + 10);

    for (const symbol of batch) {
      if (await alreadyAnalyzed(symbol, date)) {
        console.log(`Skipped ${symbol} (already analyzed)`);
        continue;
      }

      const data = await fetchLightMetrics(symbol);
      if (!data) continue;

      const insight = await analyzeWithAI(data);
      const score = extractConfidenceScore(insight);

      console.log(`\n${symbol} Insight [${score}%]:\n${insight}`);

      if (score >= 85) {
        await sendTelegram(`🚨 *${symbol} Institutional Signal* 🚨\n${insight}`);
      }

      await storeSignal(symbol, date, insight, score);
      await sleep(3000); // Human-like delay
    }

    await client.close();
    console.log("Bot run completed safely.");
  } catch (err) {
    console.error("Critical error:", err.message);
    process.exit(1);
  }
})();
