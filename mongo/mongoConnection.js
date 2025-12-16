const mongoose = require("mongoose");

let isConnected = false;

async function connectMongo() {
  if (isConnected) return;

  if (!process.env.MONGODB_URI) {
    throw new Error("❌ MONGODB_URI not set");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: "whatsapp_bot",
    serverSelectionTimeoutMS: 15000
  });

  isConnected = true;
  console.log("🟢 MongoDB connected");
}

module.exports = { connectMongo };
