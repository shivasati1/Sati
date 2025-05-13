// aiInsightSender.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DB_NAME = "binance_fundamentals";
const INSIGHT_COLLECTION = "insights";

const client = new MongoClient(MONGO_URI);

async function fetchLatestMetric(collectionName, symbol) {
  const db = client.db(DB_NAME);
  const collection = db.collection(collectionName);
  const date = new Date().toISOString().split("T")[0];
  return await collection.findOne({ symbol, date });
}

function extractConfidenceScore(insight) {
  const match = insight.match(/(\d{1,3})\s*%/);
  if (!match) return 0;
  const score = parseInt(match[1]);
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

async function getInsightFromAI(prompt) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "meta-llama/llama-4-maverick:free",
      messages: [{ role: "user", content: prompt }]
    },
    {
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
}

async function generateAndSendInsights() {
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const insightColl = db.collection(INSIGHT_COLLECTION);

    const symbols = await db.collection("cvd").distinct("symbol");

    for (const symbol of symbols) {
      const date = new Date().toISOString().split("T")[0];

      const exists = await insightColl.findOne({ symbol, date });
      if (exists) {
        console.log(`Insight already exists for ${symbol}, skipping...`);
        continue;
      }

      const funding = await fetchLatestMetric("funding_rate", symbol);
      const oi = await fetchLatestMetric("open_interest", symbol);
      const lsr = await fetchLatestMetric("long_short_ratio", symbol);
      const tbsr = await fetchLatestMetric("taker_buy_sell_ratio", symbol);
      const obi = await fetchLatestMetric("order_book_imbalance", symbol);
      const cvd = await fetchLatestMetric("cvd", symbol);

      if (!funding || !oi || !lsr || !tbsr || !obi || !cvd) {
        console.log(`Incomplete data for ${symbol}, skipping...`);
        continue;
      }

      const prompt = `Symbol: ${symbol}
Funding Rate: ${funding.rate}
Open Interest: ${oi.openInterest}
Long/Short Ratio: ${lsr.longShortRatio}
Taker Buy/Sell Ratio: ${tbsr.buySellRatio}
Order Book Imbalance: ${obi.imbalance}
CVD: ${cvd.summary}

As an institutional trader, provide a professional-grade insight with:
- Market Bias (bullish or bearish)
- Confidence Score (0–100%)
- Risk Level (Low/Medium/High)
- Recommended Action (Long / Short / Avoid)
Justify briefly.`;

      const aiInsight = await getInsightFromAI(prompt);
      const score = extractConfidenceScore(aiInsight);

      console.log(`AI Insight for ${symbol} [${score}%]: ${aiInsight}`);

      await insightColl.insertOne({
        symbol,
        date,
        score,
        insight: aiInsight,
        createdAt: new Date()
      });

      if (score >= 85) {
        await sendTelegram(`🚨 *${symbol} Institutional Insight* 🚨\n${aiInsight}`);
        console.log(`Telegram alert sent for ${symbol}`);
      }

      await new Promise(resolve => setTimeout(resolve, 6000));
    }

    console.log("AI insight generation complete.");
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
}

generateAndSendInsights();
  
