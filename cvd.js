// cvd.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
const DB_NAME = "binance_fundamentals";
const COLLECTION = "cvd";

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

async function fetchCVD(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=1000`;
  const res = await axios.get(url);
  const trades = res.data;

  let cvd = 0;
  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {
    const qty = parseFloat(trade.qty);
    if (!trade.isBuyerMaker) {
      cvd += qty;
      buyVolume += qty;
    } else {
      cvd -= qty;
      sellVolume += qty;
    }
  }

  const summary = cvd > 0 ? "Showing hidden buying"
                : cvd < 0 ? "Showing hidden selling"
                : "Neutral CVD";

  return {
    cvd,
    buyVolume,
    sellVolume,
    summary
  };
}

(async () => {
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION);

    const symbols = await fetchSymbols();
    for (const symbol of symbols) {
      const timestamp = new Date().toISOString().split("T")[0];
      const exists = await collection.findOne({ symbol, date: timestamp });
      if (exists) {
        console.log(`Already fetched ${symbol} for ${timestamp}, skipping...`);
        continue;
      }

      const result = await fetchCVD(symbol);
      await collection.insertOne({
        symbol,
        ...result,
        date: timestamp,
        createdAt: new Date()
      });

      console.log(`Saved CVD for ${symbol}: ${result.summary}`);
      await sleep(6000);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
})();
