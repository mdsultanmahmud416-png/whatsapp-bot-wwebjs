const moment = require("moment-timezone");
const { loadAccount, saveAccount } = require("./mongo/mongoUserAccounts");
const { loadChargeConfig, saveChargeConfig } = require("./mongo/mongoChargeConfig");
const { loadReminderConfig, saveReminderConfig } = require("./mongo/mongoReminderConfig");

// ===============================
// Helpers
// ===============================
function nowbdtime() {
  return moment().tz("Asia/Dhaka").format("DD/MM/YYYY hh:mm:ss A");
}

// ===============================
// Account Manager
// ===============================
class AccountManager {
  constructor() {
    this.chargeRates = {};
    this.reminderConfig = {};
  }

  // 🔹 INIT (startup এ একবারই কল হবে)
  async init() {
    this.chargeRates = await loadChargeConfig();
    this.reminderConfig = (await loadReminderConfig()) || {
      dueMessageTemplate: "📢 প্রিয় {role},\nআপনার ৳{due} বকেয়া রয়েছে।\nঅনুগ্রহ করে বকেয়া পরিশোধ করুন।\n\n🄽🄾🅃🄴: প্রতিদিন এর বিল প্রতিদিন ক্লিয়ার করুন। সুসম্পর্ক বজায় রাখুন।\n\n💳পেমেন্ট নম্বর:\nনগদ পারসোনালঃ 01777283248\nবিকাশ পারসোনালঃ 01777283248\nরকেট এজেন্টঃ 018254790904\n\nনোটিশঃ ভুলক্রমে কেউ অন্য নাম্বার বা রিচার্জ করলে সম্পূর্ণ দায়ভার আপনার।\n\nকাজের আপডেট গ্রুপের লিংক:\n\n🕋 যে অন্যের হক নষ্ট করে সে ঈমানদার নয়,বান্দাহর হক আল্লাহ ক্ষমা করবেন না🕋\n\n👏👏👏বিল ক্লিয়ার করে রশিদ বা স্কিনশট দিবেন💝💝🙏🙏"
    };

    console.log("✅ AccountManager initialized from MongoDB");
  }

  // ===========================
  // ⚙️ Charge Config
  // ===========================
  async setChargeRate(role, autoCharge) {
    this.chargeRates[role] = { autoCharge };
    await saveChargeConfig(this.chargeRates);
    return { success: true, role };
  }

  async addChargeRate(role, autoCharge) {
    if (this.chargeRates[role]) {
      return { success: false, message: "Role already exists" };
    }
    this.chargeRates[role] = { autoCharge };
    await saveChargeConfig(this.chargeRates);
    return { success: true, role };
  }

  // ===========================
  // 👤 Role
  // ===========================
  async setRole(number, role) {
    const acc = await loadAccount(number);
    acc.role = role;
    await saveAccount(acc);
    return acc;
  }

  // ===========================
  // 💰 Deposit
  // ===========================
  async deposit(number, amount, reason = "Deposit") {
    const acc = await loadAccount(number);

    acc.balance += amount;

    if (acc.due > 0) {
      const pay = Math.min(acc.due, acc.balance);
      acc.due -= pay;
      acc.balance -= pay;
      acc.history.push({
        type: "due_clear",
        amount: pay,
        timestamp: nowbdtime()
      });
    }

    acc.history.push({
      type: "deposit",
      amount,
      reason,
      timestamp: nowbdtime()
    });

    await saveAccount(acc);
    return acc;
  }

  // ===========================
  // 🔴 Manual Charge
  // ===========================
  async mcharge(number, amount, reason = "Manual Charge") {
    const acc = await loadAccount(number);

    if (acc.balance >= amount) {
      acc.balance -= amount;
    } else {
      acc.due += amount - acc.balance;
      acc.balance = 0;
    }

    acc.history.push({
      type: "manualCharge",
      amount,
      reason,
      timestamp: nowbdtime()
    });

    await saveAccount(acc);
    return acc;
  }

  // ===========================
  // ⚡ Auto Charge
  // ===========================
  async charge(number, role, orderTag, reason = "Auto Charge") {
    const acc = await loadAccount(number);

    const rate =
      this.chargeRates[orderTag]?.autoCharge ||
      this.chargeRates.default?.autoCharge ||
      0;

    if (rate > 0) {
      if (acc.balance >= rate) {
        acc.balance -= rate;
      } else {
        acc.due += rate - acc.balance;
        acc.balance = 0;
      }

      acc.history.push({
        type: "charge",
        amount: rate,
        role,
        orderTag,
        reason,
        timestamp: nowbdtime()
      });
    }

    await saveAccount(acc);
    return acc;
  }

  // ===========================
  // 🟢 Refund
  // ===========================
  async refund(number, amount, reason = "Refund") {
    const acc = await loadAccount(number);

    if (acc.due > 0) {
      const reduce = Math.min(acc.due, amount);
      acc.due -= reduce;
      acc.balance += amount - reduce;
    } else {
      acc.balance += amount;
    }

    acc.history.push({
      type: "refund",
      amount,
      reason,
      timestamp: nowbdtime()
    });

    await saveAccount(acc);
    return acc;
  }

  // ===========================
  // 📊 Summary
  // ===========================
  async getSummary(number) {
    const acc = await loadAccount(number);
    return {
      number: acc.number,
      role: acc.role,
      balance: acc.balance,
      due: acc.due
    };
  }

  // ===========================
  // 💬 Due Reminder
  // ===========================
  async sendDueReminder(client) {
    const { Account } = require("./mongo/models/Account");
    const users = await Account.find({ due: { $gt: 0 } }).lean();

    for (const u of users) {
      const msg = this.reminderConfig.dueMessageTemplate
        .replace("{role}", u.role)
        .replace("{due}", u.due);

      await client.sendMessage(`${u.number}@c.us`, msg);
    }

    return users.length;
  }
}

// ===============================
module.exports = {
  accountManager: new AccountManager()
};
