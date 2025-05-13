// fundingRate.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
const DB_NAME = "binance_fundamentals";
const COLLECTION = "fundingRate";

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
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
  const res = await axios.get(url);
  if (res.data.length > 0) return parseFloat(res.data[0].fundingRate);
  return null;
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

      const rate = await fetchFundingRate(symbol);
      if (rate !== null) {
        await collection.insertOne({
          symbol,
          fundingRate: rate,
          date: timestamp,
          createdAt: new Date()
        });
        console.log(`Saved funding rate for ${symbol}: ${rate}`);
      } else {
        console.log(`No funding rate for ${symbol}`);
      }

      await sleep(6000);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
})();
