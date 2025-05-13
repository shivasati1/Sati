// openInterest.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
const DB_NAME = "binance_fundamentals";
const COLLECTION = "openInterest";

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

async function fetchOpenInterest(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
  const res = await axios.get(url);
  return parseFloat(res.data.openInterest);
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

      const oi = await fetchOpenInterest(symbol);
      await collection.insertOne({
        symbol,
        openInterest: oi,
        date: timestamp,
        createdAt: new Date()
      });
      console.log(`Saved open interest for ${symbol}: ${oi}`);

      await sleep(6000);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
})();
