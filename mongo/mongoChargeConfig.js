const Config = require("../models/Config");

async function loadChargeConfig() {
  const doc = await Config.findOne({ key: "chargeConfig" }).lean();
  return doc?.value || {};
}

async function saveChargeConfig(value) {
  await Config.updateOne(
    { key: "chargeConfig" },
    { value, updatedAt: new Date() },
    { upsert: true }
  );
}

module.exports = {
  loadChargeConfig,
  saveChargeConfig
};
