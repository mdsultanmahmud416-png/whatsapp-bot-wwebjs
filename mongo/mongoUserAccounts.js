const moment = require("moment-timezone");
const Account = require("./models/UserAccounts");

function nowbdtime() {
  return moment().tz("Asia/Dhaka").format("DD/MM/YYYY hh:mm:ss A");
}

async function loadAccount(number) {

  let acc = await Account.findOne({ number }).lean();

  if (!acc) {
    acc = {
      number,
      role: "Customer",
      balance: 0,
      due: 0,
      createdAt: nowbdtime(),
      updatedAt: nowbdtime(),
      history: []
    };
    await Account.create(acc);
  }

  return acc;
}

async function saveAccount(acc) {

  acc.updatedAt = nowbdtime();

  await Account.updateOne(
    { number: acc.number },
    { $set: acc },
    { upsert: true }
  );
}

module.exports = {
  loadAccount,
  saveAccount
};
