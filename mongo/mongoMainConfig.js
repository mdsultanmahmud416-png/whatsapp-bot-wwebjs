// mongoConfig.js
const Config = require("./models/Config");

// 🔹 Load
async function loadMainConfigFromMongo() {
  const doc = await Config.findOne({ key: "mainConfig" }).lean();
  if (!doc || !doc.value) {
    throw new Error("mainConfig not found in MongoDB");
  }
  return doc.value;
}

// 🔹 Save
async function saveMainConfigToMongo(configObject) {
  await Config.updateOne(
    { key: "mainConfig" },
    {
      $set: {
        value: configObject,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

module.exports = {
  loadMainConfigFromMongo,
  saveMainConfigToMongo
};
