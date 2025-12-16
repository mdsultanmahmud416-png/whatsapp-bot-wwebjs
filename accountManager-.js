const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");


// 🔧 ডেটা রাখার ফোল্ডার
const accountsDir = path.join(__dirname, "UserAccounts");
if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true });
const ConfigDir = path.join(__dirname, "Config");
if (!fs.existsSync(ConfigDir)) fs.mkdirSync(ConfigDir, { recursive: true });
const backupDir = path.join(__dirname, "backup");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });


// 🔧 chargeConfig লোড করা
const chargeConfigPath = path.join(ConfigDir, "chargeConfig.json");
let chargeConfig = {};
if (fs.existsSync(chargeConfigPath)) {
  chargeConfig = JSON.parse(fs.readFileSync(chargeConfigPath, "utf-8"));
} else {
  console.warn("⚠ chargeConfig.json ফাইল পাওয়া যায়নি! ডিফল্ট চার্জ ব্যবহার করা হবে।");
}
// ===========================
// 💾 Reminder Config Setup
// ===========================
const reminderConfigPath = path.join(ConfigDir, "reminderConfig.json");
// এখন reminderConfig লোড করো
let reminderConfig = {};
// যদি ফাইল না থাকে, তাহলে নতুন ফাইল তৈরি করবে
if (fs.existsSync(reminderConfigPath)) {
  reminderConfig = JSON.parse(fs.readFileSync(reminderConfigPath, "utf-8"));
} else {
  reminderConfig = {
    dueMessageTemplate: "📢 প্রিয় {role},\nআপনার ৳{due} বকেয়া রয়েছে।\nঅনুগ্রহ করে বকেয়া পরিশোধ করুন।\n\n🄽🄾🅃🄴: প্রতিদিন এর বিল প্রতিদিন ক্লিয়ার করুন। সুসম্পর্ক বজায় রাখুন।\n\n💳পেমেন্ট নম্বর:\nনগদ পারসোনালঃ 01777283248\nবিকাশ পারসোনালঃ 01777283248\nরকেট এজেন্টঃ 018254790904\n\nনোটিশঃ ভুলক্রমে কেউ অন্য নাম্বার বা রিচার্জ করলে সম্পূর্ণ দায়ভার আপনার।\n\nকাজের আপডেট গ্রুপের লিংক:\n\n🕋 যে অন্যের হক নষ্ট করে সে ঈমানদার নয়,বান্দাহর হক আল্লাহ ক্ষমা করবেন না🕋\n\n👏👏👏বিল ক্লিয়ার করে রশিদ বা স্কিনশট দিবেন💝💝🙏🙏"
  };
  fs.writeFileSync(reminderConfigPath, JSON.stringify(reminderConfig, null, 2));
}

// ===============================
// 🔹 Helper Functions
// ===============================
// 🇧🇩 বাংলাদেশ টাইমফরম্যাট "2025-11-02 11:41:15 PM"
function nowbdtime() {
  return moment().tz("Asia/Dhaka").format("DD/MM/YYYY hh:mm:ss A");
}

function getAccountPath(number) {
  return path.join(accountsDir, `${number}.json`);
}

function loadAccount(number) {
  const file = getAccountPath(number);
  if (!fs.existsSync(file)) {
    return {
      number,
      role: "Customer",
      balance: 0,
      due: 0,
      createdAt: nowbdtime(),
      updatedAt: nowbdtime(),
      history: [],
    };
  }
  return JSON.parse(fs.readFileSync(file));
}

function saveAccount(account) {
  // 🕒 শেষ 7 দিনের ট্রান্সাকশন রাখবে
  const threeDaysAgo = moment().tz("Asia/Dhaka").subtract(7, "days");

  // 🔹 পুরনো এন্ট্রি বাদ দাও (যেগুলোর timestamp 7 দিনের পুরোনো)
  account.history = account.history.filter(entry => {
    const entryTime = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A");
    return entryTime.isAfter(threeDaysAgo);
  });

  // 🔹 সর্বশেষ আপডেট টাইম সেট করো
  account.updatedAt = nowbdtime();

  // 🔹 ফাইল সেভ করো
  fs.writeFileSync(getAccountPath(account.number), JSON.stringify(account, null, 2));
}

/*
function saveAccount(account) {
  account.updatedAt = nowbdtime();
  fs.writeFileSync(getAccountPath(account.number), JSON.stringify(account, null, 2));
}
*/
// ===============================
// 🔹 Main AccountManager Class
// ===============================
class AccountManager {
  constructor() {
    this.chargeRates = chargeConfig; // chargeConfig.json থেকে লোড
  }
  /*
    // ⚙️ চার্জ আপডেট (রোল অনুযায়ী)
    setChargeRate(role, autoCharge) {
      this.chargeRates[role] = { autoCharge };
      fs.writeFileSync(chargeConfigPath, JSON.stringify(this.chargeRates, null, 2));
    }
  */

  setChargeRate(role, autoCharge) {
    // case-insensitive match
    const existingRole = Object.keys(this.chargeRates).find(
      r => r.toLowerCase() === role.toLowerCase()
    );

    if (existingRole) {
      this.chargeRates[existingRole].autoCharge = autoCharge;
      fs.writeFileSync(chargeConfigPath, JSON.stringify(this.chargeRates, null, 2));
      return { success: true, role: existingRole };
    } else {
      const existingRoles = Object.keys(this.chargeRates);
      return {
        success: false,
        role,
        existingRoles,
        message: `❌ Role "${role}" not found.\n` +
          `Existing roles: \n${existingRoles.join(",\n")}. \n\n` +
          `To add new role, \nuse: /setcharge add ${role} <value>\n`
      };
    }
  }

  // ⚙️ নতুন রোল যোগ
  addChargeRate(role, autoCharge) {
    // prevent duplicate (case-insensitive)
    const existingRole = Object.keys(this.chargeRates).find(
      r => r.toLowerCase() === role.toLowerCase()
    );

    if (existingRole) {
      return { success: false, message: `❌ Role "${existingRole}" already exists.` };
    }

    this.chargeRates[role] = { autoCharge };
    fs.writeFileSync(chargeConfigPath, JSON.stringify(this.chargeRates, null, 2));
    return { success: true, role };
  }
  // ⚙️চার্জ রোল পরিবর্তন
  setRole(number, role) {
    const acc = loadAccount(number);
    acc.role = role;
    saveAccount(acc);
    return acc;
  }

  // ===========================
  // 💰 জমা
  // ===========================
  deposit(number, amount, reason = "Deposit") {
    const acc = loadAccount(number);
    acc.balance += amount;
    if (acc.due > 0) {
      const payDue = Math.min(acc.due, acc.balance);
      acc.due -= payDue;
      acc.balance -= payDue;
      acc.history.push({
        type: "due_clear",
        amount: payDue,
        reason: "Auto clear due on deposit",
        timestamp: nowbdtime(),
      });
    }
    acc.history.push({
      type: "deposit",
      amount,
      reason,
      timestamp: nowbdtime(),
    });
    saveAccount(acc);
    return acc;
  }

  // ===========================
  // 🔴 ম্যানুয়াল charge
  // ===========================
  mcharge(number, amount = 0, reason = "Manual Charge") {
    const acc = loadAccount(number);

    if (amount <= 0) {
      throw new Error("manualCharge amount must be greater than 0");
    }

    if (acc.balance >= amount) {
      acc.balance -= amount;
    } else {
      const diff = amount - acc.balance;
      acc.balance = 0;
      acc.due += diff;
    }

    acc.history.push({
      type: "manualCharge",
      amount,
      reason,
      role: acc.role,
      timestamp: nowbdtime(),
    });

    saveAccount(acc);
    return acc;
  }

  // ===========================
  // 💸 Auto চার্জ (PDF Forward ইত্যাদি)
  // ===========================
  charge(number, role, orderTag, reason = "Auto Charge", OrderKey = "", Office_Number = "", Office_Type = "") {
    const acc = loadAccount(number);

    const rate =
      this.chargeRates[orderTag]?.autoCharge ||
      this.chargeRates.default?.autoCharge ||
      0;

    if (rate <= 0) return acc; // কোনো রেট না থাকলে কিছু করবে না

    if (acc.balance >= rate) {
      acc.balance -= rate;
    } else {
      const dueAdd = rate - acc.balance;
      acc.due += dueAdd;
      acc.balance = 0;
    }

    acc.history.push({
      type: "charge",
      amount: rate,
      role,
      orderTag,
      reason,
      OrderKey,
      Office_Number,
      Office_Type,
      timestamp: nowbdtime(),
    });

    saveAccount(acc);
    return acc;
  }

  // ===========================
  // 🟢 রিফান্ড
  // ===========================
  refund(number, amount, reason = "Refund", OrderKey = "", Office_Number = "", Office_Type = "") {
    const acc = loadAccount(number);

    if (acc.due > 0) {
      const reduceDue = Math.min(acc.due, amount);
      acc.due -= reduceDue;
      acc.balance += amount - reduceDue;
    } else {
      acc.balance += amount;
    }

    acc.history.push({
      type: "refund",
      amount,
      reason,
      OrderKey,
      Office_Number,
      Office_Type,
      timestamp: nowbdtime(),
    });

    saveAccount(acc);
    return acc;
  }


  // ===========================
  // 📅 দৈনিক রিপোর্ট পাঠানো admin/তারিখ /user all /8801777123456/তারিখ
  // ===========================
  sendDailyReport = async function (client, message, options = {}) {
    const { mode, number } = options;
    const files = fs.readdirSync(accountsDir);

    // ✅ নির্দিষ্ট তারিখ বা আজকের তারিখ
    // options.date যদি থাকে → validate যদি না থাকে আজকের তারিখ সেট করবে
    let targetDate;
    if (options.date) {
      const parsed = moment(options.date, "DD/MM/YYYY", true);
      if (!parsed.isValid()) {
        await message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
        return;
      }
      targetDate = parsed.tz("Asia/Dhaka");
    } else {
      // তারিখ না দিলে আজকের তারিখ
      targetDate = moment().tz("Asia/Dhaka");
    }

    const todayStart = targetDate.clone().startOf("day");
    const todayEnd = targetDate.clone().endOf("day");
    const dateLabel = targetDate.format("DD/MM/YYYY"); // ✅ রিপোর্ট তারিখ দেখানোর জন্য

    let totalUsers = 0;
    let totalAllWork = 0;
    let totalAllRefund = 0;
    let totalAllCharge = 0;
    let totalAllDeposit = 0;
    let totalAllDue = 0;

    let foundUser = false;   // 🔥 singleUser এর জন্য ফ্ল্যাগ
    let foundAnyReport = false; // 🔥 কোনো রিপোর্ট পাওয়া গেছে কি না


    // Header & Footer: লুপের বাইরে ডিক্লেয়ার করা হলো
    let headerMsg =
      `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
      `┃📊 *Daily User Report*\n` +
      `┃📅 *তারিখ: ${dateLabel}*\n`;

    // footer variable
    let footerMsg =
      `┃ ⏰ *Report Generate:*\n` +
      `┃ ${nowbdtime()}\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━┛\n`;

    for (const file of files) {
      const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));

      // 🔍 singleUser হলে — ইউজার খুঁজে পাওয়া চেক
      if (mode === "singleUser" && acc.number === number) {
        foundUser = true;
      }

      // ✅ যদি singleUser মোড হয় এবং নাম্বার না মেলে, স্কিপ করো
      if (mode === "singleUser" && acc.number !== number) continue;

      const todayHistory = acc.history.filter(entry => {
        const ts = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A");
        return ts.isBetween(todayStart, todayEnd, null, "[]");
      });

      if (todayHistory.length === 0) continue;

      foundAnyReport = true; // 🔥 রিপোর্ট পাওয়া গেছে

      let totalDeposit = 0;
      let totalAutoCharge = 0;
      let autoForwardCount = 0;

      let totalManualCharge = 0;
      let manualForwardCount = 0;

      let totalRefund = 0;
      let totalRefundCount = 0;

      todayHistory.forEach(entry => {
        switch (entry.type) {
          case "deposit": totalDeposit += entry.amount; break;
          case "charge": totalAutoCharge += entry.amount; autoForwardCount++; break;
          case "manualCharge": totalManualCharge += entry.amount; manualForwardCount++; break;
          case "refund": totalRefund += entry.amount; totalRefundCount++; break;
        }
      });

      const totalWorkCount = autoForwardCount + manualForwardCount;
      const effectiveAutoCount = (autoForwardCount - totalRefundCount) + manualForwardCount;

      const totalWorkCharge = totalAutoCharge + totalManualCharge;
      const effectiveCharge = (totalAutoCharge - totalRefund) + totalManualCharge;

      const previousDue = acc.due - effectiveCharge;
      const safePreviousDue = previousDue < 0 ? 0 : previousDue;

      // 🔹 Summaries যোগ করা
      totalAllWork += effectiveAutoCount;
      totalAllRefund += totalRefundCount;
      totalAllCharge += effectiveCharge;
      totalAllDeposit += totalDeposit;
      totalAllDue += acc.due;

      const previousDeposit = effectiveCharge - acc.due - totalDeposit;
      const safePreviousDeposit = previousDeposit < 0 ? 0 : previousDeposit;

      // ✅ রিপোর্ট বার্তা (তারিখ অনুযায়ী)
      const msg =
        `┃👤 *রোল:* ${acc.role}\n` +
        `┣━━━━━━━━━━━━━━━━━━━━┫\n` +
        `┃⚙️ *কাজের তথ্য*\n` +
        `┃ 🔹 মোট কাজ : ${totalWorkCount} টি\n` +
        `┃ 🔸 ব্যর্থ কাজ : ${totalRefundCount} টি\n` +
        `┃ 🟢 সফল কাজ : ${effectiveAutoCount} টি\n` +
        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
        `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
        `┃💸 *বিলের তথ্য*\n` +
        `┃ 🔹 মোট বিল : ৳${totalWorkCharge}\n` +
        `┃ 🔸 রিফান্ড : ৳${totalRefund}\n` +
        `┃ 💰 কার্যকর বিল : ৳${effectiveCharge}\n` +
        `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
        `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
        `┃🏦 *অ্যাকাউন্ট স্ট্যাটাস:*\n` +
        `┃ 🚨 আগের বকেয়া : ৳${safePreviousDue}\n` +
        `┃ 💰 আগের জমা : ৳${safePreviousDeposit}\n` +
        `┃ 🚨 মোট বকেয়া : ৳${acc.due}\n` +
        `┃ 💰 নতুন জমা : ৳${totalDeposit}\n` +
        `┃ 📊 বর্তমান ব্যালেন্স : ৳${acc.balance}\n` +
        `┣━━━━━━━━━━━━━━━━━━━━┫\n`
        ;



      // 📨 রিপোর্ট পাঠানো — শুধু তখনই পাঠাবে যদি adminOnly না হয়
      if (mode !== "adminOnly") {
        const fullMsg = headerMsg + msg + footerMsg; // header + officeMsg একত্র
        try {
          await client.sendMessage(`${acc.number}@c.us`, fullMsg);
          totalUsers++;

          // ✅ singleUser মোডে অ্যাডমিনকেও একই রিপোর্ট পাঠাবে
          if (mode === "singleUser") {
            await message.reply(`📤 ${acc.number} এর রিপোর্ট:\n\n${msg}`);
          }

        } catch (err) {
          console.error(`❌ ${acc.number} এ পাঠানো ব্যর্থ:`, err.message);
        }
      }
    }

    // 🔥 Case 1: singleUser কিন্তু ইউজার পাওয়া যায়নি
    if (mode === "singleUser" && !foundUser) {
      await message.reply("❌ উক্ত ইউজারকে পাওয়া যায়নি।");
      return;
    }

    // 🛑 Case 2: SingleUser মোডে ইউজার পেলেও রিপোর্ট না পেলে
    if (mode === "singleUser" && foundUser && !foundAnyReport) {
      await message.reply(`❌ *${dateLabel}* তারিখে ঐ ইউজারের কোনো রিপোর্ট পাওয়া যায়নি।`);
      return;
    }

    // 🔥 Case 3: কোনো রিপোর্ট নেই
    if (!foundAnyReport) {
      await message.reply(`❌ *${dateLabel}* তারিখে কোনো রিপোর্ট পাওয়া যায়নি।`);
      return;
    }



    // ✅ মোট সারসংক্ষেপ (তারিখসহ)
    const safeTotalDue = totalAllDue < 0 ? 0 : totalAllDue;
    const adminSummary =
      `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
      `┃ 📩 মোট রিপোর্ট পাঠানো: *${totalUsers} জনকে*\n` +
      `┃ 🧾 সফল কাজের সংখ্যা: *${totalAllWork} টি*\n` +
      `┃ ❌ ব্যর্থ কাজের সংখ্যা: *${totalAllRefund} টি*\n` +
      `┃ 💸 কার্যকর বিল: *৳${totalAllCharge}*\n` +
      `┃ 💰 মোট জমা: *৳${totalAllDeposit}*\n` +
      `┃ 🚨 মোট বকেয়া: *৳${safeTotalDue}*\n` +
      `┣━━━━━━━━━━━━━━━━━━━━━┫\n`;

    // 🧾 অ্যাডমিন সারসংক্ষেপ পাঠানো
    if (mode !== "singleUser" || mode === "adminOnly") {
      const fulladminSummary = headerMsg + adminSummary + footerMsg; // header + officeMsg একত্র
      try {
        await message.reply(fulladminSummary);
      } catch (err) {
        console.error("❌ অ্যাডমিন সারসংক্ষেপ পাঠাতে ব্যর্থ:", err.message);
      }
    }

    console.log(`✅ ${totalUsers} জনকে ${dateLabel} তারিখের দৈনিক রিপোর্ট পাঠানো হয়েছে।`);
    return totalUsers;
  };

  /*
   // ===========================
   // 📅 দৈনিক রিপোর্ট পাঠানো admin/তারিখ /user all /8801777123456/তারিখ
   // ===========================
   sendDailyReport = async function (client, message, options = {}) {
     // ------------------------
     // ✅ Mode & Number Setup
     // ------------------------
     let mode = options.mode ?? "allUser";  // default সব ইউজার
     const number = options.number ?? null;
 
     const files = fs.readdirSync(accountsDir);
 
     // ✅ নির্দিষ্ট তারিখ বা আজকের তারিখ
     const targetDate = options.date ? moment(options.date).tz("Asia/Dhaka") : moment().tz("Asia/Dhaka");
     const todayStart = targetDate.clone().startOf("day");
     const todayEnd = targetDate.clone().endOf("day");
     const dateLabel = targetDate.format("DD/MM/YYYY"); // রিপোর্টের জন্য
 
     let totalUsers = 0;
     let totalAllWork = 0;
     let totalAllRefund = 0;
     let totalAllCharge = 0;
     let totalAllDeposit = 0;
     let totalAllDue = 0;
 
     // ----- Header & Footer -----
     const headerMsg =
       `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
       `┃📊 *Daily User Report*\n` +
       `┃📅 *তারিখ: ${dateLabel}*\n`;
 
     const footerMsg =
       `┃ ⏰ *Report Generate:*\n` +
       `┃ ${nowbdtime()}\n` +
       `┗━━━━━━━━━━━━━━━━━━━━━┛\n`;
 
     for (const file of files) {
       const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));
 
       // ✅ singleUser মোডে নাম্বার না মিলে skip
       if (mode === "singleUser" && acc.number !== number) continue;
 
       const todayHistory = acc.history.filter(entry => {
         const ts = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A");
         return ts.isBetween(todayStart, todayEnd, null, "[]");
       });
 
       if (todayHistory.length === 0) continue;
 
       let totalDeposit = 0;
       let totalAutoCharge = 0;
       let totalManualCharge = 0;
       let totalRefund = 0;
       let totalRefundCount = 0;
 
       todayHistory.forEach(entry => {
         switch (entry.type) {
           case "deposit": totalDeposit += entry.amount; break;
           case "charge": totalAutoCharge += entry.amount; break;
           case "manualCharge": totalManualCharge += entry.amount; break;
           case "refund": totalRefund += entry.amount; totalRefundCount++; break;
         }
       });
 
       const autoForwardCount = todayHistory.filter(e => e.type === "charge").length;
       const manualForwardCount = todayHistory.filter(e => e.type === "manualCharge").length;
 
       const effectiveAutoCount = autoForwardCount - totalRefundCount;
       const totalWorkCount = effectiveAutoCount + manualForwardCount;
 
       const effectiveCharge = totalAutoCharge + totalManualCharge;
       const totalWorkCharge = effectiveCharge - totalRefund;
       const previousDue = acc.due - totalWorkCharge;
       const safePreviousDue = previousDue < 0 ? 0 : previousDue;
 
       // 🔹 Summaries যোগ করা
       totalAllWork += totalWorkCount;
       totalAllRefund += totalRefundCount;
       totalAllCharge += totalWorkCharge;
       totalAllDeposit += totalDeposit;
       totalAllDue += acc.due;
 
       const previousDeposit = totalWorkCharge - acc.due - totalDeposit;
       const safePreviousDeposit = previousDeposit < 0 ? 0 : previousDeposit;
 
       // ✅ রিপোর্ট বার্তা
       const msg =
         `┃👤 *রোল:* ${acc.role}\n` +
         `┣━━━━━━━━━━━━━━━━━━━━┫\n` +
         `┃⚙️ *কাজের তথ্য*\n` +
         `┃ 🔹 মোট কাজ : ${autoForwardCount + manualForwardCount} টি\n` +
         `┃ 🔸 ব্যর্থ কাজ : ${totalRefundCount} টি\n` +
         `┃ 🟢 সফল কাজ : ${totalWorkCount} টি\n` +
         `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
         `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
         `┃💸 *বিলের তথ্য*\n` +
         `┃ 🔹 মোট বিল : ৳${effectiveCharge}\n` +
         `┃ 🔸 রিফান্ড : ৳${totalRefund}\n` +
         `┃ 💰 কার্যকর বিল : ৳${totalWorkCharge}\n` +
         `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
         `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
         `┃🏦 *অ্যাকাউন্ট স্ট্যাটাস:*\n` +
         `┃ 🚨 আগের বকেয়া : ৳${safePreviousDue}\n` +
         `┃ 💰 আগের জমা : ৳${safePreviousDeposit}\n` +
         `┃ 🚨 মোট বকেয়া : ৳${acc.due}\n` +
         `┃ 💰 নতুন জমা : ৳${totalDeposit}\n` +
         `┃ 📊 বর্তমান ব্যালেন্স : ৳${acc.balance}\n` +
         `┣━━━━━━━━━━━━━━━━━━━━┫\n`;
 
       // 📨 রিপোর্ট পাঠানো — শুধু user mode হলে
       if (mode !== "adminOnly") {
         const fullMsg = headerMsg + msg + footerMsg;
         try {
           await client.sendMessage(`${acc.number}@c.us`, fullMsg);
           totalUsers++;
 
           // ✅ singleUser মোডে admin reply
           if (mode === "singleUser") {
             await message.reply(`📤 ${acc.number} এর রিপোর্ট:\n\n${msg}`);
           }
         } catch (err) {
           console.error(`❌ ${acc.number} এ পাঠানো ব্যর্থ:`, err.message);
         }
       }
     }
 
     // ✅ অ্যাডমিন সারসংক্ষেপ
     const safeTotalDue = totalAllDue < 0 ? 0 : totalAllDue;
     const adminSummary =
       `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
       `┃ 📩 মোট রিপোর্ট পাঠানো: *${totalUsers} জনকে*\n` +
       `┃ 🧾 সফল কাজের সংখ্যা: *${totalAllWork} টি*\n` +
       `┃ ❌ ব্যর্থ কাজের সংখ্যা: *${totalAllRefund} টি*\n` +
       `┃ 💸 কার্যকর বিল: *৳${totalAllCharge}*\n` +
       `┃ 💰 মোট জমা: *৳${totalAllDeposit}*\n` +
       `┃ 🚨 মোট বকেয়া: *৳${safeTotalDue}*\n` +
       `┣━━━━━━━━━━━━━━━━━━━━━┫\n`;
 
     if (mode === "adminOnly" || mode !== "singleUser") {
       const fulladminSummary = headerMsg + adminSummary + footerMsg;
       try {
         await message.reply(fulladminSummary);
       } catch (err) {
         console.error("❌ অ্যাডমিন সারসংক্ষেপ পাঠাতে ব্যর্থ:", err.message);
       }
     }
 
     console.log(`✅ ${totalUsers} জনকে ${dateLabel} তারিখের দৈনিক রিপোর্ট পাঠানো হয়েছে।`);
     return totalUsers;
   };
 */
  /*
    // ===========================
    // 📅 দৈনিক রিপোর্ট পাঠানো: /dailyreport admin/তারিখ /user all /8801777123456/তারিখ
    // ===========================
    sendDailyReport = async function (client, message, options = {}) {
      const fs = require('fs');
      const path = require('path');
      const moment = require('moment-timezone');
  
      const nowbdtime = () => moment().tz("Asia/Dhaka").format("hh:mm:ss A"); // current time
  
      // ------------------------
      // ✅ Mode & Number Setup
      // ------------------------
      let mode = options.mode ?? "allUser";  // default: সব ইউজার
      const number = options.number ?? null;
  
      const files = fs.readdirSync(accountsDir);
  
      // ------------------------
      // ✅ তারিখ যাচাই ও সেট
      // ------------------------
      let targetDate;
      if (options.date) {
        targetDate = moment(options.date).tz("Asia/Dhaka");
        if (!targetDate.isValid()) {
          await message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
          return 0;
        }
      } else {
        targetDate = moment().tz("Asia/Dhaka"); // আজকের তারিখ
      }
  
      const todayStart = targetDate.clone().startOf("day");
      const todayEnd = targetDate.clone().endOf("day");
      const dateLabel = targetDate.format("DD/MM/YYYY");
  
      // ------------------------
      // ✅ Summary variables
      // ------------------------
      let totalUsers = 0;
      let totalAllWork = 0;
      let totalAllRefund = 0;
      let totalAllCharge = 0;
      let totalAllDeposit = 0;
      let totalAllDue = 0;
  
      // ----- Header & Footer -----
      const headerMsg =
        `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
        `┃📊 *Daily User Report*\n` +
        `┃📅 *তারিখ: ${dateLabel}*\n`;
  
      const footerMsg =
        `┃ ⏰ *Report Generate:*\n` +
        `┃ ${nowbdtime()}\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━┛\n`;
  
      // ------------------------
      // ✅ ইউজার রিপোর্ট লুপ
      // ------------------------
      for (const file of files) {
        const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));
  
        if (mode === "singleUser" && acc.number !== number) continue;
  
        const todayHistory = acc.history.filter(entry => {
          const ts = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A");
          return ts.isBetween(todayStart, todayEnd, null, "[]");
        });
  
        if (todayHistory.length === 0) continue;
  
        // ------------------------
        // ✅ হিসাব
        // ------------------------
        let totalDeposit = 0, totalAutoCharge = 0, totalManualCharge = 0;
        let totalRefund = 0, totalRefundCount = 0;
  
        todayHistory.forEach(entry => {
          switch (entry.type) {
            case "deposit": totalDeposit += entry.amount; break;
            case "charge": totalAutoCharge += entry.amount; break;
            case "manualCharge": totalManualCharge += entry.amount; break;
            case "refund": totalRefund += entry.amount; totalRefundCount++; break;
          }
        });
  
        const autoForwardCount = todayHistory.filter(e => e.type === "charge").length;
        const manualForwardCount = todayHistory.filter(e => e.type === "manualCharge").length;
  
        const effectiveAutoCount = autoForwardCount - totalRefundCount;
        const totalWorkCount = effectiveAutoCount + manualForwardCount;
  
        const effectiveCharge = totalAutoCharge + totalManualCharge;
        const totalWorkCharge = effectiveCharge - totalRefund;
        const previousDue = acc.due - totalWorkCharge;
        const safePreviousDue = previousDue < 0 ? 0 : previousDue;
  
        totalAllWork += totalWorkCount;
        totalAllRefund += totalRefundCount;
        totalAllCharge += totalWorkCharge;
        totalAllDeposit += totalDeposit;
        totalAllDue += acc.due;
  
        const previousDeposit = totalWorkCharge - acc.due - totalDeposit;
        const safePreviousDeposit = previousDeposit < 0 ? 0 : previousDeposit;
  
        // ------------------------
        // ✅ রিপোর্ট বার্তা
        // ------------------------
        const msg =
          `┃👤 *রোল:* ${acc.role}\n` +
          `┣━━━━━━━━━━━━━━━━━━━━┫\n` +
          `┃⚙️ *কাজের তথ্য*\n` +
          `┃ 🔹 মোট কাজ : ${autoForwardCount + manualForwardCount} টি\n` +
          `┃ 🔸 ব্যর্থ কাজ : ${totalRefundCount} টি\n` +
          `┃ 🟢 সফল কাজ : ${totalWorkCount} টি\n` +
          `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
          `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
          `┃💸 *বিলের তথ্য*\n` +
          `┃ 🔹 মোট বিল : ৳${effectiveCharge}\n` +
          `┃ 🔸 রিফান্ড : ৳${totalRefund}\n` +
          `┃ 💰 কার্যকর বিল : ৳${totalWorkCharge}\n` +
          `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
          `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
          `┃🏦 *অ্যাকাউন্ট স্ট্যাটাস:*\n` +
          `┃ 🚨 আগের বকেয়া : ৳${safePreviousDue}\n` +
          `┃ 💰 আগের জমা : ৳${safePreviousDeposit}\n` +
          `┃ 🚨 মোট বকেয়া : ৳${acc.due}\n` +
          `┃ 💰 নতুন জমা : ৳${totalDeposit}\n` +
          `┃ 📊 বর্তমান ব্যালেন্স : ৳${acc.balance}\n` +
          `┣━━━━━━━━━━━━━━━━━━━━┫\n`;
  
        // ------------------------
        // 📨 ইউজার রিপোর্ট
        // ------------------------
        if (mode === "allUser" || mode === "singleUser") {
          const fullMsg = headerMsg + msg + footerMsg;
          try {
            await client.sendMessage(`${acc.number}@c.us`, fullMsg);
            totalUsers++;
  
            if (mode === "singleUser") {
              const fullMsg = headerMsg + msg + footerMsg; // header + body + footer
              await message.reply(`📤 ${acc.number} এর রিপোর্ট:\n\n` + fullMsg);
            }
  
            // if (mode === "singleUser") {
            //  await message.reply(`📤 ${acc.number} এর রিপোর্ট:\n\n${msg}`);
            //  }        
  
          } catch (err) {
            console.error(`❌ ${acc.number} এ পাঠানো ব্যর্থ:`, err.message);
          }
        }
      }
  
      // ------------------------
      // 🧾 অ্যাডমিন সারসংক্ষেপ
      // ------------------------
      const safeTotalDue = totalAllDue < 0 ? 0 : totalAllDue;
      const adminSummary =
        `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
        `┃ 📩 মোট রিপোর্ট পাঠানো: *${totalUsers} জনকে*\n` +
        `┃ 🧾 সফল কাজের সংখ্যা: *${totalAllWork} টি*\n` +
        `┃ ❌ ব্যর্থ কাজের সংখ্যা: *${totalAllRefund} টি*\n` +
        `┃ 💸 কার্যকর বিল: *৳${totalAllCharge}*\n` +
        `┃ 💰 মোট জমা: *৳${totalAllDeposit}*\n` +
        `┃ 🚨 মোট বকেয়া: *৳${safeTotalDue}*\n` +
        `┣━━━━━━━━━━━━━━━━━━━━━┫\n`;
  
      if (mode === "adminOnly" || mode === "allUser") {
        const fulladminSummary = headerMsg + adminSummary + footerMsg;
        try {
          await message.reply(fulladminSummary);
        } catch (err) {
          console.error("❌ অ্যাডমিন সারসংক্ষেপ পাঠাতে ব্যর্থ:", err.message);
        }
      }
  
      console.log(`✅ ${totalUsers} জনকে ${dateLabel} তারিখের দৈনিক রিপোর্ট পাঠানো হয়েছে।`);
      return totalUsers;
    };
  */
  /*
   // ===============================
   // 📅 FINAL Daily Report System
   // ===============================
   sendDailyReport = async function (client, message, options = {}) {
     const fs = require("fs");
     const path = require("path");
     const moment = require("moment-timezone");
 
     const nowbdtime = () => moment().tz("Asia/Dhaka").format("hh:mm:ss A");
     const accounts = fs.readdirSync(accountsDir);
 
     // ----------------------------------------------------
     // 1️⃣ MODE সেটআপ (Final Rules অনুযায়ী)
     // ----------------------------------------------------
     const mode = options.mode ?? "adminOnly"; // default: adminOnly
     const number = options.number ?? null;
 
     // ----------------------------------------------------
     // 2️⃣ তারিখ সেটাপ
     // ----------------------------------------------------
     const targetDate = options.date
       ? moment(options.date).tz("Asia/Dhaka")
       : moment().tz("Asia/Dhaka"); // default আজকের তারিখ
 
     if (!targetDate.isValid()) {
       await message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
       return;
     }
 
     const todayStart = targetDate.clone().startOf("day");
     const todayEnd = targetDate.clone().endOf("day");
     const dateLabel = targetDate.format("DD/MM/YYYY");
 
     // ----------------------------------------------------
     // 3️⃣ Summary কাউন্টার
     // ----------------------------------------------------
     let totalUsers = 0;
     let totalWork = 0;
     let totalRefund = 0;
     let totalCharge = 0;
     let totalDeposit = 0;
     let totalDue = 0;
 
     // ----------------------------------------------------
     // HEADER / FOOTER
     // ----------------------------------------------------
     const header =
       `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
       `┃📊 *Daily Report*\n` +
       `┃📅 তারিখ: *${dateLabel}*\n`;
 
     const footer =
       `┃⏰ Generate: ${nowbdtime()}\n` +
       `┗━━━━━━━━━━━━━━━━━━━━━┛\n`;
 
     // ----------------------------------------------------
     // 4️⃣ Helper → ইউজারের আজকের হিসাব বের করা
     // ----------------------------------------------------
     function getTodayStats(acc) {
       const history = acc.history.filter(h => {
         const t = moment(h.timestamp, "DD/MM/YYYY hh:mm:ss A");
         return t.isBetween(todayStart, todayEnd, null, "[]");
       });
 
       if (history.length === 0) return null;
 
       let deposit = 0, autoCharge = 0, manualCharge = 0, refund = 0, refundCount = 0;
 
       history.forEach(h => {
         if (h.type === "deposit") deposit += h.amount;
         if (h.type === "charge") autoCharge += h.amount;
         if (h.type === "manualCharge") manualCharge += h.amount;
         if (h.type === "refund") { refund += h.amount; refundCount++; }
       });
 
       const autoCount = history.filter(h => h.type === "charge").length;
       const manualCount = history.filter(h => h.type === "manualCharge").length;
 
       const workCount = (autoCount - refundCount) + manualCount;
       const effectiveCharge = autoCharge + manualCharge - refund;
 
       return {
         workCount,
         autoCount,
         manualCount,
         refundCount,
         refund,
         deposit,
         effectiveCharge
       };
     }
 
     // ----------------------------------------------------
     // 5️⃣ Helper → ইউজার রিপোর্ট টেক্সট
     // ----------------------------------------------------
     function buildUserReport(acc, s) {
       return (
         `┃👤 *Role:* ${acc.role}\n` +
         `┣━━━━━━━━━━━━━━━━━━━━┫\n` +
         `┃⚙️ *Work Info*\n` +
         `┃ 🔹 মোট কাজ: ${s.autoCount + s.manualCount} টি\n` +
         `┃ 🔸 ব্যর্থ কাজ: ${s.refundCount} টি\n` +
         `┃ 🟢 সফল কাজ: ${s.workCount} টি\n` +
         `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
         `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
         `┃💸 *Billing Info*\n` +
         `┃ 🔹 মোট বিল: ৳${s.autoCount + s.manualCount}\n` +
         `┃ 🔸 রিফান্ড: ৳${s.refund}\n` +
         `┃ 💰 কার্যকর বিল: ৳${s.effectiveCharge}\n` +
         `┗━━━━━━━━━━━━━━━━━━━━┛\n` +
         `┏━━━━━━━━━━━━━━━━━━━━┓\n` +
         `┃🏦 *Account Status*\n` +
         `┃ 🚨 মোট বকেয়া: ৳${acc.due}\n` +
         `┃ 💰 আজকের জমা: ৳${s.deposit}\n` +
         `┃ 📊 ব্যালেন্স: ৳${acc.balance}\n` +
         `┣━━━━━━━━━━━━━━━━━━━━┫\n`
       );
     }
 
     // ----------------------------------------------------
     // 6️⃣ MODE অনুযায়ী ইউজার লুপ চালানো হবে কিনা
     // ----------------------------------------------------
     const shouldProcessUsers = (mode === "allUser" || mode === "singleUser");
 
     // ----------------------------------------------------
     // 7️⃣ ইউজার রিপোর্ট প্রসেসিং
     // ----------------------------------------------------
     if (shouldProcessUsers) {
       for (const file of accounts) {
         const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));
 
         // singleUser হলে অন্যদের skip
         if (mode === "singleUser" && acc.number !== number) continue;
 
         const stats = getTodayStats(acc);
         if (!stats) continue;
 
         // summary accumulate
         totalUsers++;
         totalWork += stats.workCount;
         totalRefund += stats.refundCount;
         totalCharge += stats.effectiveCharge;
         totalDeposit += stats.deposit;
         totalDue += acc.due;
 
         const report = header + buildUserReport(acc, stats) + footer;
 
         // send to user inbox
         await client.sendMessage(`${acc.number}@c.us`, report);
 
         // If singleUser → send report to admin too
         // if (mode === "singleUser") {
         //   await message.reply(`📤 ${acc.number} এর রিপোর্ট:\n\n${report}`);
         // }
 
       }
     }
 
     // ----------------------------------------------------
     // 8️⃣ অ্যাডমিন সারসংক্ষেপ (adminOnly + allUser + singleUser)
     // ----------------------------------------------------
     const adminSummary =
       `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
       `┃ 📩 মোট রিপোর্ট: *${totalUsers} জন*\n` +
       `┃ 🧾 সফল কাজ: *${totalWork} টি*\n` +
       `┃ ❌ ব্যর্থ কাজ: *${totalRefund} টি*\n` +
       `┃ 💸 কার্যকর বিল: *৳${totalCharge}*\n` +
       `┃ 💰 জমা: *৳${totalDeposit}*\n` +
       `┃ 🚨 মোট বকেয়া: *৳${totalDue}*\n` +
       `┣━━━━━━━━━━━━━━━━━━━━━┫\n`;
 
     const finalAdminText = header + adminSummary + footer;
 
     await message.reply(finalAdminText);
 
     return totalUsers;
   };
 */


  // ===========================
  // 📅 দৈনিক অফিস রিপোর্ট পাঠানো (Advanced: user + admin support)
  // ===========================
  sendOfficeReport = async function (client, message, options = {}) {
    const { mode, number: officeFilter } = options; // officeFilter = কমান্ডে থাকা Office_Number
    const files = fs.readdirSync(accountsDir);

    const targetDate = options.date ? moment(options.date, "DD/MM/YYYY").tz("Asia/Dhaka") : moment().tz("Asia/Dhaka");
    const todayStart = targetDate.clone().startOf("day");
    const todayEnd = targetDate.clone().endOf("day");
    const dateLabel = targetDate.format("DD/MM/YYYY");

    let totalUsers = 0;
    let consolidatedMsg =
      `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
      `┃📊 *Daily Office Report*\n` +
      `┃📅 *তারিখ: ${dateLabel}*\n`;

    // footer variable
    let footerMsg =
      `┃ ⏰ *Report Generate:*\n` +
      `┃ ${nowbdtime()}\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━┛\n\n`;


    let allOfficeEntries = [];

    for (const file of files) {
      const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));

      // প্রতিটি history filter
      const officeHistory = acc.history.filter(entry =>
        entry.Office_Type &&
        moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A").isBetween(todayStart, todayEnd, null, "[]") &&
        (!officeFilter || entry.Office_Number === officeFilter) // কমান্ডে নাম্বার থাকলে match
      );

      if (!officeHistory.length) continue;

      // ইউজারের নাম্বার attach
      officeHistory.forEach(e => e._userNumber = acc.number);

      allOfficeEntries.push(...officeHistory);
    }

    if (!allOfficeEntries.length) {
      consolidatedMsg += "📌 কোনো তথ্য পাওয়া যায়নি।\n";
    } else {
      // 🔹 সব entry একত্রে group
      const grouped = {};
      for (const entry of allOfficeEntries) {
        const key = `${entry.Office_Number}||${entry.Office_Type}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(entry);
      }

      for (const key in grouped) {
        const groupEntries = grouped[key];
        const officeNumber = groupEntries[0].Office_Number;
        const officeType = groupEntries[0].Office_Type;

        const totalChargeCount = groupEntries.filter(e => e.type === "charge").length;
        const totalRefundCount = groupEntries.filter(e => e.type === "refund").length;
        const successfulCount = totalChargeCount - totalRefundCount;

        const rate = this.chargeRates[officeType]?.autoCharge || 0;
        const effectiveBill = rate * successfulCount;

        const officeMsg =
          `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
          `┃ 📱 ${officeNumber}\n` +
          `┃ 🔖 *Type:* ${officeType}\n` +
          `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
          `┃ 🧾 *মোট কাজ:* ${totalChargeCount} টি\n` +
          `┃ ❌ *ব্যর্থ:* ${totalRefundCount} টি\n` +
          `┃ ✅ *সফল:* ${successfulCount} টি\n` +
          `┃ 💸 *কার্যকর বিল:* ৳${effectiveBill}\n` +
          `┣━━━━━━━━━━━━━━━━━━━━━┫\n`;

        // singleUser mode → শুধু ঐ Office_Number এর history ইউজারের কাছে পাঠানো
        if (mode === "singleUser") {
          const fullMsg = consolidatedMsg + officeMsg + footerMsg; // header + officeMsg একত্র
          try {
            await client.sendMessage(`${officeFilter}@c.us`, fullMsg);
            totalUsers++;
          } catch (err) {
            console.error(`❌ ${officeFilter} এ রিপোর্ট পাঠানো ব্যর্থ:`, err.message);
          }
        }

        consolidatedMsg += officeMsg + footerMsg;
      }
    }

    try {
      await message.reply(consolidatedMsg);
    } catch (err) {
      console.error("❌ অ্যাডমিনকে রিপোর্ট পাঠানো ব্যর্থ:", err.message);
    }

    console.log(`✅ ${totalUsers} জনকে Office রিপোর্ট পাঠানো হয়েছে।`);
  };

  // ===========================
  // 📊 Summary
  // ===========================
  getSummary(number) {
    const acc = loadAccount(number);
    return {
      number: acc.number,
      role: acc.role,
      balance: acc.balance,
      due: acc.due,
      lastTransaction: acc.history.length > 0 ? acc.history[acc.history.length - 1] : null,
    };
  }

  // ===========================
  // 📜 History
  // ===========================
  getHistory(number = null, date = null) {
    const files = fs.readdirSync(accountsDir);
    const targetDate = date ? moment(date, "DD/MM/YYYY") : moment().tz("Asia/Dhaka");
    const start = targetDate.clone().startOf("day");
    const end = targetDate.clone().endOf("day");
    const dateLabel = targetDate.format("DD/MM/YYYY");

    let allHistory = [];

    for (const file of files) {
      const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));
      if (number && acc.number !== number) continue;

      const filtered = acc.history.filter(entry => {
        const ts = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A");
        return ts.isBetween(start, end, null, "[]");
      });

      if (filtered.length === 0) continue;

      allHistory.push({
        number: acc.number,
        role: acc.role,
        history: filtered
      });
    }

    return { dateLabel, allHistory };
  }

  // ===========================
  // 🧾 Due List Report (Flexible Version)
  // ===========================
  getDueList({ asString = true } = {}) {
    const files = fs.readdirSync(accountsDir);
    let totalDue = 0;

    // List তৈরি করা হচ্ছে
    const list = files
      .map(file => {
        const acc = JSON.parse(fs.readFileSync(path.join(accountsDir, file)));
        if (acc.due > 0) {
          totalDue += acc.due;
          return {
            number: acc.number,
            fullRole: acc.role, // WhatsApp Reminder-এর জন্য
            shortRole: acc.role === "Pre_Customer" ? "Pre_Cus"
              : acc.role === "Customer" ? "Cus"
                : acc.role,
            due: acc.due
          };
        }
        return null;
      })
      .filter(Boolean); // Null বাদ দিচ্ছে

    if (!asString) return list;

    if (list.length === 0) {
      return `📋 *Due List Report:*\n\n✅ আজকের জন্য কোনো বকেয়া নেই!`;
    }

    const dateLabel = moment().tz("Asia/Dhaka").format("DD/MM/YYYY");

    const header =
      `┏━━━━━━━━━━━━━━━━━━━━━┓\n` +
      `┃ 📊 *Due List Report:*     \n` +
      `┃ 📅 *তারিখ: ${dateLabel}*\n` +
      `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
      `┃ 📋 নিচে বকেয়া তালিকা দেওয়া হলো:`;

    const body = list.map((item, i) =>
      `${i + 1}️. ${item.number} (${item.shortRole}) — ৳${item.due}`
    ).join("\n");

    const footer =
      `\n┃  *মোট বকেয়া: ৳${totalDue}*\n` +
      `┣━━━━━━━━━━━━━━━━━━━━━┫\n` +
      `┃⏰ *Report Generate:*\n` +
      `┃ ${nowbdtime()}\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━┛\n`;

    return header + "\n" + body + footer;
  }

  // ===========================
  // 💬 Due Reminder (WhatsApp)
  // ===========================
  async sendDueReminder(client) {
    // const dueList = this.getDueList();
    const dueList = this.getDueList({ asString: false }); // <-- MAIN FIX

    for (let i = 0; i < dueList.length; i++) {
      const u = dueList[i];
      // প্লেসহোল্ডার {role}, {due}, {sr} (serial)
      let msg = reminderConfig.dueMessageTemplate
        .replace("{role}", u.fullRole) // এখানে পূর্ণ Role ব্যবহার
        // .replace("{role}", u.role)
        .replace("{due}", u.due)
        .replace("{sr}", i + 1);
      await client.sendMessage(`${u.number}@c.us`, msg);
    }
    return dueList.length;
  }

  async checkOverdueDue(client, message) {
    try {
      const number = message.from.replace("@c.us", "");
      const acc = loadAccount(number);

      const todayStart = moment().tz("Asia/Dhaka").startOf("day");
      const todayEnd = moment().tz("Asia/Dhaka").endOf("day");

      // আজকের ইতিহাস ফিল্টার
      const todayHistory = acc.history.filter(entry => {
        const ts = moment(entry.timestamp, "DD/MM/YYYY hh:mm:ss A", true);
        return ts.isValid() && ts.isBetween(todayStart, todayEnd, null, "[]");
      });

      // আজকের চার্জ (charge + manualCharge)
      const todayCharge = todayHistory
        .filter(e => e.type === "charge" || e.type === "manualCharge")
        .reduce((sum, e) => sum + e.amount, 0);

      // আপনার ফর্মুলা অনুযায়ী:
      const previousDue = acc.due - todayCharge;

      // আগের দিনের due থাকলে ব্লক
      if (previousDue > 0) {
        await client.sendMessage(
          message.from,
          `⚠️ *আপনার পূর্বের বকেয়া রয়েছে*\nআপনার বকেয়া: *${previousDue}৳*\n\n` +
          `বকেয়া পরিশোধ না করা পর্যন্ত নতুন কাজ গ্রহন করা হবে না।\n\n` +
          `💳পেমেন্ট নম্বর:\n💵নগদ পারসোনালঃ 01777283248\n\n💸বিকাশ পারসোনালঃ 01777283248\n\n🚀রকেট এজেন্টঃ 018254790904\n\nনোটিশঃ ভুলক্রমে কেউ অন্য নাম্বার বা রিচার্জ করলে সম্পূর্ণ দায়ভার আপনার।\n\n👏👏👏বিল ক্লিয়ার করে রশিদ বা স্কিনশট দিবেন💝💝🙏🙏`
        );
        return true;
      }

      return false;

    } catch (error) {
      console.error("checkOverdueDue error:", error);
      return false;
    }
  }


  // ===========================
  // 📁 ব্যাকআপ
  // ===========================
  backup() {
    const backupDir = path.join(backupDir, "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    const stamp = nowbdtime().replace(/[:.]/g, "-");
    const dest = path.join(backupDir, `accounts_backup_${stamp}.zip`);
    const { execSync } = require("child_process");
    execSync(`zip -r "${dest}" "${accountsDir}"`);
    return dest;
  }
}

// ===============================
// 🧪 Self Test (run directly)
// ===============================
if (require.main === module) {
  const manager = new AccountManager();
  console.log("➡ Creating test account...");
  manager.deposit("8801000000000", 100, "Initial Deposit");
  manager.charge("8801000000000", "customer", "SignCopy PDF");
  manager.refund("8801000000000", 20, "Overcharge refund");
  manager.deduct("8801000000000", 30, "Manual adjust");
  console.log("✅ Summary:", manager.getSummary("8801000000000"));
  console.log("📜 History:", manager.getHistory("8801000000000"));
  console.log("💰 Due List:", manager.getDueList());
}

// ===============================
// 🔄 Export all in one
// ===============================
module.exports = {
  accountManager: new AccountManager(),
  reminderConfig,
  reminderConfigPath,
  chargeConfig,
  chargeConfigPath
};
