// dashboard.js
const express = require('express');
const { MongoClient } = require('mongodb');
const ejs = require('ejs');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "binance_fundamentals";
const INSIGHT_COLLECTION = "insights";

const client = new MongoClient(MONGO_URI);
const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));

async function getHighConfidenceSymbols() {
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const insightColl = db.collection(INSIGHT_COLLECTION);

    const today = new Date().toISOString().split('T')[0];
    const highConfidenceInsights = await insightColl.find({
      date: today,
      score: { $gte: 85 }
    }).toArray();

    return highConfidenceInsights;
  } catch (err) {
    console.error('Error fetching high-confidence symbols:', err);
    return [];
  } finally {
    await client.close();
  }
}

app.get('/', async (req, res) => {
  const highConfidenceSymbols = await getHighConfidenceSymbols();
  res.render('dashboard', { symbols: highConfidenceSymbols });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
