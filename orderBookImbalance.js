// orderBookImbalance.js
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
const DB_NAME = "binance_fundamentals";
const COLLECTION = "orderBookImbalance";

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

async function fetchOrderBookImbalance(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`;
  const res = await axios.get(url);

  const bids = res.data.bids.map(b => parseFloat(b[1]));
  const asks = res.data.asks.map(a => parseFloat(a[1]));

  const bidVolume = bids.reduce((a, b) => a + b, 0);
  const askVolume = asks.reduce((a, b) => a + b, 0);

  const imbalance = bidVolume - askVolume;
  const summary = imbalance > 0 ? "Strong Buy Wall"
                : imbalance < 0 ? "Strong Sell Wall"
                : "Balanced";

  return {
    bidVolume,
    askVolume,
    imbalance,
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

      const result = await fetchOrderBookImbalance(symbol);
      await collection.insertOne({
        symbol,
        ...result,
        date: timestamp,
        createdAt: new Date()
      });

      console.log(`Saved Order Book Imbalance for ${symbol}: ${result.summary}`);
      await sleep(6000);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await client.close();
  }
})();
