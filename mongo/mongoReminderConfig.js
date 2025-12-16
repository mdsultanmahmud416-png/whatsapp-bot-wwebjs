const Config = require("./models/Config");

async function loadReminderConfig() {
  const doc = await Config.findOne({ key: "reminderConfig" }).lean();
  return doc?.value || null;
}

async function saveReminderConfig(value) {
  await Config.updateOne(
    { key: "reminderConfig" },
    { value, updatedAt: new Date() },
    { upsert: true }
  );
}

module.exports = {
  loadReminderConfig,
  saveReminderConfig
};
