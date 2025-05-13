// longShortRatio.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
const DB_NAME = "binance_fundamentals";
const COLLECTION = "longShortRatio";

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

async function fetchLongShortRatio(symbol) {
  const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`;
  const res = await axios.get(url);
  if (res.data.length === 0) return null;
  return parseFloat(res.data[0].longShortRatio);
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

      const ratio = await fetchLongShortRatio(symbol);
      if (ratio === null) {
        console.log(`No long/short ratio for ${symbol}`);
        continue;
      }

      await collection.insertOne({
        symbol,
        longShortRatio: ratio,
        date: timestamp,
        createdAt: new Date()
      });
      console.log(`Saved long/short ratio for ${symbol}: ${ratio}`);

      await sleep(6000);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
})();
    
