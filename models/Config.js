// ConfigSchema বা models Config => Config folder 
const mongoose = require("mongoose");

const ConfigSchema = new mongoose.Schema(
  {
  key: { type: String, unique: true },
  value: Object,
  updatedAt: { type: Date, default: Date.now }
},
  {
    collection: "Config" // 👈 EXACT collection name
  }
);

module.exports = mongoose.models.Config ||
  mongoose.model("Config", ConfigSchema);

