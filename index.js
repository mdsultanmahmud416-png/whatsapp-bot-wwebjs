/**
 * Full WhatsApp Bot
 * - LocalAuth persistent session (QR একবার স্ক্যান করলেই সেভ হবে)
 * - config.json থেকে user management
 * - Pre_CustomerNumber ও CustomerNumber থেকে আগত মেসেজগুলো log করে OrderForward_Details_Log এ রাখে
 * - SignCopy/Bio/Birth/eTin অফিস থেকে PDF এলে PDF থেকে ফিল্ড বের করে OrderDelivery লোগে match করে MainCustomerNumber বের করে
 *   যদি সেই MainCustomerNumber Order_Rcvd_CustomerNumber তালিকায় থাকে — native forward করবে এবং OrderDelivery_Details_Log এ রেকর্ড রাখবে
 * - ডুপ্লিকেট চেক: messageId, OrderNumbersKey ও ফাইল হ্যাশ দিয়ে পরীক্ষা করা হয়, একই বার্তা বারবার না যায়
 *
 * প্রয়োজনীয়: npm install করে নেওয়া লাগবে (package.json দেখুন)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { accountManager, reminderConfig, reminderConfigPath, chargeConfig, chargeConfigPath, checkOverdueDue } = require("./accountManager");

const delayProfile = {
    MsgForwardDelay: { min: 100, max: 500 }, // MsgForwardDelay এর জন্য র্যান্ডম ডিলে 500ms থেকে 1000ms
    PdfForwardDelay: { min: 100, max: 500 }, // PdfForwardDelay এর জন্য র্যান্ডম ডিলে 300ms থেকে 600ms
    ReactDelay: { min: 50, max: 150 }, // ReactDelay এর জন্য র্যান্ডম ডিলে 100ms থেকে 300ms
    Src_Msg_Delay: { min: 300, max: 600 },  // Src_Msg_Delay এর জন্য র্যান্ডম ডিলে 300ms থেকে 600ms
    ReplyDelay: { min: 100, max: 300 },  // ReplyDelay এর জন্য র্যান্ডম ডিলে 100ms থেকে 300ms
    QueueAddDelay: { min: 10, max: 50 },  // QueueAddDelay এর জন্য র্যান্ডম ডিলে 50ms থেকে 200ms
    TaskDelay: { min: 10, max: 50 },  // TaskDelay এর জন্য র্যান্ডম ডিলে 50ms থেকে 200ms    
    SmallDelay: { min: 10, max: 50 },  // SmallDelay এর জন্য র্যান্ডম ডিলে 50ms থেকে 200ms
};

const reactProfile = {
    MsgForwardReact: "👍",
    MsgduplicateReact: "❌",
    PdfduplicateReact: "❌",
    PdfForwardReact: "✅",
    TargetReact: "✅",
    FilematchingReact: "👍",
    Not_Match_React: "❌",
    OfficeNoticeReact: "👍",
    custom: {}
};

// ================== পাথ ও কনফিগ ==================
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const REPORTS_DIR = path.join(ROOT, 'Reports');
// তারিখ অনুযায়ী ফোল্ডার নাম তৈরি (YYYY-MM-DD)
const currentDateFolder = moment().format('YYYY-MM-DD');
const dailyReportsDir = path.join(REPORTS_DIR, currentDateFolder);

// ডিরেক্টরি নিশ্চিত
fs.ensureDirSync(dailyReportsDir);  // 'reports/YYYY-MM-DD' ফোল্ডার তৈরি হবে

// `temp` ফোল্ডার তৈরি হবে, তবে এখানে `temp` ফোল্ডার আলাদা করে তৈরি হবে
const tempDir = path.join(dailyReportsDir, 'temp');
fs.ensureDirSync(tempDir); // 'reports/YYYY-MM-DD/temp' ফোল্ডার তৈরি হবে

let AdminNumber = [];
let SignCopy_SenderOfficeNumber = '';
let Nid_Make_OfficeNumber = '';
let Biometric_SenderOfficeNumber = '';
let Birth_SenderOfficeNumber = '';
let e_Tin_SenderOfficeNumber = '';
let Pre_CustomerNumber = [];
let Order_Rcvd_CustomerNumber = [];
let CustomerNumber = [];

// কনফিগ লোড ফাংশন
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error('config.json পাওয়া যায়নি — একটি config.json ফাইল তৈরি করুন।');
        process.exit(1);
    }

    const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

    AdminNumber = configData.AdminNumber || [];
    SignCopy_SenderOfficeNumber = configData.SignCopy_SenderOfficeNumber || '';
    Nid_Make_OfficeNumber = configData.Nid_Make_OfficeNumber || '';
    Biometric_SenderOfficeNumber = configData.Biometric_SenderOfficeNumber || '';
    Birth_SenderOfficeNumber = configData.Birth_SenderOfficeNumber || '';
    e_Tin_SenderOfficeNumber = configData.e_Tin_SenderOfficeNumber || '';
    Pre_CustomerNumber = configData.Pre_CustomerNumber || [];
    Order_Rcvd_CustomerNumber = configData.Order_Rcvd_CustomerNumber || [];
    CustomerNumber = configData.CustomerNumber || [];

    console.log('✅ Configuration reloaded into memory.');

    return configData;
}

// কনফিগ সেভ ফাংশন
function saveConfig() {
    const config = {
        AdminNumber,
        SignCopy_SenderOfficeNumber,
        Nid_Make_OfficeNumber,
        Biometric_SenderOfficeNumber,
        Birth_SenderOfficeNumber,
        e_Tin_SenderOfficeNumber,
        Pre_CustomerNumber,
        Order_Rcvd_CustomerNumber,
        CustomerNumber,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log('💾 Configuration saved to file.');

    // ✅ সাথে সাথে মেমোরিতে আপডেট
    loadConfig();
}

// 🔹 ফাইল পরিবর্তন মনিটর করা
function watchConfig() {
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, (curr, prev) => {
        if (curr.mtime !== prev.mtime) { // পরিবর্তন হলে তবেই লোড হবে
            console.log('♻️ config.json Change — Auto Reload...');
            try {
                loadConfig();
                console.log('✅ config.json Reload Successful!');
            } catch (err) {
                console.error('⚠️ config reload error:', err.message);
            }
        }
    });
}

// 🔹 প্রথমবার লোড ও মনিটর শুরু
loadConfig();
watchConfig();

// রিপোর্ট/লগ ফাইল পাথ
function getReportPath(type) {
    const day = moment().format('YYYY-MM-DD');  // তারিখ অনুযায়ী ফোল্ডার তৈরি
    const dailyReportsDir = path.join(REPORTS_DIR, day); // আজকের দিন অনুযায়ী ফোল্ডার
    // ফোল্ডার নিশ্চিত
    fs.ensureDirSync(dailyReportsDir);
    const filename = `${day}_${type}.json`;  // ফাইলের নাম
    const file = path.join(dailyReportsDir, filename);  // 'reports/YYYY-MM-DD/type.json' ফাইল পাথ
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');  // যদি ফাইল না থাকে, তা হলে নতুন ফাইল তৈরি
    return file;  // ফাইলের পাথ রিটার্ন করবে
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveToJson(filePath, entry) {
    const arr = readJson(filePath);
    arr.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
}

// ================== হেল্পার ফাংশন ==================
function toJid(number) {
    if (!number) return number;
    number = String(number);  // নিশ্চিত করুন যে number একটি স্ট্রিং
    if (number.endsWith('@c.us')) return number;
    return `${number}@c.us`;
}

function extractNumberFromId(id) {
    if (!id) return '';
    return id.split('@')[0];
}

function normalizePhone(n) {
    if (!n) return '';
    return n.toString().replace(/^\+/, '').replace(/[^0-9]/g, '');
}

function now() {
    return new Date().toLocaleString();
}

// ফাইলের SHA256 হ্যাশ ক্যালকুলেট
function hashBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 🔥 Combined Function: matchedOrderKey, matchedOrderType, extractedList, sarvarCopyDetected, nameEnglish
function getMatchedOrderKey(pdfText, options = {}) {
    const DEBUG = options.debug || false; // 🔹 ডিফল্ট false
    try {
        const regexMap = {
            "National ID": /\nNational ID(\d{5,17})/,
            "Pin": /\nPin(\d{5,17})/,
            "Voter No": /\nVoter No(\d{5,17})/,
            "Form No": /\nForm No([A-Za-z0-9]+)/,
            "Birth Registration No": /\nBirth Registration\nNo\n(\d{5,17})/,
            "TIN": /\nTIN(\d{5,17})/,
            "Passport": /\nPassport([A-Za-z0-9]+)/,
            "NID Father": /\nNID Father(\d{5,17})/,
            "NID Mother": /\nNID Mother(\d{5,17})/,
            "Nid Spouse": /\nNid Spouse(\d{5,17})/,
            "Voter No Father": /\nVoter No Father(\d{5,17})/,
            "Voter No Mother": /\nVoter No Mother(\d{5,17})/,
            "Voter No Spouse": /\nVoter No Spouse(\d{5,17})/,
            "Phone": /\nPhone(\d{5,17})/,
            "Mobile": /\nMobile(\d{5,17})/
        };

        const fileMatching = new Set();
        let pinValue = null;
        let formNoValue = null;

        // 🔹 Extract all values
        for (const [label, regex] of Object.entries(regexMap)) {
            const match = pdfText.match(regex);
            const value = match?.[1];
            if (value) {
                const cleanValue = value.includes("\n") ? "00000" : value;
                fileMatching.add(`${label}: ${cleanValue}`);

                if (label === "Pin") pinValue = cleanValue;
                if (label === "Form No") formNoValue = cleanValue;
            }
        }

        if (pinValue?.length >= 5) fileMatching.add(`OldNID(PinTrim): ${pinValue.slice(4)}`);
        if (formNoValue) {
            const digitsOnly = formNoValue.replace(/\D/g, "");
            if (digitsOnly) fileMatching.add(`FormNoDigits: ${digitsOnly}`);
        }

        const allDigits = pdfText.match(/\b\d{5,17}\b/g);
        if (allDigits?.length) allDigits.forEach(d => fileMatching.add(`AllDigit: ${d.trim()}`));

        const extractedList = Array.from(fileMatching); // ✅ সব extracted items

        // -------------------------------
        // Match From OrderForward_Details_Log
        let deliveryLogs = [];
        try {
            const forwardPath = getReportPath('OrderForward_Details_Log');
            deliveryLogs = readJson(forwardPath);
        } catch (e) {
            if (DEBUG) console.error("[ERROR] Failed to read OrderForward_Details_Log:", e);
        }

        let matchedOrderKey = []; // 🔹 always array
        let matchedOrderType = null;

        for (const item of extractedList) {
            const [label, rawValue] = item.split(":").map(t => t.trim());
            const value = rawValue;

            for (const entry of deliveryLogs) {
                let orderNumbers = [];
                if (typeof entry.OrderNumbersKey === "string") {
                    orderNumbers = entry.OrderNumbersKey.split(",").map(n => n.trim());
                } else if (Array.isArray(entry.OrderNumbersKey)) {
                    orderNumbers = entry.OrderNumbersKey.map(n => n.toString().trim());
                } else if (entry.OrderNumbersKey) {
                    orderNumbers = [entry.OrderNumbersKey.toString().trim()];
                }

                if (orderNumbers.includes(value)) {
                    matchedOrderKey = [value];  // 🔹 just value, always array
                    matchedOrderType = label;
                    break;
                }
            }
            if (matchedOrderKey.length) break;
        }

        // -------------------------------
        // Sarvar Copy Detect (True/False)
        const sarvarCopyDetected = /software[\s-]*generated[\s-]*report[\s-]*from[\s-]*bangladesh[\s-]*election[\s-]*commission[\s,]*signature[\s&and]*seal[\s]*(aren't|not|are\s*not)?[\s]*required/i.test(pdfText);

        // -------------------------------
        // Extract Name English
        let nameEnglish = null;
        const match1 = pdfText.match(/\nName\(English\)\s*[:\-]?\s*([^\n]+)/i);
        if (match1?.[1]) {
            nameEnglish = match1[1].trim();
        } else {
            const pattern2 = /^[A-Za-z\s]{1,150}$/gm;
            const allLines = pdfText.split(/\r?\n/);
            for (const line of allLines) {
                if (pattern2.test(line.trim())) {
                    nameEnglish = line.trim();
                    break;
                }
            }
        }
        if (DEBUG) {
            console.log("Matched Order Key:", matchedOrderKey);
            console.log("Matched Order Type:", matchedOrderType);
            console.log("Extracted List Length:", extractedList.length);
            console.log("Sarvar Copy Detected:", sarvarCopyDetected);
            console.log("Name English:", nameEnglish);
        }
        return {
            matchedOrderKey,
            matchedOrderType,
            extractedList,
            sarvarCopyDetected,
            nameEnglish
        };

    } catch (e) {
        if (DEBUG) console.error("[ERROR] getMatchedOrderKey failed:", e);
        return {
            matchedOrderKey: [],
            matchedOrderType: null,
            extractedList: [],
            sarvarCopyDetected: false,
            nameEnglish: null
        };
    }
}


// mainCustomerNumber বের করা 'OrderForward_Details_Log' থেকে
function mainCustomerNumberFind(fileMatchingNumbers) {
    const forwardPath = getReportPath('OrderForward_Details_Log');
    const deliveryLogs = readJson(forwardPath);  // OrderForward_Details_Log.json ফাইল থেকে ডেটা পড়া

    const mainCustomerNumbers = [];  // ফাংশনের ভিতরেই MainCustomerNumbers অ্যারে ডিফাইন করা হচ্ছে

    for (const number of fileMatchingNumbers) {
        // OrderForward_Details_Log এর "OrderNumbersKey" এর সাথে মিলানো
        const matchedLog = deliveryLogs.find(entry => {
            let orderNumbers;

            // OrderNumbersKey এর টাইপ চেক করা
            if (typeof entry.OrderNumbersKey === 'string') {
                // যদি OrderNumbersKey স্ট্রিং হয়, তবে split() ব্যবহার করা হবে
                orderNumbers = entry.OrderNumbersKey.split(',').map(num => num.trim());
            } else if (Array.isArray(entry.OrderNumbersKey)) {
                // যদি OrderNumbersKey অ্যারে হয়, তাহলে সরাসরি ব্যবহার করব
                orderNumbers = entry.OrderNumbersKey.map(num => num.toString().trim());
            } else if (typeof entry.OrderNumbersKey === 'object') {
                // যদি OrderNumbersKey অবজেক্ট হয়, তাকে স্ট্রিংয়ে রূপান্তর করা হবে
                orderNumbers = [entry.OrderNumbersKey.toString().trim()];
            } else {
                // অন্য কোন ক্ষেত্রে error হ্যান্ডলিং
                console.error('Unexpected type for OrderNumbersKey:', typeof entry.OrderNumbersKey);
                return false;  // মিল না পেলে false রিটার্ন
            }

            // এখন মিলিয়ে দেখা হচ্ছে, fileMatchingNumbers এর নম্বরটি যদি OrderNumbersKey এর মধ্যে থাকে
            return orderNumbers.includes(number);
        });

        if (matchedLog) {
            // মিল পাওয়ার পর, সেই এন্ট্রির "MainCustomerNumber" বের করা হচ্ছে
            const mainCustomerNumber = matchedLog.MainCustomerNumber;

            // normalizePhone দিয়ে নাম্বার ফরম্যাট ঠিক করা
            if (Array.isArray(mainCustomerNumber)) {
                mainCustomerNumbers.push(normalizePhone(mainCustomerNumber[0]));
            } else if (typeof mainCustomerNumber === 'string') {
                mainCustomerNumbers.push(normalizePhone(mainCustomerNumber));
            } else if (mainCustomerNumber) {
                mainCustomerNumbers.push(normalizePhone(mainCustomerNumber.toString()));
            }
        } else {
            // console.log(`No match found for order number: ${number}`);
        }
    }

    // MainCustomerNumbers অ্যারেকে রিটার্ন করা হচ্ছে
    return mainCustomerNumbers;
}

// 🔹 officeMsgIdFind - অফিস মেসেজ আইডি বের করার ফাংশন
function officeMsgIdFind(fileMatchingNumbers) {
    const forwardPath = getReportPath('OrderForward_Details_Log'); // JSON ফাইলের পাথ
    const deliveryLogs = readJson(forwardPath);  // OrderForward_Details_Log.json থেকে ডেটা পড়া

    if (!Array.isArray(fileMatchingNumbers) || fileMatchingNumbers.length === 0) {
        console.error("❌ Invalid fileMatchingNumbers input:", fileMatchingNumbers);
        return null;
    }

    // 🔹 প্রথম মিলে যাওয়া officeMsgId রিটার্ন করবে
    for (const number of fileMatchingNumbers) {
        const matchedLog = deliveryLogs.find(entry => {
            let orderNumbers = [];

            if (typeof entry.OrderNumbersKey === 'string') {
                orderNumbers = entry.OrderNumbersKey.split(',').map(num => num.trim());
            } else if (Array.isArray(entry.OrderNumbersKey)) {
                orderNumbers = entry.OrderNumbersKey.map(num => num.toString().trim());
            } else if (entry.OrderNumbersKey) {
                orderNumbers = [entry.OrderNumbersKey.toString().trim()];
            }

            return orderNumbers.includes(number);
        });

        if (matchedLog) {
            let msgId = matchedLog.officemsgId;
            if (Array.isArray(msgId)) {
                return msgId[0]?.toString()?.trim() || null;
            } else if (typeof msgId === 'string') {
                return msgId.trim();
            } else if (msgId) {
                return msgId.toString().trim();
            }
        }
    }

    // 🔹 যদি কিছুই না মেলে
    console.warn("⚠️ কোনো matching officemsgId পাওয়া যায়নি!");
    return null;
}

// 🔹 orderTagFind - OrderTag বের করার ফাংশন
function orderTagFind(fileMatchingNumbers) {
    const forwardPath = getReportPath('OrderForward_Details_Log'); // JSON ফাইলের পাথ
    const deliveryLogs = readJson(forwardPath);  // OrderForward_Details_Log.json থেকে ডেটা পড়া

    if (!Array.isArray(fileMatchingNumbers) || fileMatchingNumbers.length === 0) {
        console.error("❌ Invalid fileMatchingNumbers input:", fileMatchingNumbers);
        return null;
    }

    // 🔹 প্রথম মিলে যাওয়া OrderTag রিটার্ন করবে
    for (const number of fileMatchingNumbers) {
        const matchedLog = deliveryLogs.find(entry => {
            let orderNumbers = [];

            if (typeof entry.OrderNumbersKey === 'string') {
                orderNumbers = entry.OrderNumbersKey.split(',').map(num => num.trim());
            } else if (Array.isArray(entry.OrderNumbersKey)) {
                orderNumbers = entry.OrderNumbersKey.map(num => num.toString().trim());
            } else if (entry.OrderNumbersKey) {
                orderNumbers = [entry.OrderNumbersKey.toString().trim()];
            }

            return orderNumbers.includes(number);
        });

        if (matchedLog) {
            let tag = matchedLog.OrderTag;
            if (Array.isArray(tag)) {
                return tag[0]?.toString()?.trim() || null;
            } else if (typeof tag === 'string') {
                return tag.trim();
            } else if (tag) {
                return tag.toString().trim();
            }
        }
    }

    // 🔹 যদি কিছুই না মেলে
    console.warn("⚠️ OrderTag No Matching !");
    return null;
}

/**
 * nidpdf থেকে NID no বের করে, তারপর delivery log থেকে MainCustomerNumber খুঁজে বের করবে
 * @param {string} pdfText 
 * @returns {string[]} mainCustomerNumbers
 */
/*
function getMainCustomerNumbersFromMessage(pdfText) {
    if (!pdfText) return [];

    // ১️⃣ NID extract করা (10 digit number ধরে নিচ্ছি)
    const nidMatches = Array.from(pdfText.matchAll(/\b\d{10}\b/g), m => m[0]);
    if (!nidMatches.length) return [];

    // ২️⃣ Delivery log পড়া
    const deliveryPath = getReportPath('OrderDelivery_Details_Log');
    const deliveryLogs = readJson(deliveryPath);

    const mainCustomerNumbers = [];

    const processLog = (log) => {
        if (!log.Nid_Number) return;
        const logNids = log.Nid_Number.split(',').map(n => n.trim());
        for (const nid of nidMatches) {
            if (logNids.includes(nid)) {
                if (log.MainCustomerNumber) {
                    mainCustomerNumbers.push(...log.MainCustomerNumber.split(',').map(n => n.trim()));
                }
            }
        }
    };

    if (Array.isArray(deliveryLogs)) {
        deliveryLogs.forEach(processLog);
    } else if (typeof deliveryLogs === 'object') {
        Object.values(deliveryLogs).forEach(processLog);
    }

    // ডুপ্লিকেট নাম্বার রিমুভ
    return mainCustomerNumbers;
}
*/
/**
 * nidpdf থেকে NID no বের করে, delivery log থেকে MainCustomerNumber খুঁজবে
 * @param {string} pdfText 
 * @returns {string|null} mainCustomerNumber
 */
function getMainCustomerNumbersFromMessage(pdfText) {
    if (!pdfText) return null;

    // NID extract করা (10 digit number ধরে নিচ্ছি)
    const nidMatches = Array.from(pdfText.matchAll(/\b\d{10}\b/g), m => m[0]);
    if (!nidMatches.length) return null;

    // Delivery log পড়া
    const deliveryPath = getReportPath('OrderDelivery_Details_Log');
    const deliveryLogs = readJson(deliveryPath);

    const mainCustomerNumbers = [];

    const processLog = (log) => {
        if (!log.Nid_Number) return;
        const logNids = log.Nid_Number.split(',').map(n => n.trim());
        for (const nid of nidMatches) {
            if (logNids.includes(nid)) {
                if (log.MainCustomerNumber) {
                    mainCustomerNumbers.push(...log.MainCustomerNumber.split(',').map(n => n.trim()));
                }
            }
        }
    };

    if (Array.isArray(deliveryLogs)) {
        deliveryLogs.forEach(processLog);
    } else if (typeof deliveryLogs === 'object') {
        Object.values(deliveryLogs).forEach(processLog);
    }

    // ডুপ্লিকেট নাম্বার রিমুভ
    const uniqueNumbers = [...new Set(mainCustomerNumbers)];

    // প্রথম নাম্বার রিটার্ন করো (যেমন mainCustomerNumberFind)
    return uniqueNumbers.length > 0 ? uniqueNumbers[0] : null;
}


// ✅ মেসেজ থেকে Order Numbers (5–17 digit) বের করার ফাংশন
function extractOrderNumbersmsgbody(bodyText) {
    if (!bodyText) return [];
    // 5 থেকে 17 ডিজিটের সব নম্বর খুঁজে বের করা
    const orderNumbers = bodyText.match(/\d{5,17}/g);
    if (orderNumbers) {
        // normalize করে ডুপ্লিকেট বাদ দাও ও sort করে লিস্ট তৈরি করো
        const cleanedNumbers = [...new Set(orderNumbers.map(n => normalizePhone(n)))];
        return cleanedNumbers.sort((a, b) => a - b);
    }
    return [];
}
// pdf থেকে sarvarcopydetects
function sarvarcopydetect(pdfText) {
    if (!pdfText) return false;

    const pattern = /software[\s-]*generated[\s-]*report[\s-]*from[\s-]*bangladesh[\s-]*election[\s-]*commission[\s,]*signature[\s&and]*seal[\s]*(aren't|not|are\s*not)?[\s]*required/i;

    return pattern.test(pdfText);
}

// pdf থেকে নাম (English) বের করার চেষ্টা (ধারণা: "Name (English): John Doe" বা "Name: John Doe")
function extractNameEnglish(pdfText) {
    if (!pdfText) return null;
    // ① প্রথমে "Name(English)" প্যাটার্ন খোঁজা
    const pattern1 = /\nName\(English\)\s*[:\-]?\s*([^\n]+)/i;
    let match = pdfText.match(pattern1);
    if (match && match[1]) {
        return match[1].trim();
    }

    // ② যদি না মিলে, fallback হিসেবে শুধু ইংরেজি নামের লাইন খোঁজা
    const pattern2 = /^[A-Za-z\s]{1,150}$/gm;  // কেবল ইংরেজি অক্ষর ও স্পেস
    const allLines = pdfText.split(/\r?\n/);

    for (const line of allLines) {
        if (pattern2.test(line.trim())) {
            return line.trim();
        }
    }

    return null;
}

// ডুপ্লিকেট চেক: ফরওয়ার্ড লোগে OrderNumbersKey, messageId বা fileHash দেখে চেক করব
function isDuplicateForward({ orderKey, messageId, fileHash }) {
    // ডেইলি রিপোর্ট পাথ থেকে OrderDelivery_Details_Log ফাইল পেতে হবে
    const deliveryPath = getReportPath('OrderDelivery_Details_Log');
    const logs = readJson(deliveryPath); // ফাইলটি পড়তে হবে

    // চেক করা হচ্ছে ডুপ্লিকেট
    return logs.some(e =>
        // orderKey, messageId, বা fileHash কোনটিই ডুপ্লিকেট আছে কিনা চেক করবো
        (orderKey && e.OrderNumbersKey && e.OrderNumbersKey === orderKey) ||
        (messageId && (e.messageId === messageId || e.messageId === messageId.id || e.messageId === messageId._serialized)) ||
        (fileHash && e.fileHash && e.fileHash === fileHash)
    );
}

//ফাংশন randomDelay তৈরি
function randomDelay(type) {
    // Ensure delay is within the defined range
    if (!delayProfile[type]) {
        console.log("No delay profile found for", type);
        return 1000; // Default 1000ms if no delay profile exists
    }
    const { min, max } = delayProfile[type];
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    // console.log(`Random delay for ${type}: ${delay}ms`);  // For debugging, log the delay
    return delay;
}

// ফাংশন getReactEmoji তৈরি
function getReactEmoji(type) {
    return reactProfile[type] || reactProfile.custom[type] || "🔹";
}

// =========================
// 🔹 Utility: Combine Pre + Main Customers
// =========================
/*
function getAllUsers() {
    const preList = Array.isArray(Pre_CustomerNumber) ? Pre_CustomerNumber.map(u => normalizePhone(u.number)) : [];
  //  const mainList = Array.isArray(CustomerNumber) ? CustomerNumber.map(u => normalizePhone(u.number)) : [];
    return [...new Set([...preList, ...mainList])]; // Remove duplicates
}
*/
/*
async function getAllUsers() {
    let preList = [];
    // let mainList = [];

    try {
        // 🔹 Pre_CustomerNumber থেকে normalized list
        if (Array.isArray(Pre_CustomerNumber)) {
            preList = Pre_CustomerNumber.map(u => normalizePhone(u.number));
        }

        // 🔹 Main CustomerNumber থেকে normalized list (optional)
        //   if (Array.isArray(CustomerNumber)) {
        //       mainList = CustomerNumber.map(u => normalizePhone(u.number));
        //   }

        // 🔹 ভবিষ্যতে চাইলে ফাইল/DB থেকে আরও ইউজার লোড করা যাবে
        // Example:
        // const fileData = await fs.promises.readFile('users.json', 'utf8');
        // const fileUsers = JSON.parse(fileData).map(u => normalizePhone(u.number));
        // preList.push(...fileUsers);

    } catch (err) {
        console.error("getAllUsers error:", err);
    }

    // 🔹 সব লিস্ট মিলিয়ে duplicate remove করে return
    //  return [...new Set([...preList, ...mainList])];
    return [...new Set(preList)];

}
*/
// ================================
// 🔹 সব ইউজার লিস্ট ফাংশন
// ================================
async function getAllUsers() {
    try {
        const Pre_CustomerList = Array.isArray(Pre_CustomerNumber)
            ? [...new Set(Pre_CustomerNumber.map(u => normalizePhone(u.number)))]
            : [];

        const CustomerList = Array.isArray(CustomerNumber)
            ? [...new Set(CustomerNumber.map(u => normalizePhone(u.number)))]
            : [];

        return { Pre_CustomerList, CustomerList };
    } catch (err) {
        console.error("getAllUsers error:", err);
        return { Pre_CustomerList: [], CustomerList: [] };
    }
}

let isPaused = false; // বট কন্ট্রল= true রাখলে pause হয়ে থাকবে এবং false রাখলে resume হয়ে থাকবে।
let botPaused = false; // বট কন্ট্রল= true রাখলে pause হয়ে থাকবে এবং false রাখলে resume হয়ে থাকবে।

// 4️⃣ QUEUE SYSTEM
const messageQueue = [];
let isProcessing = false;

function addToQueue(task) {
    messageQueue.push(task);
    processQueue();
}

async function processQueue() {
    if (isProcessing) return; // Prevent processing when paused
    isProcessing = true;

    // যদি queue খালি থাকে, অন্য কোন কাজ করানোর ব্যবস্থা করুন
    if (messageQueue.length === 0) {
        console.log("Queue is empty, nothing to process!");
        isProcessing = false;
        return;  // Queue খালি থাকলে থেমে যাবে, তবে অন্য কোনও কাজ চালানো যাবে
    }
    // console.log("Processing queue...");

    while (messageQueue.length > 0) {
        const task = messageQueue.shift();
        console.log(`Processing task...`);

        try {
            // Random delay before processing each task
            const TaskDelay = randomDelay("TaskDelay");  // Get delay for each task
            console.log(`Waiting for ${TaskDelay}ms before processing the task...`);

            // Apply delay (setTimeout instead of sleep)
            await new Promise(resolve => setTimeout(resolve, TaskDelay));  // Delay before executing task

            // Execute task with timeout
            const TaskTimeout = 15000; // 15 seconds
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Task timed out')), TaskTimeout));
            await Promise.race([task(), timeoutPromise]);  // Race between task completion and timeout

            //    console.log("Task processed successfully!");
        } catch (err) {
            console.error("❌ Error processing task:", err);
        }
        // Optional: Apply a small delay between tasks
        const SmallDelay = randomDelay("SmallDelay");  // Delay between tasks in the queue
        await new Promise(resolve => setTimeout(resolve, SmallDelay));  // Small delay
    }

    isProcessing = false;
    // console.log("Queue processing completed!");
}

// =========================
// COMMAND Helpers (put near the top)
// =========================
// Safe send message to a number with delay + addToQueue
async function safeSend(client, number, text, delayType = "Src_Msg_Delay") {
    if (!client || !number || !text) return;

    // 🔹 Queue-তে অ্যাড করা
    addToQueue(async () => {
        try {
            const delay = randomDelay(delayType);  // Get random delay from delayProfile
            // 🔹 Delay প্রয়োগ
            await new Promise(resolve => setTimeout(resolve, delay));
            // 🔹 রূপান্তরিত নম্বর (jid) পাওয়ার জন্য `toJid` ব্যবহার করুন
            const targetJid = toJid(number);
            // 🔹 মেসেজ পাঠানো
            await client.sendMessage(targetJid, text);
        } catch (e) {
            console.error("sendMessage failed:", number, e);
        }
    });
}

// Generic: list add + DM to that number 
async function addNumberToList(list, rawNumber, name, { saveConfig, message, client, listName, dmText, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!");

    // কান্ট্রি কোড চেক (country code সহ)
    if (!number || number.length < 12) {
        return message.reply("❌ country code সহ নাম্বার দিন।");
    }

    // চেক করুন, যদি নাম্বার ইতিমধ্যেই তালিকায় থাকে
    const existingEntry = list.find(entry => entry.number === number);
    if (!existingEntry) {
        // নতুন নম্বর এবং নাম যোগ করা হচ্ছে
        list.push({ number, name });
        if (typeof saveConfig === "function") saveConfig();
        await message.reply(`✅ ${name} (${number}) ${listName} এ যোগ করা হয়েছে!`);

        // নতুন যোগ হওয়া নাম্বারকে DM পাঠান with delay
        await safeSend(client, number, dmText || "✅ ${name}, আপনাকে সিস্টেমে যুক্ত করা হয়েছে।", delayType);
    } else {
        await message.reply(`❌ ${number} (${name}) ইতিমধ্যেই ${listName} এ রয়েছে!`);
    }
}

// Generic: list remove + DM to that number 
async function removeNumberFromList(list, rawNumber, { saveConfig, message, client, listName, dmTextIfRemoved, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!");

    // কান্ট্রি কোড চেক (country code সহ)
    if (!number || number.length < 12) {
        return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
    }

    // নম্বরের অবস্থান খুঁজে বের করা
    const index = list.findIndex(entry => entry.number === number);
    if (index !== -1) {
        const name = list[index].name; // নামটি সংরক্ষণ করুন
        list.splice(index, 1); // নাম্বার মুছে ফেলুন
        if (typeof saveConfig === "function") saveConfig();
        await message.reply(`✅ (${number}) ${listName} থেকে মুছে ফেলা হয়েছে!`);

        // DM পাঠানো
        await safeSend(client, number, dmTextIfRemoved || `❌ ${number} (${name}) আপনাকে সিস্টেম থেকে রিমুভ করা হয়েছে।`, delayType);
    } else {
        await message.reply(`❌ ${number} ${listName} এ নেই!`);
    }
}

// Single value: SignCopySenderOffice set/remove + DM 
async function setSignCopyOffice(rawNumber, { saveConfig, message, client, dmText, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!");

    if (!/^\d{13}$/.test(number)) return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন! যেমন: 8801777123456");


    // SignCopy_SenderOfficeNumber কে অ্যারেতে ইনিশিয়ালাইজ করুন যদি না হয়
    if (!Array.isArray(SignCopy_SenderOfficeNumber)) {
        SignCopy_SenderOfficeNumber = [];
    }

    // আগের নাম্বার চেক
    if (SignCopy_SenderOfficeNumber[0] === number) {
        // আগের নাম্বার এবং নতুন নাম্বার একই হলে
        return message.reply(`❌ ${number} ইতিমধ্যেই SignCopy Sender Office হিসেবে সেট করা রয়েছে!`);
    }

    // আগের নাম্বার থাকলে রিমুভ করুন
    if (SignCopy_SenderOfficeNumber.length > 0) {
        const oldNumber = SignCopy_SenderOfficeNumber[0];
        SignCopy_SenderOfficeNumber = []; // পুরনো নাম্বার মুছে দেওয়া হলো
        try {
            await safeSend(client, oldNumber, "❌ আপনাকে SignCopy Sender Office থেকে রিমুভ করা হয়েছে।", delayType);
        } catch (err) {
            console.error("Failed to notify old office number:", err);
        }
    }

    // নতুন নাম্বার অ্যারেতে যোগ করুন
    SignCopy_SenderOfficeNumber.push(number);
    if (typeof saveConfig === "function") saveConfig();  // কনফিগ সেভ করা হচ্ছে
    await message.reply(`✅ ${number} SignCopy Sender Office হিসেবে সেট করা হয়েছে!`);
    try {
        // নতুন অফিস নাম্বারে DM পাঠান
        await safeSend(client, number, dmText || "✅ আপনাকে SignCopy Sender Office হিসেবে সেট করা হয়েছে।", delayType);
    } catch (err) {
        console.error("Failed to notify new office number:", err);
    }
}

async function removeSignCopyOffice(rawNumber, { saveConfig, message, client, dmTextIfRemoved, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!");
    // কান্ট্রি কোড চেক (country code সহ)
    if (!number || number.length < 12) {
        return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
    }
    // যদি SignCopy_SenderOfficeNumber অ্যারে না হয়, তবে একে অ্যারে হিসেবে ইনিশিয়ালাইজ করুন
    if (!Array.isArray(SignCopy_SenderOfficeNumber)) {
        SignCopy_SenderOfficeNumber = [];
    }
    // যদি অ্যারেতে নম্বর থাকে, তাহলে তা রিমুভ করুন
    const index = SignCopy_SenderOfficeNumber.indexOf(number);
    if (index !== -1) {
        SignCopy_SenderOfficeNumber.splice(index, 1);  // নাম্বারটি রিমুভ করুন
        if (typeof saveConfig === "function") saveConfig();  // কনফিগ সেভ করা হচ্ছে
        await message.reply(`✅ ${number} SignCopy Sender Office থেকে মুছে ফেলা হয়েছে!`);

        // যে অফিস নাম্বার রিমুভ হলো, তাকে DM with delay
        await safeSend(client, number, dmTextIfRemoved || "❌ আপনাকে Auto Bot সার্ভিসে, \n SignCopy Sender Office থেকে রিমুভ করা হয়েছে।", delayType);
    } else {
        await message.reply(`❌ ${number} SignCopySenderOffice হিসেবে সেট করা নেই!`);
    }
}

// ===============================
// 🟢 NID Make Office: Set / Remove Command (String version)
// ===============================

// 📦 ফাংশন ১: NID Make Office সেট করা
async function setNidMakeOffice(rawNumber, { saveConfig, message, client, dmText, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নাম্বার দিন!");

    if (!/^\d{13}$/.test(number))
        return message.reply("❌ কান্ট্রি কোডসহ নাম্বার দিন! যেমন: 8801777123456");

    // আগের নাম্বার একই হলে কিছুই করবে না
    if (Nid_Make_OfficeNumber === number) {
        return message.reply(`❌ ${number} ইতিমধ্যেই NID Make Office হিসেবে সেট করা রয়েছে!`);
    }

    // আগের নাম্বার থাকলে আগে তাকে রিমুভ করা ও বার্তা পাঠানো
    if (Nid_Make_OfficeNumber) {
        const oldNumber = Nid_Make_OfficeNumber;
        Nid_Make_OfficeNumber = ''; // পুরনো নাম্বার ক্লিয়ার করা
        try {
            await safeSend(client, oldNumber, "❌ আপনাকে NID Make Office থেকে রিমুভ করা হয়েছে।", delayType);
        } catch (err) {
            console.error("Failed to notify old NID office:", err);
        }
    }

    // নতুন নাম্বার সেট করা
    Nid_Make_OfficeNumber = number;
    if (typeof saveConfig === "function") saveConfig();

    await message.reply(`✅ ${number} NID Make Office হিসেবে সেট করা হয়েছে!`);
    try {
        await safeSend(client, number, dmText || "✅ আপনাকে NID Make Office হিসেবে সেট করা হয়েছে।", delayType);
    } catch (err) {
        console.error("Failed to notify new NID office:", err);
    }
}

// 📦 ফাংশন ২: NID Make Office রিমুভ করা
async function removeNidMakeOffice(rawNumber, { saveConfig, message, client, dmTextIfRemoved, delayType = "ReplyDelay" } = {}) {
    const number = normalizePhone(rawNumber);
    if (!number) return message.reply("❌ অনুগ্রহ করে একটি নাম্বার দিন!");

    if (!number || number.length < 12)
        return message.reply("❌ কান্ট্রি কোডসহ নাম্বার দিন!");

    if (!Nid_Make_OfficeNumber) {
        return message.reply("❌ বর্তমানে কোনো NID Make Office সেট করা নেই!");
    }

    if (Nid_Make_OfficeNumber === number) {
        const removedNumber = Nid_Make_OfficeNumber;
        Nid_Make_OfficeNumber = '';
        if (typeof saveConfig === "function") saveConfig();
        await message.reply(`✅ ${removedNumber} NID Make Office থেকে মুছে ফেলা হয়েছে!`);
        await safeSend(client, removedNumber, dmTextIfRemoved || "❌ আপনাকে Auto Bot সার্ভিসে,\nNID Make Office থেকে রিমুভ করা হয়েছে।", delayType);
    } else {
        await message.reply(`❌ ${number} NID Make Office হিসেবে সেট করা নেই!`);
    }
}

/**
 * চেক করবে কি এই orderKey একই অফিসে আগে পাঠানো হয়েছে কি না
 * @param {Array} orderKey - অর্ডারের নম্বরের অ্যারে
 * @param {string} officeNumber - অফিসের নাম্বার
 * @returns {boolean} - true হলে ডুপ্লিকেট, false হলে নতুন অর্ডার
 */

function getDuplicateKeys(orderKey, officeNumber, logsInput = []) {
    // যদি logsInput না থাকে, ফাইল থেকে পড়া হবে
    const forwardPath = getReportPath('OrderForward_Details_Log');
    const logs = logsInput.length ? logsInput : (readJson(forwardPath) || []);

    if (!Array.isArray(logs)) logs = [];

    const duplicates = [];

    logs.forEach(log => {
        if (log.officeNumber === officeNumber) {
            const logKeys = log.OrderNumbersKey.split(',').map(x => x.trim());
            orderKey.forEach(k => {
                if (logKeys.includes(k) && !duplicates.includes(k)) {
                    duplicates.push(k);
                }
            });
        }
    });

    return duplicates; // মিলেছে এমন key এর array
}

// Force puppeteer to use system chromium (Railway Fix)
process.env.CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

// ================== WhatsApp Client Initialization ==================
/*
const client = new Client({
    authStrategy: new LocalAuth({        
            clientId: "Whatsapp-bot",                 // ⭐ SAME as local
        dataPath: "./auth"   // session saved inside project folder
    }),
    // আপনার পরিবেশ অনুযায়ী সেট করুন
 puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--remote-debugging-port=9222',
        '--window-size=1920,1080'
    ]
}
});

client.on('qr', qr => {
    console.log('QR কোড দেখাও — প্রথমবার স্ক্যান করুন (terminal এ)।');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp client ready. Session saved via LocalAuth.');
});
*/
// crash guard
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

// ================== WhatsApp Client Initialization ==================
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "Whatsapp-bot",
        dataPath: "./auth"   // session saved inside project folder
    }),
    puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--remote-debugging-port=9222',
        '--window-size=1920,1080'
    ]
}
});

client.on('qr', qr => {
    console.log('QR কোড দেখাও — প্রথমবার স্ক্যান করুন (terminal এ)।');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp client ready. Session saved via LocalAuth.');
});

// ================== কমান্ড সিস্টেম ==================
async function handleCommands(message) {
    // গরুপ মেসেজ স্কিপ (যদি প্রয়োজন হয় তাহলে পরিবর্তন করবেন)
    if (message.from && message.from.endsWith('@g.us')) return;
    const fromNumber = extractNumberFromId(message.from);
    const isCommand = message.body.startsWith('/');
    if (isCommand) {
        const command = message.body.split(' ')[0].toLowerCase(); // যেমন "/help"
        const args = message.body.split(' ').slice(1); // স্পেস দিয়ে বিভক্ত হয়ে গিয়েছে কমান্ড থেকে বাকি অংশ
        console.log(`📩 Command received: ${command} from ${fromNumber}`);
        const isAdmin = AdminNumber?.includes(fromNumber); // উদাহরণ
        // const isPre_Customer = Pre_CustomerNumber?.includes(fromNumber); // Check if the user is a Pre_Customer
        const isPre_Customer = Pre_CustomerNumber?.some(item => item.number === fromNumber);
        // const isCustomer = CustomerNumber?.includes(fromNumber); // Check if the user is a CustomerNumbers
        const isCustomer = CustomerNumber?.some(item => item.number === fromNumber);

        const isSignCopySenderOffice = SignCopy_SenderOfficeNumber?.includes(fromNumber); // Check if the user is a Customer

        // Command access rules:
        // এখানে isAdmin এর সকল কমান্ড রয়েছে।
        if ((command === "/pause" || command === "/resume" || command === "/status" || command === "/cuslist" || command === "/cmd" || command === "/a_pre" || command === "/r_pre" || command === "/a_rcv" || command === "/r_rcv" || command === "/a_sign" || command === "/r_sign" || command === "/a_nid" || command === "/r_nid" || command === "/a_cus" || command === "/r_cus" || command === "/msg" || command === "/dp" || command === "/mcharge" || command === "/refund" || command === "/setrole" || command === "/duemsg" || command === "/duelist" || command === "/dueall" || command === "/gethis" || command === "/setcharge" || command === "/getsum" || command === "/dailyreport" || command === "/dailyrpt" || command === "/drpt" || command === "/daily" || command === "/dr") && !isAdmin) {
            await message.reply("❌ আপনি এই কমান্ড ব্যবহার করার অনুমতি পাননি! \n Admin এর সাথে যোগাযোগ করুন।");
            return;
        }
        // এখানে isPre_Customer এর সকল কমান্ড রয়েছে।
        if ((command === "/pcmd" || command === "/pstatus" || command === "/poffice") && !isPre_Customer) {
            await message.reply("❌ আপনি এই কমান্ড ব্যবহার করার অনুমতি পাননি! \n Admin এর সাথে যোগাযোগ করুন।");
            return;
        }
        // এখানে isCustomer এর সকল কমান্ড রয়েছে।
        if ((command === "/ccmd" || command === "/cstatus" || command === "/coffice") && !isCustomer) {
            await message.reply("❌ আপনি এই কমান্ড ব্যবহার করার অনুমতি পাননি! \n Admin এর সাথে যোগাযোগ করুন।");
            return;
        }
        // এখানে isSignCopySenderOffice এর সকল কমান্ড রয়েছে।
        if ((command === "/ocmd" || command === "/op_msg" || command === "/ostatus") && !isSignCopySenderOffice) {
            await message.reply("❌ আপনি এই কমান্ড ব্যবহার করার অনুমতি পাননি! \n Admin এর সাথে যোগাযোগ করুন।");
            return;
        }

        // এখানে আরও ইউজারের কমান্ড যুক্ত করা যাবে যেমান: (isPdfSenderOffice)    
        if (isAdmin) { // Only allow commands from Admin
            switch (command) {

                // ===========================
                // 💰 Deposit টাকা যোগ-ok
                // ===========================
                case "/dp":
                    try {
                        if (args.length >= 3) {
                            const number = args[0];
                            const amount = parseFloat(args[1]);
                            if (isNaN(amount)) throw new Error("পরিমাণটি সঠিক সংখ্যা নয়।");
                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
                            }

                            const reason = args.slice(2).join(" ") || "Deposit";
                            const acc = accountManager.deposit(number, amount, reason);
                            // অ্যাডমিনকে রিপ্লাই
                            await message.reply(`✅ ${number} এ ${amount} টাকা যোগ হয়েছে। Balance: ${acc.balance}, Due: ${acc.due}`);

                            // গ্রাহককে সুন্দর ফরম্যাটে মেসেজ
                            const depositText =
                                `✅ *ডিপোজিট সফল হয়েছে!*\n` +
                                `━━━━━━━━━━━━━━━\n` +
                                `👤 *Role:* ${acc.role || "Customer"}\n` +
                                `🧾 *লেনদেন:* ${amount} টাকা যোগ হয়েছে\n` +
                                `💬 *কারণ:* ${reason}\n` +
                                `━━━━━━━━━━━━━━━\n` +
                                `💰 *বর্তমান ব্যালেন্স:* ${acc.balance} টাকা\n` +
                                `📄 *Due:* ${acc.due}\n` +
                                `━━━━━━━━━━━━━━━\n` +
                                `ধন্যবাদ 💚 আমাদের সেবা ব্যবহারের জন্য।\n`;

                            await safeSend(client, number, depositText, 'Src_Msg_Delay');
                        } else {
                            await message.reply("❌ ব্যবহার: /dp <নম্বর> <পরিমাণ> [কারণ]");
                        }
                    } catch (err) {
                        console.error("Deposit Error:", err);
                        await message.reply(`❌ Deposit Error: ${err.message}`);
                    }
                    break;

                // ===========================
                // 🔴 দৈনিক অফিস রিপোর্ট কমান্ড হ্যান্ডলার
                // ===========================  
                case "/daily":
                case "/dr":
                    try {
                        const target = args[0];
                        const arg2 = args[1];

                        if (!target) {
                            await message.reply(
                                `⚠️ ভুল কমান্ড!\n\n📌 ব্যবহার করুন:\n` +
                                `→ /daily office\n` +
                                `→ /daily office 018xxxxxxxx\n` +
                                `→ /daily office 15/11/2025\n` +
                                `→ /daily office 018xxxxxxxx 15/11/2025\n`
                            );
                            return;
                        }

                        if (target.toLowerCase() !== "office") {
                            await message.reply(
                                `⚠️ অকার্যকর টার্গেট: "${target}"\n\n📌 ব্যবহার:\n` +
                                `→ /daily office`
                            );
                            return;
                        }

                        const options = {
                            date: moment().tz("Asia/Dhaka")
                        };

                        let number = null;
                        let dateArg = null;

                        // ==========================
                        // 🔥 Updated Validation Logic
                        // ==========================
                        if (arg2) {

                            const isNumber = /^\d{11,13}$/.test(arg2);
                            const isDate = moment(arg2, "DD/MM/YYYY", true).isValid();

                            if (isNumber) {
                                number = arg2;
                            }
                            else if (isDate) {
                                dateArg = arg2;
                            }
                            else {
                                await message.reply(`❌ "${arg2}" সঠিক ফরম্যাট নয়!\n📌 সঠিক ফরম্যাট: 15/11/2025`);
                                return;
                            }
                        }

                        // second argument checking if number exists
                        if (number) {
                            const arg3 = args[2];

                            if (arg3) {

                                const isValidDate = moment(arg3, "DD/MM/YYYY", true).isValid();

                                if (!isValidDate) {
                                    await message.reply(`❌ "${arg3}" তারিখের ফরম্যাট ভুল!\n📌 সঠিক ফরম্যাট: DD/MM/YYYY`);
                                    return;
                                }

                                options.number = number;
                                options.date = moment(arg3, "DD/MM/YYYY").tz("Asia/Dhaka");
                                options.mode = "singleUser";
                            } else {
                                options.number = number;
                                options.mode = "singleUser";
                            }
                        }
                        else if (dateArg) {
                            options.date = moment(dateArg, "DD/MM/YYYY").tz("Asia/Dhaka");
                            options.mode = "adminOnly";
                        }
                        else {
                            options.mode = "adminOnly";
                        }

                        await accountManager.sendOfficeReport(client, message, options);
                        return;

                    } catch (err) {
                        console.error("Daily Report Error:", err);
                        await message.reply(`❌ Daily Report Error: ${err.message}`);
                    }
                    break;




                // ===========================
                // 🔴 দৈনিক ইউজার রিপোর্ট
                // ===========================
                case "/dailyreport":
                case "/dailyrpt":
                case "/drpt":
                    try {
                        const target = args[0];  // "admin" বা নাম্বার বা তারিখ
                        const dateArg = args[1]; // ঐচ্ছিক তারিখ (যেমন 06/11/2025)

                        const options = {};

                        // 🔹 
                        if (dateArg) {
                            options.date = dateArg;   // শুধু raw string পাঠাবে
                        }

                        if (!target) {
                            // ✅ /dailyreport → সকল কে রিপোর্ট  + অ্যাডমিন সারসংক্ষেপ
                            await accountManager.sendDailyReport(client, message, options);
                            return;
                        }

                        else if (target.toLowerCase() === "admin") {
                            // ✅ /dailyreport admin → শুধু অ্যাডমিন সারসংক্ষেপ
                            options.mode = "adminOnly";
                            await accountManager.sendDailyReport(client, message, options);
                            return;
                        }

                        else if (/^\d{11,13}$/.test(target)) {
                            // ✅ /dailyreport 8801777... → ঐ ইউজার + অ্যাডমিন
                            options.mode = "singleUser";
                            options.number = target;
                            await accountManager.sendDailyReport(client, message, options);
                            return;
                        }

                        else if (moment(target, "DD/MM/YYYY", true).isValid()) {
                            // ✅ /dailyreport 06/11/2025 → নির্দিষ্ট তারিখের সব রিপোর্ট
                            options.date = moment(target, "DD/MM/YYYY").tz("Asia/Dhaka");
                            await accountManager.sendDailyReport(client, message, options);
                            return;
                        }

                        else {
                            await message.reply(
                                "❌ সঠিক ফরম্যাট নয়!\n\n✅ উদাহরণ:\n" +
                                "/dailyreport\n" +
                                "/dailyreport 06/11/2025" +
                                "/dailyreport admin\n" +
                                "/dailyreport admin 06/11/2025\n" +
                                "/dailyreport 8801777123456\n" +
                                "/dailyreport 8801777123456 06/11/2025\n"

                            );
                            return;
                        }

                    } catch (err) {
                        console.error("Daily Report Error:", err);
                        await message.reply(`❌ Daily Report Error: ${err.message}`);
                    }
                    break;

                /*
                                case "/drpt":
                                case "/dailyreport":
                                    try {
                                        const target = args[0];   // "admin" বা ইউজার নাম্বার বা তারিখ
                                        const dateArg = args[1];  // ঐচ্ছিক তারিখ
                
                                        const options = {};
                
                                        // ✅ তারিখ যাচাই
                                        if (dateArg) {
                                            const dateCheck = moment(dateArg, "DD/MM/YYYY", true);
                                            if (!dateCheck.isValid()) {
                                                await message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
                                                return;
                                            }
                                            options.date = dateCheck.tz("Asia/Dhaka");
                                        }
                
                                        if (!target) {
                                            // /dailyreport admin → শুধু অ্যাডমিন সারসংক্ষেপ
                                            options.mode = "adminOnly";
                                            await accountManager.sendDailyReport(client, message, options);
                                            return;
                                        }
                
                                        if (target.toLowerCase() === "user") {
                                            // /dailyreport → সব ইউজার + admin summary
                                            await accountManager.sendDailyReport(client, message, options);
                                            return;
                                        }
                
                                        //  if (target.toLowerCase() === "admin") {   }
                
                                        if (/^\d{11,13}$/.test(target)) {
                                            // /dailyreport 8801777xxxxxx → নির্দিষ্ট ইউজার + admin
                                            options.mode = "singleUser";
                                            options.number = target;
                                            await accountManager.sendDailyReport(client, message, options);
                                            return;
                                        }
                
                                        if (moment(target, "DD/MM/YYYY", true).isValid()) {
                                            // /dailyreport 06/11/2025 → ঐ তারিখের সব রিপোর্ট
                                            options.date = moment(target, "DD/MM/YYYY").tz("Asia/Dhaka");
                                            await accountManager.sendDailyReport(client, message, options);
                                            return;
                                        }
                
                                        // ❌ ভুল ফরম্যাট
                                        await message.reply(
                                            "❌ সঠিক ফরম্যাট নয়!\n\n✅ উদাহরণ:\n" +
                                            "/dailyreport\n" +
                                            "/dailyreport 06/11/2025\n" +
                                            "/dailyreport admin\n" +
                                            "/dailyreport admin 06/11/2025\n" +
                                            "/dailyreport 8801777123456\n" +
                                            "/dailyreport 8801777123456 06/11/2025\n"
                                        );
                                    } catch (err) {
                                        console.error("Daily Report Error:", err);
                                        await message.reply(`❌ Daily Report Error: ${err.message}`);
                                    }
                                    break;
                */
                /*
                 case "/drpt":
                 case "/dailyreport":
                     try {
                         const target = args[0];          // user / phone / date
                         const secondArg = args[1];       // phone or date
                         const thirdArg = args[2];        // date (for user + phone + date)
 
                         const options = {};
 
                         // -----------------------------
                         // Helper Functions
                         // -----------------------------
                         const isPhone = (v) => /^\d{11,14}$/.test(v);
                         const isDate = (v) => moment(v, "DD/MM/YYYY", true).isValid();
 
                         // -----------------------------
                         // Date Validation (Global)
                         // -----------------------------
                         if (secondArg && secondArg.includes("/") && !isDate(secondArg)) {
                             return message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
                         }
                         if (thirdArg && thirdArg.includes("/") && !isDate(thirdArg)) {
                             return message.reply("❌ ভুল তারিখ! সঠিক ফরম্যাট: DD/MM/YYYY");
                         }
 
                         // -----------------------------
                         // CASE 1: No argument → adminOnly (today)
                         // -----------------------------
                         if (!target) {
                             options.mode = "adminOnly";
                             await accountManager.sendDailyReport(client, message, options);
                             return;
                         }
 
                         // -----------------------------
                         // CASE 2: target = "user"
                         // -----------------------------
                         if (target.toLowerCase() === "user") {
 
                             // /dailyreport user
                             if (!secondArg) {
                                 options.mode = "allUser";   // all users today
                                 await accountManager.sendDailyReport(client, message, options);
                                 return;
                             }
 
                             // /dailyreport user <date>
                             if (isDate(secondArg)) {
                                 options.mode = "allUser";
                                 options.date = moment(secondArg, "DD/MM/YYYY").tz("Asia/Dhaka");
                                 await accountManager.sendDailyReport(client, message, options);
                                 return;
                             }
 
                             // /dailyreport user <phone>
                             if (isPhone(secondArg) && !thirdArg) {
                                 options.mode = "singleUser";
                                 options.number = secondArg;
                                 await accountManager.sendDailyReport(client, message, options);
                                 return;
                             }
 
                             // /dailyreport user <phone> <date>
                             if (isPhone(secondArg) && isDate(thirdArg)) {
                                 options.mode = "singleUser";
                                 options.number = secondArg;
                                 options.date = moment(thirdArg, "DD/MM/YYYY").tz("Asia/Dhaka");
                                 await accountManager.sendDailyReport(client, message, options);
                                 return;
                             }
                         }
 
                         // -----------------------------
                         // CASE 3: single phone
                         // /dailyreport 88017xxxxxxx
                         // /dailyreport 88017xxxxxxx <date>
                         // -----------------------------
                         if (isPhone(target)) {
                             options.mode = "adminOnly";
                             options.number = target;
 
                             if (isDate(secondArg)) {
                                 options.date = moment(secondArg, "DD/MM/YYYY").tz("Asia/Dhaka");
                             }
 
                             await accountManager.sendDailyReport(client, message, options);
                             return;
                         }
 
                         // -----------------------------
                         // CASE 4: first arg is date
                         // /dailyreport 06/11/2025
                         // -----------------------------
                         if (isDate(target)) {
                             options.mode = "adminOnly";
                             options.date = moment(target, "DD/MM/YYYY").tz("Asia/Dhaka");
 
                             await accountManager.sendDailyReport(client, message, options);
                             return;
                         }
 
                         // -----------------------------
                         // INVALID FORMAT
                         // -----------------------------
                         await message.reply(
                             "❌ সঠিক ফরম্যাট নয়!\n\n" +
                             "✅ উদাহরণ:\n" +
                             "/dailyreport\n" +
                             "/dailyreport 06/11/2025\n" +
                             "/dailyreport 8801777123456\n" +
                             "/dailyreport 8801777123456 06/11/2025\n" +
                             "/dailyreport user\n" +
                             "/dailyreport user 06/11/2025\n" +
                             "/dailyreport user 8801777123456\n" +
                             "/dailyreport user 8801777123456 06/11/2025\n"
                         );
 
                     } catch (err) {
                         console.error("Daily Report Error:", err);
                         await message.reply(`❌ Daily Report Error: ${err.message}`);
                     }
                     break;
 */

                // ===========================
                // 🔴 mcharge ম্যানুয়াল টাকা কাটা-ok
                // ===========================
                case "/mcharge":
                    try {
                        if (args.length >= 3) {
                            const number = args[0];
                            const amount = parseFloat(args[1]);
                            if (isNaN(amount)) throw new Error("পরিমাণটি সঠিক সংখ্যা নয়।");
                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
                            }
                            const reason = args.slice(2).join(" ") || "Manual Charge";
                            const acc = accountManager.mcharge(number, amount, reason);
                            // অ্যাডমিনকে রিপ্লাই
                            await message.reply(`✅ ${number} থেকে ${amount} টাকা কেটে দেওয়া হয়েছে। Balance: ${acc.balance}, Due: ${acc.due}`);

                            // ইউজার/গ্রাহককে সুন্দরভাবে মেসেজ পাঠানো
                            const mchargeText =
                                `⚠️ *সার্ভিস ম্যানুয়াল চার্জ করা হয়েছে!*
━━━━━━━━━━━━━━━
👤 *Role:* ${acc.role || "Customer"}
💸 *কর্তন পরিমাণ:* ${amount} টাকা
💬 *কারণ:* ${reason}
━━━━━━━━━━━━━━━
💰 *বর্তমান ব্যালেন্স:* ${acc.balance} টাকা
📄 *Due:* ${acc.due}
━━━━━━━━━━━━━━━
অনুগ্রহ করে প্রয়োজনে অফিসে যোগাযোগ করুন।
ধন্যবাদ 🙏`;

                            await safeSend(client, number, mchargeText, 'Src_Msg_Delay');
                        } else {
                            await message.reply("❌ ব্যবহার: /mcharge <নম্বর> <পরিমাণ> [কারণ]");
                        }
                    } catch (err) {
                        console.error("Manual Charge Error:", err);
                        await message.reply(`❌ Manual Charge Error: ${err.message}`);
                    }
                    break;

                // ===========================
                // 🟢 Refund টাকা ফেরত-ok
                // ===========================              
                case "/refund":
                    try {
                        const refundReasons = {
                            1: "সার্ভিস চার্জ ফেরত",
                            2: "ভুল করে টাকা নেয়া হয়েছিল",
                            3: "কাজ সম্পন্ন হয়নি",
                            4: "ডুপ্লিকেট পেমেন্ট",
                            5: "কাজ বাতিল হয়েছে",
                            6: "অন্য কারণে ফেরত"
                        };

                        // 🔹 /refund list দেখানো
                        if (args[0] === "list") {
                            const reasonsList = Object.entries(refundReasons)
                                .map(([key, val]) => `#${key}. ${val}`)
                                .join("\n");
                            return await message.reply(
                                "📋 *রিফান্ড কারণ তালিকা:*\n\n" +
                                reasonsList +
                                "\n\n💡 ব্যবহার:\n/refund <নম্বর> <orderKey>\n" +
                                "অথবা\n/refund <নম্বর> <orderKey> <amount> <reasonCode/custom reason>"
                            );
                        }

                        const number = args[0];
                        if (!number || number.length < 12)
                            return message.reply("❌ country code সহ নাম্বার দিন।");

                        const cmdOrderKey = args[1];
                        let refundAmount, reason, officeNumber = "", officeType = "";

                        // 🔹 AccountManager থেকে history নাও
                        const accData = accountManager.getHistory(number).allHistory[0];
                        const accHistory = accData?.history || [];

                        // 🔹 Duplicate refund prevention
                        const alreadyRefunded = accHistory.some(h => h.type === "refund" && h.OrderKey === cmdOrderKey);
                        if (alreadyRefunded)
                            return message.reply(`❌ ${number} already refunded for orderKey ${cmdOrderKey}`);

                        if (args.length === 2) {
                            // 🔹 Auto refund: মূল charge থেকে amount ও office info নেবে
                            const matchedCharge = accHistory.find(h => h.type === "charge" && h.OrderKey === cmdOrderKey);
                            if (!matchedCharge) {
                                return message.reply(
                                    `❌ এই orderKey-এর charge পাওয়া যায়নি। অনুগ্রহ করে /refund <number> <orderKey> <amount> <reasonCode/custom reason> ব্যবহার করুন।`
                                );
                            }
                            refundAmount = matchedCharge.amount;
                            reason = refundReasons[1]; // default reason
                            officeNumber = matchedCharge.Office_Number || "";
                            officeType = matchedCharge.Office_Type || "";

                        } else if (args.length >= 4) {
                            // 🔹 Manual refund
                            refundAmount = parseFloat(args[2]);
                            if (isNaN(refundAmount) || refundAmount <= 0)
                                return message.reply("❌ সঠিক পরিমাণ দিন।");

                            reason = refundReasons[parseInt(args[3])] || args.slice(3).join(" ");
                            officeNumber = args[4] || "";
                            officeType = args[5] || "";

                        } else {
                            return message.reply(
                                "❌ ব্যবহার:\n" +
                                "/refund <নম্বর> <orderKey>\n" +
                                "অথবা\n" +
                                "/refund <নম্বর> <orderKey> <amount> <reasonCode/custom reason>\n" +
                                "📋 কারণ তালিকা দেখতে: /refund list"
                            );
                        }

                        // 🔹 Refund process
                        const updatedAcc = accountManager.refund(number, refundAmount, reason, cmdOrderKey, officeNumber, officeType);

                        // 🔹 Admin log
                        console.log(`💸 REFUND: ${number} | Amount: ${refundAmount} | Reason: ${reason} | OrderKey: ${cmdOrderKey} | Office: ${officeType} / ${officeNumber}`);

                        // 🔹 Customer message
                        const refundText =
                            `💸 *রিফান্ড সম্পন্ন হয়েছে!*\n━━━━━━━━━━━━━━━\n` +
                            `💵 *ফেরত পাওয়া পরিমাণ:* ${refundAmount} টাকা\n` +
                            `💬 *কারণ:* ${reason}\n` +
                            `🧾 *OrderKey:* ${cmdOrderKey}\n` +
                            `💰 *বর্তমান ব্যালেন্স:* ${updatedAcc.balance} টাকা\n` +
                            `📄 Due: ${updatedAcc.due}\n━━━━━━━━━━━━━━━\n` +
                            `🙏 ধন্যবাদ 💚 আপনার লেনদেনের জন্য।`;

                        await safeSend(client, number, refundText, 'Src_Msg_Delay');

                        // অ্যাডমিনকে রিপ্লাই
                        await message.reply(
                            `💸 ${number} কে ৳${refundAmount} রিফান্ড দেওয়া হয়েছে!\n` +
                            `📄 কারণ: ${reason}\n` +
                            `💰 নতুন ব্যালেন্স: ${updatedAcc.balance}, 🧾 Due: ${updatedAcc.due}`
                        );
                        console.log(`Refund processed for ${number}: ${refundAmount} Tk`);

                    } catch (err) {
                        console.error("Refund error:", err);
                        await message.reply("⚠️ রিফান্ড করতে সমস্যা হয়েছে!");
                    }
                    break;

                // ===========================
                // 🎭 ইউজারের Role পরিবর্তন কমান্ড-ok
                // ===========================
                case "/setrole":
                    try {
                        if (args.length >= 2) {
                            const number = args[0];   // ১ম আর্গুমেন্ট: নাম্বার
                            const role = args[1];     // ২য় আর্গুমেন্ট: নতুন রোল (customer, precustomer ইত্যাদি)
                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
                            }
                            // 🔹 রোল পরিবর্তন করা হচ্ছে
                            const acc = accountManager.setRole(number, role);
                            // অ্যাডমিনকে রিপ্লাই
                            await message.reply(
                                `✅ ${number} এর Role "${role}" সেট করা হয়েছে!\n` +
                                `💰 বর্তমান ব্যালেন্স: ${acc.balance}\n` +
                                `📄 Due: ${acc.due}`
                            );
                            console.log(`🎭 ${number} এর নতুন Role ➜ ${role}`)

                            // 🎯 গ্রাহককে পাঠানোর জন্য সুন্দর মেসেজ
                            const roleChangeText =
                                `🎖️ *আপনার ভূমিকা পরিবর্তন করা হয়েছে!*
━━━━━━━━━━━━━━━
👤 *নাম্বার:* ${number}
🔰 *নতুন Role:* ${acc.role || newRole}
💰 *বর্তমান ব্যালেন্স:* ${acc.balance || 0} টাকা
📄 *Due:* ${acc.due || 0}
━━━━━━━━━━━━━━━
📢 *বার্তা:* আপনার ভূমিকা পরিবর্তন করা হয়েছে সিস্টেম কর্তৃপক্ষের দ্বারা।
🙏 ধন্যবাদ, আপনার সহযোগিতার জন্য।`;

                            await safeSend(client, number, roleChangeText, 'Src_Msg_Delay');
                        } else {
                            await message.reply("⚙️ ব্যবহার: /setrole <নম্বর> <role>\nযেমনঃ /setrole 8801712345678 customer");
                        }
                    } catch (err) {
                        console.error("❌ setrole error:", err);
                        await message.reply("⚠️ Role পরিবর্তন করতে সমস্যা হয়েছে!");
                    }
                    break;

                // ===========================
                // 💬 Due Reminder Message View/Set (Safe Version)
                // ===========================
                case "/duemsg":
                    try {
                        const subCmd = (args[0] || "").toLowerCase(); // get / set
                        const restArgs = args.slice(1); // set হলে বাকি অংশ মেসেজ

                        if (subCmd === "get") {
                            // 🔹 View current due message
                            const replyText = reminderConfig.dueMessageTemplate
                                ? `📋 বর্তমান Due Reminder Message:\n\n${reminderConfig.dueMessageTemplate}`
                                : "ℹ️ কোনো Due reminder message সেট করা হয়নি।";

                            await safeSend(client, message.from, replyText); // ✅ Safe Send
                        }

                        else if (subCmd === "set") {
                            // 🔹 Update due message
                            const newMsg = restArgs.join(" ");
                            if (!newMsg)
                                return await safeSend(client, message.from, "❌ নতুন মেসেজ লিখুন। যেমনঃ /duemsg set আপনার মেসেজ");

                            reminderConfig.dueMessageTemplate = newMsg;
                            fs.writeFileSync(reminderConfigPath, JSON.stringify(reminderConfig, null, 2));

                            await safeSend(client, message.from, "✅ Due reminder message আপডেট করা হয়েছে।");
                        }

                        else {
                            // ❓ Invalid usage help
                            const helpMsg = "❌ ভুল কমান্ড। ব্যবহার করুন:\n\n👉 `/duemsg get`\n👉 `/duemsg set আপনার মেসেজ`";
                            await safeSend(client, message.from, helpMsg);
                        }
                    } catch (err) {
                        console.error("duemsg Error:", err);
                        await safeSend(client, message.from, `❌ Due message প্রসেসিং এ সমস্যা: ${err.message}`);
                    }
                    break;

                // ===========================
                // 🧾 Due List দেখানো -ok
                // ===========================
                case "/duelist":
                    try {
                        // ফরম্যাটেড string রিটার্ন নেওয়া
                        const dueListMsg = accountManager.getDueList({ asString: true });

                        // যদি কোনো due না থাকে
                        if (!dueListMsg) {
                            await message.reply("✅ কোন কাস্টমারের বকেয়া নেই।");
                        } else {
                            await message.reply(dueListMsg);
                        }
                    } catch (err) {
                        console.error("getDueList Error:", err);
                        await message.reply(`❌ Due List দেখানোর সময় error হয়েছে: Error: ${err.message}`);
                    }
                    break;


                // ===========================
                // 💬 Due Reminder WhatsApp (Single or All)
                // ===========================
                case "/dueall":
                    try {
                        const target = args[0]; // প্রথম আর্গুমেন্ট (যদি থাকে)

                        if (target) {
                            // 👉 নির্দিষ্ট নাম্বারকে রিমাইন্ডার পাঠানো
                            const number = target.replace(/\D/g, ""); // শুধুমাত্র সংখ্যা নেবে

                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                await message.reply("❌ অনুগ্রহ করে কান্ট্রি কোড সহ নাম্বার দিন! যেমন: 8801777283248");
                                break;
                            }

                            const acc = accountManager.getSummary(number);
                            if (!acc) {
                                await message.reply("❌ এই নম্বরের কোনো অ্যাকাউন্ট পাওয়া যায়নি!");
                                break;
                            }

                            // যদি due না থাকে
                            if (acc.due <= 0) {
                                await message.reply(`✅ ${number} (${acc.role})-এর কোনো বকেয়া নেই।`);
                                break;
                            }

                            // reminderConfig থেকে টেমপ্লেট নিয়ে কাস্টমাইজ করা
                            let msg = reminderConfig.dueMessageTemplate
                                .replace("{role}", acc.role)
                                .replace("{due}", acc.due)
                                .replace("{sr}", 1);

                            await safeSend(client, number, msg, "ReplyDelay");

                            await message.reply(`✅ ${number} (${acc.role})-কে due reminder পাঠানো হয়েছে।`);
                        } else {
                            // 👉 সবার জন্য due reminder পাঠানো
                            const count = await accountManager.sendDueReminder(message.client);
                            await message.reply(`✅ মোট ${count} জন কাস্টমারকে due reminder পাঠানো হয়েছে।`);
                        }
                    } catch (err) {
                        console.error("dueall Error:", err);
                        await message.reply(`❌ Due Reminder পাঠানোর সময় সমস্যা হয়েছে: ${err.message}`);
                    }
                    break;

                // ===========================
                // ⚙️ Set Charge Rate-OK
                // ===========================
                /*             case "/setcharge":
                                 try {
                                     const [role, autoChargeStr] = args;
                                     const autoCharge = parseFloat(autoChargeStr);
             
                                     accountManager.setChargeRate(role, autoCharge);
             
                                     await message.reply(`✅ Charge updated for role "${role}".`);
                                 } catch (err) {
                                     console.error("setcharge Error:", err);
                                     await message.reply(`❌ Charge update error: ${err.message}`);
                                 }
                                 break; */
                case "/setcharge":
                    try {
                        if (args[0].toLowerCase() === "add") {
                            const [, role, autoChargeStr] = args;
                            const autoCharge = parseFloat(autoChargeStr);

                            const result = accountManager.addChargeRate(role, autoCharge);

                            if (result.success) {
                                await message.reply(`✅ New role "${role}" added with charge ${autoCharge}.`);
                            } else {
                                await message.reply(result.message);
                            }

                        } else {
                            const [role, autoChargeStr] = args;
                            const autoCharge = parseFloat(autoChargeStr);

                            const result = accountManager.setChargeRate(role, autoCharge);

                            if (result.success) {
                                await message.reply(`✅ Charge updated for role "${result.role}".`);
                            } else {
                                await message.reply(result.message);
                            }
                        }
                    } catch (err) {
                        console.error("setcharge Error:", err);
                        await message.reply(`❌ Charge update error: ${err.message}`);
                    }
                    break;

                // ===========================
                // 📊 Get Summary -ok
                // ===========================
                case "/getsum":
                    try {
                        if (args.length === 1) {
                            const number = args[0];
                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return message.reply("❌ কান্ট্রি কোড সহ নাম্বার যুক্ত করুন!");
                            }
                            const acc = accountManager.getSummary(number);
                            await message.reply(`📋 Account Summary:\n🔹 Number: ${number}\n🔹 Role: ${acc.role}\n💰 Balance: ${acc.balance}\n💳 Due: ${acc.due}`);
                        } else {
                            await message.reply("❌ ব্যবহার: /getsum <নম্বর>");
                        }
                    } catch (err) {
                        console.error("getSummary Error:", err);
                        await message.reply(`❌ Account Summary দেখানোর সময় error হয়েছে: ${err.message}`);
                    }
                    break;

                // ===========================
                // 📜 Get Transaction History (Professional)
                // ===========================
                case "/gethis":
                    try {
                        const args = message.body.trim().split(" ").slice(1);
                        let number = null;
                        let date = null;

                        // 🔹 আর্গুমেন্ট চেক
                        if (args.length === 1) {
                            if (/^\d{13}$/.test(args[0])) {
                                number = args[0];
                            } else if (moment(args[0], "DD/MM/YYYY", true).isValid()) {
                                date = args[0];
                            } else {
                                return message.reply("❌ সঠিক ফরম্যাট ব্যবহার করুন!\n\n✅ উদাহরণ:\n/gethis\n/gethis 06/11/2025\n/gethis 8801777123456\n/gethis 8801777123456 06/11/2025");
                            }
                        } else if (args.length === 2) {
                            if (/^\d{13}$/.test(args[0]) && moment(args[1], "DD/MM/YYYY", true).isValid()) {
                                number = args[0];
                                date = args[1];
                            } else {
                                return message.reply("❌ সঠিক ফরম্যাট ব্যবহার করুন!\n\n✅ উদাহরণ:\n/gethis 8801777123456 06/11/2025");
                            }
                        }

                        const { dateLabel, allHistory } = accountManager.getHistory(number, date);

                        if (allHistory.length === 0) {
                            return message.reply(`ℹ️ ${dateLabel} তারিখের কোনো Transaction History পাওয়া যায়নি।`);
                        }

                        // 🔹 মেসেজ তৈরি
                        let msg = `📜 *${dateLabel} তারিখের Transaction History*\n\n`;
                        allHistory.forEach(acc => {
                            msg += `🔹 Number: ${acc.number} | Role: ${acc.role}\n`;
                            acc.history.forEach((h, i) => {
                                msg += `   ${i + 1}. ${h.type} | ৳${h.amount} | ${h.reason || "-"} | ${h.timestamp}\n`;
                            });
                            msg += `\n`;
                        });

                        // 🔹 পাঠানোর লজিক
                        if (!number) {
                            // শুধু এডমিনে পাঠানো হবে
                            await message.reply(msg);
                        } else {
                            // ইউজার ও এডমিন উভয়কে পাঠানো
                            await client.sendMessage(`${number}@c.us`, msg); // ইউজারকে পাঠানো
                            await message.reply(`📤 ${number} এর Transaction History:\n\n${msg}`); // এডমিনকে পাঠানো
                        }

                    } catch (err) {
                        console.error(err);
                        await message.reply(`❌ Error: ${err.message}`);
                    }
                    break;



                // Inside your switch(command)
                case "/pause":
                    isPaused = true;
                    await message.reply("❌ অফিস বন্ধ করা হয়েছে!");
                    break;

                case "/resume":
                    isPaused = false;
                    botPaused = false;
                    processQueue(); // Start processing if resumed
                    await message.reply("✅ অফিস চালু করা হয়েছে!");
                    break;

                case "/status":
                    const chargeRates = accountManager.chargeRates;
                    // 🔍 Debug Line (এখানেই বসবে)
                    //  console.log("STATUS chargeRates:", chargeRates);
                    const chargeRatesText = Object.entries(chargeRates)
                        .map(([role, data]) => `- **${role}**: ${data.autoCharge} টাকা`)
                        .join("\n");
                    const statusMessage =
                        `✅ **বট স্ট্যাটাস:**\n` +
                        `- **Bot Status**:${isPaused ? "❌ অফিস বন্ধ" : "✅ অফিস চালু"}\n\n` +
                        `- **Admin Numbers**:\n${AdminNumber || "নির্ধারিত হয়নি"}\n\n` +
                        `- **SignCopy Sender Office**:\n${SignCopy_SenderOfficeNumber || "নির্ধারিত হয়নি"}\n\n` +
                        `- **Nid Make Sender Office**:\n${Nid_Make_OfficeNumber || "নির্ধারিত হয়নি"}\n\n` +
                        `- 📌 **চার্জ রেটসমূহ**:\n${chargeRatesText}`;

                    await message.reply(statusMessage);
                    break;

                case "/cuslist":
                    const cuslist = `
    ✅ **বট স্ট্যাটাস:**
    - **Bot Status**: ${isPaused ? "❌ অফিস বন্ধ" : "✅ অফিস চালু"}

    - **Ignore Due List**:
    ${Order_Rcvd_CustomerNumber.length > 0 ? Order_Rcvd_CustomerNumber.map((entry, index) => `${index + 1}. ${entry.name} (${entry.number})`).join("\n") : "কোনো নম্বর নেই!"}

    - **Pre Customer Number**: 
    ${Pre_CustomerNumber.length > 0 ? Pre_CustomerNumber.map((entry, index) => `${index + 1}. ${entry.name} (${entry.number})`).join("\n") : "কোনো নম্বর নেই!"}

    - **Customer Numbers**:
    ${CustomerNumber.length > 0 ? CustomerNumber.map((entry, index) => `${index + 1}. ${entry.name} (${entry.number})`).join("\n") : "কোনো নম্বর নেই!"}
    `;
                    await message.reply(cuslist);
                    break;

                case "/cmd":
                    const cmdMessage = ` 
                        \n /dp - জমা(নাম্বার টাকা)
                        \n /dailyreport - হিসাব পাঠানো
                        \n /mcharge - ম্যানুয়াল সার্ভিস চার্জ করা
                        \n /refund - রিফন্ড / ফেরত
                        \n /setrole - কস্টমারের রোল
                        \n /duelist - বকেয়ার তালিকা
                        \n /getduemsg - বকেয়া msg text দেখা  
                        \n /setduemsg - বকেয়া msg text সেট
                        \n /dueall - বকেয়া রিমাইন্ডার সকল। ব্যবহার: /dueall নাম্বার

                        \n /setcharge - সার্ভিস চার্জ সেট
                        \n /getsum - নাম্বারের সামারি
                        \n /gethis - নাম্বারের হিস্টরি               
                        \n /pause - বট পজ
                        \n /resume - বট রিসাম        
                        \n /status - বট স্ট্যাটাস দেখানো  
                        \n /cuslist - কাস্টমার লিস্ট দেখানো         
                        \n /cmd - কমান্ড লিস্ট দেখানো
                        \n /a_sign - SignCopy অফিস সেট             
                        \n /r_sign - SignCopy অফিস রিমুভ
                        \n /a_pre - Pre_Customer যোগ               
                        \n /r_pre - Pre_Customer রিমুভ               
                        \n /a_rcv - Order Rcvd Customer যোগ               
                        \n /r_rcv - Order Rcvd Customer রিমুভ              
                        \n /a_cus - Customer যোগ               
                        \n /r_cus - Customer রিমুভ
                        \n /msg "cus/pre" - কাস্টমার/প্রি কাস্টমার মেসেজ পাঠানো
                `;
                    await message.reply(cmdMessage);
                    break;

                // case "/a_pre"
                case "/a_pre":
                    // আর্গুমেন্ট চেক করা
                    if (args.length === 2) {
                        const rawNumber = args[0];  // প্রথম আর্গুমেন্ট: নম্বর
                        const name = args[1];  // দ্বিতীয় আর্গুমেন্ট: নাম
                        try {
                            // ============================
                            // 🔹 নাম্বার যাচাই ও যোগ করা
                            // ============================
                            await addNumberToList(Pre_CustomerNumber, rawNumber, name, {
                                saveConfig, message, client,
                                listName: "Pre_CustomerNumber",
                                dmText: "✅ আপনাকে Auto Bot সার্ভিসে, \n Pre_CustomerNumber হিসেবে যুক্ত করা হয়েছে। \n সর্বচ্য দ্রুত সেবা প্রদানে আমরা প্রতিজ্ঞাবদ্ধ",
                                delayType: "MsgForwardDelay"  // বিলম্বের জন্য র্যান্ডম ডিলে টাইপ ব্যবহার করা হচ্ছে
                            });

                            const number = rawNumber.replace(/\D/g, ""); // শুধু সংখ্যা রাখবে
                            // কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return message.reply("❌ অনুগ্রহ করে কান্ট্রি কোডসহ নাম্বার দিন!\nযেমন: 8801777283248");
                            }

                            // ============================
                            // 💾 অ্যাকাউন্ট তৈরি / আপডেট
                            // ============================
                            const accPath = path.join(__dirname, "UserAccounts", `${number}.json`);
                            let acc;

                            if (fs.existsSync(accPath)) {
                                // 🔁 অ্যাকাউন্ট আগে থেকেই আছে → শুধু Role আপডেট করবো
                                acc = JSON.parse(fs.readFileSync(accPath));
                                acc.role = "Pre_Customer";
                                acc.updatedAt = new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" });
                            } else {
                                // 🆕 নতুন অ্যাকাউন্ট তৈরি করবো
                                acc = {
                                    number,
                                    role: "Pre_Customer",
                                    balance: 0,
                                    due: 0,
                                    createdAt: new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" }),
                                    updatedAt: new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" }),
                                    history: [],
                                };
                            }

                            // ✅ অ্যাকাউন্ট সেভ করা
                            fs.writeFileSync(accPath, JSON.stringify(acc, null, 2));

                            // await message.reply(`✅ ${name} (${number}) সফলভাবে Customer হিসেবে সেট করা হয়েছে!`);
                            // ✅ অ্যাডমিনকে রিপ্লাই মেসেজ
                            await message.reply(
                                `👤 নতুন Pre_Customer অ্যাকাউন্ট তৈরি হয়েছে!\n` +
                                `📞 নাম্বার: ${number}\n` +
                                `🧾 নাম: ${name}\n` +
                                `🎭 Role: ${acc.role}\n` +
                                `💰 Balance: ${acc.balance}\n` +
                                `📄 Due: ${acc.due}`
                            );

                            // ✅ কাস্টমারকে DM পাঠানো (safeSend দিয়ে)
                            const dmText =
                                `🌟 প্রিয় ${name},\n\n` +
                                `আপনার জন্য Auto Bot সার্ভিসে একটি অ্যাকাউন্ট তৈরি করা হয়েছে।\n\n` +
                                `🎭 Role: ${acc.role}\n` +
                                `💰 বর্তমান ব্যালেন্স: ${acc.balance}\n` +
                                `📄 Due: ${acc.due}\n\n` +
                                `আমাদের সার্ভিস ব্যবহারের জন্য ধন্যবাদ 🙏`;

                            await safeSend(client, number, dmText, "ReplyDelay");
                        } catch (err) {
                            console.error("⚠ প্রি কাস্টমার যোগ করতে সমস্যা হয়েছে:", err);
                            await message.reply(`⚠ প্রি কাস্টমার যোগ করতে সমস্যা হয়েছে:\n${err.message}`);
                        }
                    } else {
                        // যদি আর্গুমেন্ট কম থাকে (২টি আর্গুমেন্ট না থাকে)
                        await message.reply("❌ অনুগ্রহ করে একটি নম্বর এবং নাম দিন!\nব্যবহার: /a_cus 8801777283248 Rahim");
                    }
                    break;

                // case "/r_pre"
                case "/r_pre":
                    if (args.length === 1) {
                        await removeNumberFromList(Pre_CustomerNumber, args[0], {
                            saveConfig, message, client,
                            listName: "Pre_CustomerNumber",
                            dmTextIfRemoved: "❌ আপনাকে Auto Bot সার্ভিসে, \n Pre_CustomerNumber তালিকা থেকে রিমুভ করা হয়েছে।",
                            delayType: "MsgForwardDelay"
                        });
                    } else { await message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!"); }
                    break;

                // case "/a_rcv"
                case "/a_rcv":
                    // আর্গুমেন্ট চেক করা
                    if (args.length === 2) {
                        const rawNumber = args[0];  // প্রথম আর্গুমেন্ট: নম্বর
                        const name = args[1];  // দ্বিতীয় আর্গুমেন্ট: নাম

                        // নতুন নাম্বার এবং নাম যোগ করার জন্য addNumberToList ফাংশন কল করা
                        await addNumberToList(Order_Rcvd_CustomerNumber, rawNumber, name, {
                            saveConfig, message, client,
                            listName: "Order_Rcvd_CustomerNumber",
                            dmText: "✅ আপনাকে Auto Bot সার্ভিসের,\n Ignore Due List এর তালিকাতে যুক্ত করা হয়েছে। \n এখন থেকে আপনার বকেয়া থাকলেও কাজ গ্রহন করা হবে। \n সর্বচ্য দ্রুত সেবা প্রদানে আমরা প্রতিজ্ঞাবদ্ধ",
                            delayType: "PdfForwardDelay"
                        });
                    } else {
                        // যদি আর্গুমেন্ট কম থাকে (২টি আর্গুমেন্ট না থাকে)
                        await message.reply("❌ অনুগ্রহ করে একটি নম্বর এবং নাম দিন!");
                    }
                    break;

                // case "/r_rcv"
                case "/r_rcv":
                    if (args.length === 1) {
                        await removeNumberFromList(Order_Rcvd_CustomerNumber, args[0], {
                            saveConfig, message, client,
                            listName: "Order_Rcvd_CustomerNumber",
                            dmTextIfRemoved: "❌ আপনাকে Auto Bot সার্ভিসে, \n SignCopy রিসিভার তালিকা থেকে রিমুভ করা হয়েছে।",
                            delayType: "PdfForwardDelay"
                        });
                    } else { await message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!"); }
                    break;

                // case "/a_sign"
                case "/a_sign":
                    if (args.length === 1) {
                        await setSignCopyOffice(args[0], {
                            saveConfig, message, client,
                            dmText: "✅ আপনাকে Auto Bot সার্ভিসে, \n SignCopy Sender Office হিসেবে সেট করা হয়েছে। \n দ্রুত সেবা প্রদানেই আমাদের উদ্দেশ্য",
                            delayType: "ReactDelay"
                        });
                    } else { await message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!"); }
                    break;

                // case "/r_sign"
                case "/r_sign":
                    if (args.length === 1) {
                        await removeSignCopyOffice(args[0], {
                            saveConfig, message, client,
                            dmTextIfRemoved: "❌ আপনাকে Auto Bot সার্ভিসে, \n SignCopy Sender Office থেকে রিমুভ করা হয়েছে।",
                            delayType: "ReactDelay"
                        });
                    } else { await message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!"); }
                    break;

                // 🔹 NID Make Office সেট করা
                case "/a_nid":
                    try {
                        const number = args[0];
                        await setNidMakeOffice(number, { saveConfig, message, client });
                    } catch (err) {
                        console.error("Error in /setnid:", err);
                        await message.reply("❌ NID Make Office সেট করতে সমস্যা হয়েছে!");
                    }
                    break;

                // 🔹 NID Make Office রিমুভ করা
                case "/r_nid":
                    try {
                        const number = args[0];
                        await removeNidMakeOffice(number, { saveConfig, message, client });
                    } catch (err) {
                        console.error("Error in /removenid:", err);
                        await message.reply("❌ NID Make Office রিমুভ করতে সমস্যা হয়েছে!");
                    }
                    break;

                // case "/a_cus"
                case "/a_cus":
                    if (args.length === 2) {
                        const rawNumber = args[0]; // প্রথম আর্গুমেন্ট: নাম্বার
                        const name = args[1]; // দ্বিতীয় আর্গুমেন্ট: নাম

                        try {
                            // ============================
                            // 🔹 নাম্বার যাচাই ও যোগ করা
                            // ============================
                            await addNumberToList(CustomerNumber, rawNumber, name, {
                                saveConfig, message, client,
                                listName: "CustomerNumber",
                                dmText: "✅ আপনাকে Auto Bot সার্ভিসে, \n Customer হিসেবে যুক্ত করা হয়েছে। \n সর্বচ্য দ্রুত সেবা প্রদানে আমরা প্রতিজ্ঞাবদ্ধ",
                                delayType: "ReplyDelay"
                            });

                            const number = rawNumber.replace(/\D/g, ""); // শুধু সংখ্যা রাখবে
                            // 🔍 কান্ট্রি কোড চেক (country code সহ)
                            if (!number || number.length < 12) {
                                return await message.reply("❌ অনুগ্রহ করে কান্ট্রি কোডসহ নাম্বার দিন!\nযেমন: 8801777283248");
                            }


                            // ============================
                            // 💾 অ্যাকাউন্ট তৈরি / আপডেট
                            // ============================
                            const accPath = path.join(__dirname, "UserAccounts", `${number}.json`);
                            let acc;

                            if (fs.existsSync(accPath)) {
                                // 🔁 অ্যাকাউন্ট আগে থেকেই আছে → শুধু Role আপডেট করবো
                                acc = JSON.parse(fs.readFileSync(accPath));
                                acc.role = "Customer";
                                acc.updatedAt = new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" });
                            } else {
                                // 🆕 নতুন অ্যাকাউন্ট তৈরি করবো
                                acc = {
                                    number,
                                    role: "Customer",
                                    balance: 0,
                                    due: 0,
                                    createdAt: new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" }),
                                    updatedAt: new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" }),
                                    history: [],
                                };
                            }

                            // ✅ অ্যাকাউন্ট সেভ করা
                            fs.writeFileSync(accPath, JSON.stringify(acc, null, 2));


                            // await message.reply(`✅ ${name} (${number}) সফলভাবে Customer হিসেবে সেট করা হয়েছে!`);
                            // ✅ অ্যাডমিনকে রিপ্লাই মেসেজ
                            await message.reply(
                                `👤 নতুন Customer অ্যাকাউন্ট তৈরি হয়েছে!\n` +
                                `📞 নাম্বার: ${number}\n` +
                                `🧾 নাম: ${name}\n` +
                                `🎭 Role: ${acc.role}\n` +
                                `💰 Balance: ${acc.balance}\n` +
                                `📄 Due: ${acc.due}`
                            );

                            // ✅ কাস্টমারকে DM পাঠানো (safeSend দিয়ে)
                            const dmText =
                                `🌟 প্রিয় ${name},\n\n` +
                                `আপনার জন্য Auto Bot সার্ভিসে একটি অ্যাকাউন্ট তৈরি করা হয়েছে।\n\n` +
                                `🎭 Role: ${acc.role}\n` +
                                `💰 বর্তমান ব্যালেন্স: ${acc.balance}\n` +
                                `📄 Due: ${acc.due}\n\n` +
                                `আমাদের সার্ভিস ব্যবহারের জন্য ধন্যবাদ 🙏`;

                            await safeSend(client, number, dmText, "ReplyDelay");

                        } catch (err) {
                            console.error("⚠ কাস্টমার যোগ করতে সমস্যা হয়েছে:", err);
                            await message.reply(`⚠ কাস্টমার যোগ করতে সমস্যা হয়েছে:\n${err.message}`);
                        }

                    } else {
                        await message.reply("❌ অনুগ্রহ করে একটি নাম্বার এবং নাম দিন!\nব্যবহার: /a_cus 8801777283248 Rahim");
                    }
                    break;

                // case "/a_cus"
                case "/r_cus":
                    if (args.length === 1) {
                        await removeNumberFromList(CustomerNumber, args[0], {
                            saveConfig, message, client,
                            listName: "CustomerNumber",
                            dmTextIfRemoved: "❌ আপনাকে Auto Bot সার্ভিসে, \n Customer তালিকা থেকে রিমুভ করা হয়েছে।",
                            delayType: "ReplyDelay"
                        });
                    } else { await message.reply("❌ অনুগ্রহ করে একটি নম্বর দিন!"); }
                    break;

                // 🔹 Unified Message Sender: /msg pre | /msg cus | /msg all
                case "/msg":
                    if (args.length < 2) {
                        await message.reply("❌ ব্যবহার: /msg pre <message> অথবা /msg cus <message> অথবা /msg all <message>");
                        break;
                    }

                    const targetGroup = args.shift().trim().toLowerCase(); // pre | cus | all
                    const customMessage = args.join(" ");
                    const messageToSend = `${customMessage}\n\nSent by AutoBot Admin 🤖`;

                    // কোন লিস্টে পাঠাবে নির্ধারণ
                    let targetList = [];
                    if (targetGroup === "pre") {
                        targetList = Pre_CustomerNumber || [];
                    } else if (targetGroup === "cus") {
                        targetList = CustomerNumber || [];
                    } else if (targetGroup === "all") {
                        // pre + cus দুই লিস্ট একত্র
                        targetList = [...(Pre_CustomerNumber || []), ...(CustomerNumber || [])];
                    } else {
                        await message.reply("❌ ভুল গ্রুপ! ব্যবহার করুন: pre, cus, অথবা all");
                        break;
                    }

                    if (targetList.length === 0) {
                        await message.reply(`⚠️ কোনো ${targetGroup.toUpperCase()} গ্রুপে নাম্বার পাওয়া যায়নি।`);
                        break;
                    }

                    // 🔸 প্রতিটি নাম্বারে নিরাপদে পাঠানো
                    let successCount = 0;
                    for (const entry of targetList) {
                        try {
                            const targetRaw = (typeof entry === "string") ? entry : entry?.number;
                            if (!targetRaw) continue;

                            const target = toJid(normalizePhone(targetRaw));
                            await safeSend(client, target, messageToSend);
                            successCount++;
                        } catch (error) {
                            console.error(`❌ বার্তা পাঠাতে ব্যর্থ হয়েছে:`, error);
                        }
                    }
                    // ✅ সব পাঠানো শেষে একবার রিপোর্ট দাও
                    let groupLabel = "";
                    if (targetGroup === "pre") groupLabel = "Pre_Customer";
                    else if (targetGroup === "cus") groupLabel = "Customer";
                    else groupLabel = "All_Customer";

                    await message.reply(`✅ ${groupLabel} গ্রুপে মোট ${successCount} জনকে বার্তা পাঠানো হয়েছে।`);

                    break;

                default:

                    await message.reply("❌ অজানা কমান্ড! সব কমান্ড দেখতে: cmd ব্যবহার করুন");
                    break;
            }

        } else if (isPre_Customer) { // Only Pre_CustomerNumber-specific commands are 
            switch (command) {

                case "/pcmd":
                    const cmdMessage = `
✅ **আপনার জন্য জন্য কমান্ড সমুহঃ**
\n **কোন কমান্ড কি কাজ করবেঃ**
      \n /scmd = আপনি কোন কমান্ড ব্যবহার করতে পারবেন তা দেখাবে।
      \n /sstatus = আপনার বিস্তারিত দেখাবে।
      \n /soffice = SignCopySenderOffice অফিসে মেসেজ পাঠাতে পারবেন।
        `;
                    await message.reply(cmdMessage);
                    break;

                case "/pstatus":
                    const chargeRates = accountManager.chargeRates;
                    const allowedRoles = ["SignCopy"];
                    const roleNames = {
                        SignCopy: "📇SignCopy:"
                    };
                    const chargeRatesText = Object.entries(chargeRates)
                        .filter(([role]) => allowedRoles.includes(role))
                        .map(([role, data]) => `- **${roleNames[role] || role}**: ${data.autoCharge} টাকা`)
                        .join("\n");

                    const statusMessage =
                        `✅ **বট স্ট্যাটাস:**\n` +
                        `- **Bot Status**: ${isPaused ? "❌ অফিস বন্ধ" : "✅ অফিস চালু"}\n` +
                        `- **UserType**: Pre_CustomerNumber\n` +
                        `- 📌 **চার্জ রেটসমূহ**:\n${chargeRatesText}\n`
                        ;
                    await message.reply(statusMessage);
                    break;

                // --------- SignCopy Sender Office send message command ---------
                case "/poffice":
                    if (args.length > 0) {
                        const customMessage = args.join(" "); // কাস্টম বার্তা তৈরি করতে সমস্ত যুক্তি যোগ করুন

                        // নিশ্চিত করুন যে SignCopy_SenderOfficeNumber এর নাম্বার সঠিকভাবে লোড হয়েছে
                        loadConfig();  // SignCopy_SenderOfficeNumber নাম্বার আপ-টু-ডেট আছে কিনা তা নিশ্চিত করতে কনফিগারেশন পুনরায় লোড করুন।

                        // মেসেজের মধ্যে কোনো নাম্বার আছে কিনা চেক করা হচ্ছে
                        const MsgBodyNumChaker = customMessage.match(/\d/);

                        if (MsgBodyNumChaker) { // যদি কোনো নাম্বার থাকে, মেসেজ স্কিপ এবং "❌" রিয়েকশন দিয়ে রিপ্লাই করা হবে
                            await message.react("❌");
                            await message.reply("❌ মেসেজে কোনো নাম্বার থাকতে পারবে না!");
                            console.log(`❌ Skip Message: ${customMessage} due to number presence`);
                            return; // কাজ থামিয়ে দিবে
                        } else { // যদি নাম্বার না থাকে
                            await message.react("👍"); // "👍" রিয়েকশন দিয়ে পরবর্তী কাজ শুরু করা হবে 

                            try {
                                // প্রফেশনাল বার্তা যোগ করা হচ্ছে Customer ইমোজি সহ
                                const messageToSend = `${customMessage}\n\nSent by Sub Admin 🙋‍♂️`; // কাস্টম বার্তা এবং রোবট ইমোজি

                                // SignCopy_SenderOfficeNumber নম্বরে কাস্টম বার্তা পাঠান
                                await client.sendMessage(SignCopy_SenderOfficeNumber, messageToSend);
                                console.log(`📤 আপনার বার্তা পাঠানো হয়েছে ${SignCopy_SenderOfficeNumber}: ${messageToSend}`);

                                // এলোমেলো বিলম্ব প্রয়োগ করুন (randomDelay ফাংশন ব্যবহার করে)
                                const Src_Msg_Delay = randomDelay('Src_Msg_Delay');  // বিলম্বের জন্য 'Src_Msg_Delay' টাইপ ব্যবহার করুন

                                // বিলম্ব সময় কনসোল লগে দেখানো
                                console.log(`Random delay for ${SignCopy_SenderOfficeNumber}: Time: ${Src_Msg_Delay}ms`);

                                // বিলম্ব প্রয়োগ setTimeout দিয়ে বিলম্ব প্রয়োগ করা হয়েছে
                                await new Promise(resolve => setTimeout(resolve, Src_Msg_Delay));

                            } catch (error) {
                                console.error(`❌ বার্তা পাঠাতে ব্যর্থ হয়েছে ${SignCopy_SenderOfficeNumber}`, error);
                            }
                            await message.reply("✅ আপনার বার্তা SignCopy Sender Office এ পাঠানো হয়েছে।!");
                        }

                    } else {
                        await message.reply("❌ নম্বরে বার্তা পাঠানোর জন্য কিছু লিখুন!");
                    }
                    break;

                // এখানে আরোও কমান্ড যুক্ত করতে পারবেন।


                default:
                    await message.reply("❌ অজানা কমান্ড! \n আপনার UserType: Sub Admin ! \n অনুমদিত কমান্ড দেখতে: /scmd ব্যবহার করুন");
                    break;
            }
        } else if (isCustomer) { // Only CustomerNumber-specific commands are 
            switch (command) {

                case "/ccmd":
                    const ccmdMessage = `
✅ **আপনার জন্য জন্য কমান্ড সমুহঃ**
\n **কোন কমান্ড কি কাজ করবেঃ**
      \n /ccmd = আপনি কোন কমান্ড ব্যবহার করতে পারবেন তা দেখাবে।
      \n /cstatus = আপনার বিস্তারিত দেখাবে।
      \n /coffice = SignCopySenderOffice অফিসে মেসেজ পাঠাতে পারবেন।
        `;
                    await message.reply(ccmdMessage);
                    break;

                case "/cstatus":
                    const chargeRates = accountManager.chargeRates;
                    const allowedRoles = ["NidPdf", "SarverCopy", "UnSarverCopy"];
                    const roleNames = {
                        NidPdf: "📇Nid Card: ",
                        SarverCopy: "📄Official SarverCopy: ",
                        UnSarverCopy: "📃UnOfficial SarverCopy: "
                    };
                    const chargeRatesText = Object.entries(chargeRates)
                        .filter(([role]) => allowedRoles.includes(role))
                        .map(([role, data]) => `- **${roleNames[role] || role}**: ${data.autoCharge} টাকা`)
                        .join("\n");
                    const cstatusMessage =
                        `✅ **বট স্ট্যাটাস:**\n` +
                        `- **Bot Status**: ${isPaused ? "❌ অফিস বন্ধ" : "✅ অফিস চালু"}\n` +
                        `- **UserType**: Customer\n` +
                        `- 📌 **চার্জ রেটসমূহ**:\n${chargeRatesText}\n`
                        ;
                    await message.reply(cstatusMessage);
                    break;

                // --------- SignCopy Sender Office send message command ---------
                case "/coffice":
                    if (args.length > 0) {
                        const customMessage = args.join(" "); // কাস্টম বার্তা তৈরি করতে সমস্ত যুক্তি যোগ করুন

                        // নিশ্চিত করুন যে SignCopySenderOffice এর নাম্বার সঠিকভাবে লোড হয়েছে
                        loadConfig();  // SignCopySenderOffice নাম্বার আপ-টু-ডেট আছে কিনা তা নিশ্চিত করতে কনফিগারেশন পুনরায় লোড করুন।

                        // মেসেজের মধ্যে কোনো নাম্বার আছে কিনা চেক করা হচ্ছে
                        const MsgBodyNumChaker = customMessage.match(/\d/);

                        if (MsgBodyNumChaker) { // যদি কোনো নাম্বার থাকে, মেসেজ স্কিপ এবং "❌" রিয়েকশন দিয়ে রিপ্লাই করা হবে
                            await message.react("❌");
                            await message.reply("❌ মেসেজে কোনো নাম্বার থাকতে পারে না!");
                            console.log(`❌ Skip Message: ${customMessage} due to number presence`);
                            return; // কাজ থামিয়ে দিবে
                        } else { // যদি নাম্বার না থাকে
                            await message.react("👍"); // "👍" রিয়েকশন দিয়ে পরবর্তী কাজ শুরু করা হবে 

                            try {
                                // প্রফেশনাল বার্তা যোগ করা হচ্ছে Customer ইমোজি সহ
                                const messageToSend = `${customMessage} \n\nSent by Customer 🙋‍♂️`; // কাস্টম বার্তা এবং রোবট ইমোজি

                                // SignCopy_SenderOfficeNumber নম্বরে কাস্টম বার্তা পাঠান
                                await client.sendMessage(SignCopy_SenderOfficeNumber, messageToSend);
                                console.log(`📤 আপনার বার্তা পাঠানো হয়েছে ${SignCopy_SenderOfficeNumber}: ${messageToSend} `);

                                // এলোমেলো বিলম্ব প্রয়োগ করুন (randomDelay ফাংশন ব্যবহার করে)
                                const Src_Msg_Delay = randomDelay('Src_Msg_Delay');  // বিলম্বের জন্য 'Src_Msg_Delay' টাইপ ব্যবহার করুন

                                // বিলম্ব সময় কনসোল লগে দেখানো
                                console.log(`Random delay for ${SignCopy_SenderOfficeNumber}: Time: ${Src_Msg_Delay} ms`);

                                // বিলম্ব প্রয়োগ setTimeout দিয়ে বিলম্ব প্রয়োগ করা হয়েছে
                                await new Promise(resolve => setTimeout(resolve, Src_Msg_Delay));

                            } catch (error) {
                                console.error(`❌ বার্তা পাঠাতে ব্যর্থ হয়েছে ${SignCopy_SenderOfficeNumber} `, error);
                            }
                            await message.reply("✅ আপনার বার্তা Office পাঠানো হয়েছে।!");
                        }

                    } else {
                        await message.reply("❌ নম্বরে বার্তা পাঠানোর জন্য কিছু লিখুন!");
                    }
                    break;

                // এখানে আরোও কমান্ড যুক্ত করতে পারবেন।


                default:
                    await message.reply("❌ অজানা কমান্ড! \n আপনার UserType: Customer! \n অনুমদিত কমান্ড দেখতে: /ccmd ব্যবহার করুন");
                    break;
            }
        } else if (isSignCopySenderOffice) { // Only isSignCopySenderOffice-specific commands are 
            switch (command) {

                case "/ocmd":
                    const ocmdMessage = `
✅ ** আপনার জন্য জন্য কমান্ড সমুহঃ **

                    \n / ocmd
                    \n / ostatus
                    \n / op_msg
                        `;
                    await message.reply(ocmdMessage);
                    break;

                case "/ostatus":

                    const ostatusMessage = `
        ✅ ** বট স্ট্যাটাস:**
        - ** Bot Status **: ${isPaused ? "❌ অফিস বন্ধ" : "✅ ❌ অফিস চালু"}
        - ** UserType **: SignCopySenderOffice
        `;
                    await message.reply(ostatusMessage);
                    break;

                case "/op_msg":
                    if (args.length > 0) {
                        const customMessage = args.join(" "); // কাস্টম বার্তা তৈরি করতে সমস্ত যুক্তি যোগ করুন

                        // ৫ থেকে ১৭ ডিজিটের বাংলা বা ইংরেজি সংখ্যা চেক করা হচ্ছে
                        const bengaliNumberRegex = /[\u09E6-\u09EF]{5,17}/; // বাংলা সংখ্যা ৫ থেকে ১৭ ডিজিটের জন্য
                        const englishNumberRegex = /\d{5,17}/; // ইংরেজি সংখ্যা ৫ থেকে ১৭ ডিজিটের জন্য
                        if (bengaliNumberRegex.test(customMessage) || englishNumberRegex.test(customMessage)) {
                            await message.reply("❌ মেসেজে ৫ টার বেশি ডিজিটের বাংলা বা ইংরেজি সংখ্যা থাকতে পারবে না!");
                            return;
                        }

                        // নিশ্চিত করুন যে Pre_CustomerNumber এবং CustomerNumber সঠিকভাবে লোড হয়েছে
                        loadConfig();  // সোর্সনাম্বারগুলি আপ-টু-ডেট আছে কিনা তা নিশ্চিত করতে কনফিগারেশন পুনরায় লোড করুন।

                        // Pre_CustomerNumber এবং CustomerNumber সকলকে বার্তা পাঠানো
                        const allRecipients = [...Pre_CustomerNumber, ...CustomerNumber];

                        for (let recipient of allRecipients) {
                            try {
                                const messageToSend = `${customMessage} \n\nSent by SignCopySenderOffice 🙋‍♂️`; // কাস্টম বার্তা এবং রোবট ইমোজি
                                await client.sendMessage(recipient, messageToSend);
                                console.log(`📤 আপনার বার্তা পাঠানো হয়েছে ${recipient}: ${messageToSend} `);

                                const Src_Msg_Delay = randomDelay('Src_Msg_Delay');  // বিলম্বের জন্য 'Src_Msg_Delay' টাইপ ব্যবহার করুন
                                console.log(`Random delay for ${recipient}: Time: ${Src_Msg_Delay} ms`);
                                // বিলম্ব প্রয়োগ setTimeout দিয়ে বিলম্ব প্রয়োগ করা হয়েছে
                                await new Promise(resolve => setTimeout(resolve, Src_Msg_Delay));
                            } catch (error) {
                                console.error(`❌ বার্তা পাঠাতে ব্যর্থ হয়েছে ${recipient} `, error);
                            }
                        }

                        await message.reply("✅ সকল Sub Admin এবং Customer আপনার বার্তা পাঠানো হয়েছে।!");
                    } else {
                        await message.reply("❌ সকল Sub Admin এবং Customer বার্তা পাঠানোর জন্য কিছু লিখুন!");
                    }
                    break;



                // এখানে আরোও কমান্ড যুক্ত করতে পারবেন।


                default:
                    await message.reply("❌ অজানা কমান্ড! \n আপনার UserType: SignCopySenderOffice! \n অনুমদিত কমান্ড দেখতে: /ocmd ব্যবহার করুন");
                    break;
            }
        }

        // এখানে আরও ইউজারের কমান্ড যুক্ত করা যাবে যেমান: (isPdfSenderOffice)


        return; // থামিয়ে দিন মেসেজ প্রক্রিয়াকরণ    

    }
}


// ================== মেইন হ্যান্ডলার: ইনকামিং মেসেজ ==================
async function handleIncomingMessage(message) {
    if (message.from && message.from.endsWith('@g.us')) return;
    if (message.body.startsWith('/')) return;
    try {
        // গরুপ মেসেজ স্কিপ (যদি প্রয়োজন হয় তাহলে পরিবর্তন করবেন)
        const fromNumber = extractNumberFromId(message.from);
        const bodyText = message.body || '';
        //  const messageId = (message.id && (message.id.id || message.id._serialized)) ? (message.id.id || message.id._serialized) : (message._data && message._data.id) || null;
        const messageId = message.id._serialized;  // Message ID 


        // বাংলা সংখ্যা ৫ থেকে ১৭টি চেক করার জন্য রেগুলার এক্সপ্রেশন
        const bengaliNumberRegex = /[\u09E6-\u09EF]{5,17}/; // বাংলা সংখ্যা ০-৯, ৫ থেকে ১৭ সংখ্যা

        if (bodyText && bengaliNumberRegex.test(bodyText)) {
            // ❌ রিঅ্যাক্ট
            await message.react("❌");
            console.log("❌ বাংলা সংখ্যা গ্রহণযোগ্য নয়!");

            // কোটেড রিপ্লাই
            const chat = await message.getChat();
            await chat.sendMessage(
                "❌ বাংলা সংখ্যা গ্রহণযোগ্য নয়!\nসংখ্যা বাদে সব বাংলায় চলবে \n ",
                { quotedMessageId: message.id._serialized }
            );
            return; // এখানে থেমে যাবে
        }

        // হেল্পার: নম্বর সেই লিস্টে আছে কি না
        function inList(listName, num) {
            let arr = [];

            // listName অনুযায়ী সঠিক গ্লোবাল ভ্যারিয়েবল নির্বাচন
            switch (listName) {
                case "AdminNumber":
                    arr = AdminNumber;
                    break;
                case "Pre_CustomerNumber":
                    arr = Pre_CustomerNumber;
                    break;
                case "Order_Rcvd_CustomerNumber":
                    arr = Order_Rcvd_CustomerNumber;
                    break;
                case "CustomerNumber":
                    arr = CustomerNumber;
                    break;
                default:
                    arr = [];
            }

            return arr.some(entry => normalizePhone(entry.number) === normalizePhone(num));
        }

        function getNameFromNumber(number, listName) {
            let arr = [];

            switch (listName) {
                case "AdminNumber":
                    arr = AdminNumber;
                    break;
                case "Pre_CustomerNumber":
                    arr = Pre_CustomerNumber;
                    break;
                case "Order_Rcvd_CustomerNumber":
                    arr = Order_Rcvd_CustomerNumber;
                    break;
                case "CustomerNumber":
                    arr = CustomerNumber;
                    break;
                default:
                    arr = [];
            }

            const entry = arr.find(e => normalizePhone(e.number) === normalizePhone(number));
            return entry ? entry.name : "Unknown";
        }


        // ------------------ Pre_CustomerNumber লজিক ------------------
        if (inList('Pre_CustomerNumber', fromNumber)) {
            // 5-17 ডিজিট একটানা চেক
            const OderNumMatch = bodyText.match(/\d{5,17}/g);
            // যদি OderNumMatch থাকে তদি SignCopy অফিসে ফরওয়ার্ড   
            if (!OderNumMatch) return;
            // 👉 এখানে বকেয়া চেক করার চেক পোস্ট
            const ignoreDueList =
                Order_Rcvd_CustomerNumber?.some(n =>
                    normalizePhone(n.number) === normalizePhone(fromNumber)
                ) ?? false;

            if (!ignoreDueList) {
                const isBlocked = await accountManager.checkOverdueDue(client, message);

                if (isBlocked) {
                    console.log(`User ${fromNumber} blocked due to previous due.`);
                    return;
                }
            }

            /*
            const isBlocked = await accountManager.checkOverdueDue(client, message);
            if (isBlocked) {
                console.log(`User ${ fromNumber } blocked due to previous due.`);
                return; // ❗ ব্লক থাকলে আর নিচে কোড যাবে না
            }
*/
            if (isPaused) {
                // অফিস বন্ধ থাকলে
                await message.reply("❌ অফিস বন্ধ আছে, এডমিন কে কল দিয়ে যোগাযোগ করুন!");
                console.log(`⏸️ Paused: অফিস বন্ধ রিপ্লাই পাঠানো হয়েছে ${message.from} -কে`);
                return; // এখানে থেমে যাবে, আর কিছু প্রসেস হবে না
            }
            if (botPaused) {
                // অফিস বিরতি তে থাকলে
                await message.reply("❌ অফিস বিরতি সময় চলে আছে, জরুরি প্রয়জনে এডমিন কে কল দিয়ে যোগাযোগ করুন!");
                console.log(`⏸️ botPaused: অফিস বিরতি রিপ্লাই পাঠানো হয়েছে ${message.from} -কে`);
                return; // এখানে থেমে যাবে, আর কিছু প্রসেস হবে না
            }
            console.log("Message from Pre_CustomerNumber, processing specific process...");
            addToQueue(async () => {
                // যদি OrderNumbersKey একটি অ্যারে হয়, তবে প্রথম উপাদান নাও
                const orderKey = Array.isArray(OderNumMatch)
                    ? OderNumMatch  // অ্যারে থেকে প্রথম উপাদান নাও
                    : OderNumMatch;    // যদি স্ট্রিং হয়, সরাসরি নাও
                //   const orderKey = match ? match[0] : null;    

                const SignCopySenderOffice = Array.isArray(SignCopy_SenderOfficeNumber)
                    ? SignCopy_SenderOfficeNumber[0]
                    : SignCopy_SenderOfficeNumber;

                const duplicateKeys = getDuplicateKeys(orderKey, SignCopySenderOffice);
                if (duplicateKeys.length > 0) {
                    console.log(`⚠️ Duplicate detected for: ${duplicateKeys.join(', ')} `);
                    await message.react("⚠️");
                    await message.reply(`⚠️ এই অর্ডারটি আগে থেকেই অফিসে পাঠানো হয়েছে। মিলেছে: ${duplicateKeys.join(', ')} `);
                    return;
                }

                // 🔹 টার্গেট লিস্ট তৈরি (একটাই নাম্বার, তাই অ্যারে বানাচ্ছি)
                const targets = SignCopySenderOffice ? [SignCopySenderOffice] : [];

                for (const SignCopy of targets) {
                    try {
                        // ফরওয়ার্ডিং মেসেজের রিয়েকশন দেওয়া
                        if (message && message.react) { // প্রথমে চেক করুন যে `message` অবজেক্টে `react` ফাংশনটি আছে কি না 
                            await message.react(getReactEmoji("MsgForwardReact")); // এখানে '👍' ইমোজি দেওয়া হচ্ছে 
                        }
                        // মেসেজ আইডি এবং চ্যাট আইডি বের করে লগে দেখানো
                        //  const messageId = message.id._serialized;  // Message ID 
                        // লগে মেসেজ আইডি এবং চ্যাট আইডি দেখানো
                        //  console.log(`Message ID: ${ messageId } `);

                        const targetName = getNameFromNumber(fromNumber, 'Pre_CustomerNumber'); // Pre_CustomerNumber থেকে নাম বের করছি                            
                        const sendMessage = await client.sendMessage(toJid(SignCopy), `${bodyText} \n\nuser: ${targetName} `);

                        const newMessageId = sendMessage.id._serialized;
                        const Customermsgid = { [messageId]: message.from };

                        // ✅ messageIndex_Log লগ ফাইলের পাথ
                        const messageIndexPath = getReportPath("messageIndex_log");
                        // ✅ messageIndex_Log ফাইনাল এন্ট্রি বানাও
                        const messageIndex_LogEntry = {
                            [newMessageId]: Customermsgid  // এখানে পুরো অবজেক্টই সেট হবে
                        };
                        // ✅ messageIndex_Log ফাইলে সেভ করো
                        saveToJson(messageIndexPath, messageIndex_LogEntry);

                        const forwardPath = getReportPath('OrderForward_Details_Log');
                        const logEntry = {
                            timestamp: now(),
                            OrderNumbersKey: orderKey.join(', ') || '',
                            OrderTag: 'SignCopy',
                            MainCustomerNumber: fromNumber,
                            messageBody: bodyText,
                            messageId,
                            chatId: message.from,
                            officemsgId: newMessageId,
                            officeNumber: SignCopySenderOffice,
                            officeType: "SignCopy_SenderOfficeNumber",
                            status: "Order Forwarded Successfully",
                            UserType: "Pre_CustomerNumber"
                        };
                        saveToJson(forwardPath, logEntry);
                        // console.log(`[PreCustomer] logged entry for ${ fromNumber } orderKey = ${ orderKey } `);
                        return;
                    } catch (e) {
                        console.warn('Forward to SignCopy failed:', e);
                    }
                }
                return;
            }); // addToQueue end
        }

        // ------------------ CustomerNumber লজিক ------------------
        if (inList('CustomerNumber', fromNumber)) {
            // dynamic keyword detection for categories
            const bodyNorm = (bodyText || '').toLowerCase();
            let matchedOfficeKey = null;
            let matchedTag = null;
            const KEYWORD_MAP = [
                { keys: ['nidpdf', 'nid pdf', 'nid-pdf'], officeKey: 'SignCopy_SenderOfficeNumber', tag: 'NidPdf' },
                { keys: ['sarvercopy', 'sarver copy', 'sarver-copy', 'server-copy', 'server copy', 'server-copy', 'sarvar copy', 'sarvarcopy', 'sarvar-copy'], officeKey: 'SignCopy_SenderOfficeNumber', tag: 'SarverCopy' },  // 'server' এর জন্যও যুক্ত করা হয়েছে
                { keys: ['birthpdf', 'birth pdf', 'birth-pdf'], officeKey: 'Birth_SenderOfficeNumber', tag: 'BirthPdf' },
                { keys: ['bio-metric', 'biometric', 'bio metric'], officeKey: 'Biometric_SenderOfficeNumber', tag: 'Biometric' },
                { keys: ['etinpdf', 'etin pdf', 'etin-pdf'], officeKey: 'e_Tin_SenderOfficeNumber', tag: 'Etinpdf' }
            ];

            for (const m of KEYWORD_MAP) {
                for (const k of m.keys) {
                    if (bodyNorm.includes(k)) {
                        matchedOfficeKey = m.officeKey;
                        matchedTag = m.tag;
                        break;
                    }
                }
                if (matchedOfficeKey) break;
            }
            if (!matchedOfficeKey) return;
            if (isPaused) {
                // অফিস বন্ধ থাকলে
                await message.reply("❌ অফিস বন্ধ আছে, এডমিন কে কল দিয়ে যোগাযোগ করুন!");
                console.log(`⏸️ Paused: অফিস বন্ধ রিপ্লাই পাঠানো হয়েছে ${message.from} -কে`);
                return; // এখানে থেমে যাবে, আর কিছু প্রসেস হবে না
            }
            if (botPaused) {
                // অফিস বিরতি তে থাকলে
                await message.reply("❌ অফিস বিরতি সময় চলে আছে, জরুরি প্রয়জনে এডমিন কে কল দিয়ে যোগাযোগ করুন!");
                console.log(`⏸️ botPaused: অফিস বিরতি রিপ্লাই পাঠানো হয়েছে ${message.from} -কে`);
                return; // এখানে থেমে যাবে, আর কিছু প্রসেস হবে না
            }
            console.log("Message from CustomerNumber, processing specific process...");
            // order numbers detect (any digits 5-17)
            const orderKeys = extractOrderNumbersmsgbody(bodyText);
            // যদি OrderNumbersKey একটি অ্যারে হয়, তবে প্রথম উপাদান নাও
            const orderKey = Array.isArray(orderKeys) ? orderKeys : orderKeys;
            // console.log(orderKey);  // '6918315034'

            // ✅ matchedOfficeKey অনুযায়ী সঠিক গ্লোবাল ভ্যারিয়েবল থেকে নাম্বার নেওয়া
            let OfficeNumber = null;
            switch (matchedOfficeKey) {
                case "SignCopy_SenderOfficeNumber":
                    OfficeNumber = SignCopy_SenderOfficeNumber ? SignCopy_SenderOfficeNumber[0] || SignCopy_SenderOfficeNumber : null;
                    break;
                case "Birth_SenderOfficeNumber":
                    OfficeNumber = Birth_SenderOfficeNumber ? Birth_SenderOfficeNumber[0] || Birth_SenderOfficeNumber : null;
                    break;
                case "Biometric_SenderOfficeNumber":
                    OfficeNumber = Biometric_SenderOfficeNumber ? Biometric_SenderOfficeNumber[0] || Biometric_SenderOfficeNumber : null;
                    break;
                case "e_Tin_SenderOfficeNumber":
                    OfficeNumber = e_Tin_SenderOfficeNumber ? e_Tin_SenderOfficeNumber[0] || e_Tin_SenderOfficeNumber : null;
                    break;
            }

            if (!OfficeNumber) return; // কোনো নাম্বার না থাকলে ফাংশন শেষ
            // 👉 এখানে বকেয়া চেক করার চেক পোস্ট
            const ignoreDueList =
                Order_Rcvd_CustomerNumber?.some(n =>
                    normalizePhone(n.number) === normalizePhone(fromNumber)
                ) ?? false;

            if (!ignoreDueList) {
                const isBlocked = await accountManager.checkOverdueDue(client, message);

                if (isBlocked) {
                    console.log(`User ${fromNumber} blocked due to previous due.`);
                    return;
                }
            }

            const duplicateKeys = getDuplicateKeys(orderKey, OfficeNumber);
            if (duplicateKeys.length > 0) {
                console.log(`⚠️ Duplicate detected for: ${duplicateKeys.join(', ')} `);
                await message.react("⚠️");
                await message.reply(`⚠️ এই অর্ডারটি আগে থেকেই অফিসে পাঠানো হয়েছে। মিলেছে: ${duplicateKeys.join(', ')} `);
                return;
            }
            addToQueue(async () => {
                try {
                    // ফরওয়ার্ডিং মেসেজের রিয়েকশন দেওয়া
                    if (message && message.react) {
                        // প্রথমে চেক করুন যে `message` অবজেক্টে `react` ফাংশনটি আছে কি না 
                        await message.react(getReactEmoji("MsgForwardReact")); // এখানে '👍' ইমোজি দেওয়া হচ্ছে 
                    }

                    // মেসেজ আইডি এবং চ্যাট আইডি বের করে লগে দেখানো
                    const messageId = message.id._serialized;  // Message ID 
                    // লগে মেসেজ আইডি এবং চ্যাট আইডি দেখানো
                    //   console.log(`Message ID: ${ messageId } `);

                    const targetName = getNameFromNumber(fromNumber, 'CustomerNumber'); // CustomerNumber থেকে নাম বের করছি

                    // মেসেজ কন্টেন্ট তৈরি করা
                    const sendMessage = await client.sendMessage(toJid(OfficeNumber), `${bodyText} \n\nuser: ${targetName} : ${matchedTag} `);


                    const newMessageId = sendMessage.id._serialized;
                    const Customermsgid = { [messageId]: message.from }; // messageIndex_Log এ সেভ করুন

                    // ✅ messageIndex_Log লগ ফাইলের পাথ
                    const messageIndexPath = getReportPath("messageIndex_log");
                    // ✅ messageIndex_Log ফাইনাল এন্ট্রি বানাও
                    const messageIndex_LogEntry = {
                        [newMessageId]: Customermsgid  // এখানে পুরো অবজেক্টই সেট হবে
                    };
                    // ✅ messageIndex_Log ফাইলে সেভ করো
                    saveToJson(messageIndexPath, messageIndex_LogEntry);

                    const forwardPath = getReportPath('OrderForward_Details_Log');
                    const logEntry = {
                        timestamp: now(),
                        OrderNumbersKey: orderKey.join(', ') || '',
                        OrderTag: matchedTag,
                        MainCustomerNumber: fromNumber,
                        messageBody: bodyText,
                        messageId,
                        chatId: message.from,
                        officemsgId: newMessageId,
                        officeNumber: OfficeNumber,
                        officeType: matchedOfficeKey || '',
                        status: orderKey ? "Order Forwarded Successfully" : "Order Logged (no orderKey)",
                        UserType: "CustomerNumber"
                    };
                    saveToJson(forwardPath, logEntry);
                    //  console.log(`[Customer] logged entry for ${ fromNumber } orderKey = ${ orderKey } officeType = ${ matchedOfficeKey } `);
                    return;
                } catch (e) {
                    console.warn('Forward to office failed:', e);
                }
                return;
            }); // addToQueue end   
        }
    } catch (err) {
        console.error('handleIncomingMessage error:', err);
    }

}

// ================== অফিস থেকে PDF ডেলিভারি প্রসেসর ==================
async function handleOfficePdfDelivery(message) {
    if (message.body.startsWith('/')) return;
    try {
        const fromNumber = extractNumberFromId(message.from);

        // শুধুমাত্র এই দুই অফিসের জন্য চেক করা হচ্ছে
        const officeTypes = [
            'SignCopy_SenderOfficeNumber',
            'Nid_Make_OfficeNumber',
            'e_Tin_SenderOfficeNumber'
        ];

        let officeKey = null;

        for (const key of officeTypes) {
            let arr = [];

            switch (key) {
                case 'SignCopy_SenderOfficeNumber':
                    if (SignCopy_SenderOfficeNumber) arr = [SignCopy_SenderOfficeNumber[0] || SignCopy_SenderOfficeNumber];
                    break;
                case 'Nid_Make_OfficeNumber':
                    if (Nid_Make_OfficeNumber) arr = Array.isArray(Nid_Make_OfficeNumber) ? Nid_Make_OfficeNumber : [Nid_Make_OfficeNumber];
                    break;
                case 'e_Tin_SenderOfficeNumber':
                    if (e_Tin_SenderOfficeNumber) arr = [e_Tin_SenderOfficeNumber[0] || e_Tin_SenderOfficeNumber];
                    break;
            }
            if (arr.some(entry => normalizePhone(entry) === normalizePhone(fromNumber))) {
                officeKey = key;
                break; // প্রথম ম্যাচ পেলে বের হয়ে যাবে
            }
        }
        if (!officeKey) return; // কোনো ম্যাচ না হলে ফাংশন থেমে যাবে        
        //  console.log(`officeKey: `, officeKey);

        // 🔹 officeKey মেপিং সেট করো
        const officeKeyMap = {
            SignCopy_SenderOfficeNumber: "SignCopy_Office",
            Nid_Make_OfficeNumber: "Nid_Make_Office",
            e_Tin_SenderOfficeNumber: "e_Tin_Office"
        };

        // 🔹 যদি officeKey এর নতুন নাম থাকে, তাহলে সেটা নাও
        const mappedOfficeKey = officeKeyMap[officeKey] || officeKey;

        // ================================
        // 🔹 বিরতি / চালু মেসেজ হ্যান্ডলার
        // ================================
        //   if (!message.hasMedia && message.body) {
        if (!message.hasMedia && message.body && officeKey === SignCopy_SenderOfficeNumber) {
            const lowerText = (message.body || "").toLowerCase();

            const breakKeywords = [
                "বিরতি", "বিরোতি", "বিরতী", "বিরোতী", "বন্ধ", "কাজ বন্ধ",
                "আজ বন্ধ", "অফিস বন্ধ", "pause"
            ];
            const startKeywords = [
                "শুরু", "চালু", "কাজ চালু", "কাজ শুরু", "kaj suru", "resume"
            ];

            const isBreak = breakKeywords.some(k => lowerText.includes(k));
            const isStart = startKeywords.some(k => lowerText.includes(k));

            // ===============================
            // 🔹 Break / Start Message Handler
            // ===============================
            if (isBreak || isStart) {
                botPaused = isBreak;
                // console.log(`${isBreak ? '⏸️' : '▶️'} ${officeKey} sent ${isBreak ? 'break' : 'start'} message: "${message.body}" — Bot ${isBreak ? 'paused' : 'resumed'} `);

                const { Pre_CustomerList, CustomerList } = await getAllUsers();
                // 🔹 দুই লিস্টের কনফিগ
                const sendConfigs = [
                    { list: Pre_CustomerList, prefix: `📢 অফিস নোটিশ: \n(${mappedOfficeKey}) \n` },
                    { list: CustomerList, prefix: `📢 অফিস নোটিশ: \n` }
                ];
                // 🔹 এক লুপেই দুই লিস্ট হ্যান্ডেল
                for (const { list, prefix } of sendConfigs) {
                    for (const userNumber of list) {
                        safeSend(client, userNumber, `${prefix}${message.body} `, "Src_Msg_Delay");
                    }
                }
                await new Promise(r => setTimeout(r, randomDelay("ReactDelay")));
                await message.react(getReactEmoji("OfficeNoticeReact"));
                return;
            }
        }

        if (!message.hasMedia) return;
        console.log(`PDF Receved from(${officeKey}), processing specific process...`);
        // মিডিয়া ডাউনলোড
        const media = await message.downloadMedia();
        if (!media || !media.mimetype) return;

        // শুধুমাত্র PDF প্রক্রিয়া করছি
        if (!media.mimetype.includes('pdf')) return;

        // buffer তৈরি
        const buffer = Buffer.from(media.data, 'base64');
        const fileHash = hashBuffer(buffer);
        const filename = media.filename || `temp_${Date.now()}.pdf`; // ফাইল নাম সেট করা হচ্ছে 
        const tempFile = path.join(tempDir, `tmp_${filename} `);
        // fs.writeFileSync(tempFile, buffer);
        await fs.promises.writeFile(tempFile, buffer);

        // pdf থেকে টেক্সট বের করা (pdf-parse)
        let pdfText = '';
        try {
            const data = await pdfParse(buffer);
            pdfText = data.text || '';
        } catch (e) {
            console.warn('pdf-parse failed:', e);
            // বিকল্প হিসেবে ফাঁকা রেখে দেব
            pdfText = '';
        }

        // matchedOrderKey, matchedOrderType, extractedList, sarvarCopyDetected, nameEnglish বের করো  
        const { matchedOrderKey, matchedOrderType, extractedList, sarvarCopyDetected, nameEnglish } = getMatchedOrderKey(pdfText, { debug: false });
        const nationalIDValue = extractedList?.find(item => item.startsWith("National ID:"))?.split(":")[1].trim();
        //  console.log("National ID =", nationalIDValue);



        const messageId = message.id && (message.id.id || message.id._serialized) || null;
        // mainCustomerNumbers বের করা
        const MainCustomerNumbers = mainCustomerNumberFind(matchedOrderKey);  // mainCustomerNumbers বের করা
        let mainCustomerNumber = MainCustomerNumbers;
        console.log('orderKey to mainCustomerNumber:', mainCustomerNumber);
        const orderTag = orderTagFind(matchedOrderKey); // orderTag বের করা
        // console.log('orderTag from orderKey:', orderTag);    
        // Nid_Make করার জন্য
        if (officeKey === "Nid_Make_OfficeNumber") {
            // console.log("✅ Nid card from Nid_Make_Office");
            const nidmainCustomerNumber = getMainCustomerNumbersFromMessage(pdfText);
            // console.log('nidmainCustomerNumbers from nidpdf:', nidmainCustomerNumber); // ["8801777123456", ...]
            addToQueue(async () => {
                // ফরওয়ার্ড করো native (মিডিয়া হিসেবে)
                const targetJid = toJid(nidmainCustomerNumber);
                const mediaForSend = new MessageMedia(media.mimetype, media.data, media.filename || `${filename} `);
                const caption = nameEnglish ? `${nameEnglish} ` : '';
                //  await client.sendMessage(targetJid, mediaForSend, { caption });
                // messageIndex_Log লজিক শুরু
                // 🔹 ফরওয়ার্ড করা মেসেজ পাঠানো
                const sendMessage = await client.sendMessage(targetJid, mediaForSend, { caption });
                const newMessageId = sendMessage.id._serialized;
                const Customermsgid = { [message.id._serialized]: message.from }; // মূল প্রেরক সংরক্ষণ  
                // ✅ messageIndex_log ফাইলে সেভ করা
                const messageIndexPath = getReportPath("messageIndex_log");
                // 🔹 messageIndex_Log এন্ট্রি আপডেট
                const messageIndex_LogEntry = {
                    [newMessageId]: Customermsgid
                };
                saveToJson(messageIndexPath, messageIndex_LogEntry);
                // messageIndex_log লজিক শেষ

                // ফরওয়ার্ড লোগ সংরক্ষণ
                const deliveryPath = getReportPath('Nid_Make_OrderDelivery_Details_Log');
                const deliveryEntry = {
                    timestamp: now(),
                    OrderNumbersKey: matchedOrderKey.join(', ') || 'orderKey No Found',
                    FileName: media.filename || `unknown_${Date.now()}.pdf`,
                    Nid_Number: nationalIDValue || 'Number No Found',
                    Nid_Make_OfficeNum: fromNumber || 'Number No Found',
                    MainCustomerNumber: nidmainCustomerNumber || 'Number No Found',
                    messageBody: pdfText.substring(0, 200),
                    messageId,
                    status: 'SignCopy Sent Successfully',
                    UserType: 'Nid_Make_Office',
                    fileHash
                };
                saveToJson(deliveryPath, deliveryEntry);
                //     console.log(`Nid Card, [${officeKey}] delivery to ${nidmainCustomerNumber} `);               
                // রিয়েকশন পাঠান
                await message.react(getReactEmoji("PdfForwardReact"));
            });  // addToQueue end
            return;
        }

        // ডুপ্লিকেট চেক (OrderNumbersKey, messageId, fileHash)
        if (isDuplicateForward({ matchedOrderKey, messageId, fileHash })) {
            //  console.log(`[${officeKey}] Duplicate detected for orderKey = ${orderKey} or fileHash = ${fileHash}. Skipping forward.`);
            addToQueue(async () => {
                // রিয়েকশন পাঠান
                await message.react(getReactEmoji("PdfduplicateReact"));
            });

            // লগ করো যে Office থেকে PDF কিন্তু match হয়নি
            const deliveryPath = getReportPath('OrderDelivery_Details_Log');
            const logEntry = {
                timestamp: now(),
                OrderNumbersKey: matchedOrderKey.join(', ') || 'orderKey No Found',
                FileName: media.filename || `unknown_${Date.now()}.pdf`,
                Nid_Number: nationalIDValue || 'Number No Found',
                Nid_Make_OfficeNum: mainCustomerNumber.join(', ') || 'Number No Found',
                MainCustomerNumber: MainCustomerNumbers.join(', ') || 'Number No Found',
                messageBody: pdfText.substring(0, 200),
                messageId: message.id && (message.id.id || message.id._serialized),
                status: 'Duplicate SignCopy',
                UserType: officeKey,
                fileHash
            };
            saveToJson(deliveryPath, logEntry);
            return;
        }

        // ============================
        // 🔹 Auto Charge 
        // ============================
        // 🔹 matchedOrderKey সবসময় array, তাই string হিসেবে নাও
        const matchedKey = Array.isArray(matchedOrderKey) ? matchedOrderKey[0] : matchedOrderKey;
        const userAccountsDir = path.join(__dirname, "UserAccounts");
        const uniqueNumbers = [...new Set(mainCustomerNumber)];
        const today = moment().tz("Asia/Dhaka").format("DD/MM/YYYY");
        for (const number of uniqueNumbers) {
            try {
                const userFile = path.join(userAccountsDir, `${number}.json`);
                let accountData = {};
                let history = [];

                // 🔹 Non-blocking read
                try {
                    await fs.promises.access(userFile);
                    const fileData = await fs.promises.readFile(userFile, "utf8");
                    accountData = JSON.parse(fileData);
                    history = Array.isArray(accountData.history) ? accountData.history : [];
                } catch {
                    accountData = {};
                    history = [];
                }

                // 🔹 আগে ওই matchedOrderKey-এ চার্জ হয়েছে কিনা চেক করো 
                const alreadyCharged = history.some(entry => {
                    if (entry.type !== "charge") return false;
                    if (!entry.OrderKey || entry.OrderKey !== matchedKey) return false;

                    const entryDate = entry.timestamp.split(" ")[0]; // timestamp থেকে date কাটছে
                    return entryDate === today;
                });



                if (alreadyCharged) {
                    console.log(`⚠️ ${number} already charged for matchedOrderKey ${matchedKey}, skipping.`);
                    continue;
                }

                // 🔹 এখন চার্জ করো
                const acc = accountManager.getSummary(number);

                // ⚙️ Office_Number = fromNumber | Office_Type = mappedOfficeKey
                accountManager.charge(
                    number,
                    acc.role,
                    orderTag,
                    `Auto Charge`,
                    matchedKey,
                    fromNumber,
                    mappedOfficeKey,
                    matchedOrderType  // ⭐ খুব গুরুত্বপূর্ণ
                );

                console.log(`✅ Auto charged ${number} for matchedOrderKey ${matchedKey}(${mappedOfficeKey} / ${fromNumber})`);
            } catch (err) {
                console.error(`❌ Charge failed for ${number}: `, err);
            }
        }

        if (!matchedOrderKey) {
            console.log(`[${officeKey}] PDF received from ${fromNumber} — but no matching OrderDelivery log found for orderKey = ${matchedOrderKey}`);
            addToQueue(async () => {
                // রিয়েকশন পাঠান
                await message.react(getReactEmoji("Not_Match_React"));
            });

            // লগ করো যে Office থেকে PDF কিন্তু match হয়নি
            const deliveryPath = getReportPath('OrderDelivery_Details_Log');
            const logEntry = {
                timestamp: now(),
                OrderNumbersKey: matchedOrderKey.join(', ') || 'orderKey No Found',
                FileName: media.filename || `unknown_${Date.now()}.pdf`,
                Nid_Number: nationalIDValue || 'Number No Found',
                Nid_Make_OfficeNum: mainCustomerNumber.join(', ') || 'Number No Found',
                MainCustomerNumber: MainCustomerNumbers.join(', ') || 'Number No Found',
                messageBody: pdfText.substring(0, 200),
                messageId: message.id && (message.id.id || message.id._serialized),
                status: 'Unknown SignCopy',
                UserType: officeKey,
                fileHash
            };
            saveToJson(deliveryPath, logEntry);
            return;
        } else {
            try {
                const officeMsgId = officeMsgIdFind(matchedOrderKey);  // officeMsgId বের করা
                const senderNumber = message.from;
                const targetJid = toJid(senderNumber);
                // 🔹 মূল চ্যাটে যান
                const chat = await client.getChatById(targetJid);
                // 🔹 চ্যাট থেকে সর্বশেষ 50টি মেসেজ ফেচ করুন
                const messages = await chat.fetchMessages({ limit: 30 });
                // 🔹 officeMsgId অনুযায়ী মূল message খুঁজুন
                const matchedMessage = messages.find(msg => msg.id._serialized === officeMsgId);
                addToQueue(async () => {
                    if (matchedMessage) {
                        // 🔹 রিয়েকশন যুক্ত করা
                        await matchedMessage.react(getReactEmoji("FilematchingReact")); // এখানে ✅ ইমোজি ব্যবহার করা হয়েছে
                    }
                });
            } catch (err) {
                console.error("Office message fetch/react error:", err);
                await message.reply(`❌ Office message - এ রিয়েকশন দিতে সমস্যা: ${err.message} `);
            }
        }

        if (orderTag === "NidPdf") {
            // 🔹 mainCustomerNumber সরাসরি Nid_Make_OfficeNumber দিয়ে বদল           
            if (!Nid_Make_OfficeNumber) {
                //   console.warn("⚠️ Nid_Make_OfficeNumber সেট করা হয়নি!");
                return; // প্রয়োজনীয় নম্বর না থাকলে ফাংশন স্টপ
            }
            mainCustomerNumber = [normalizePhone(Nid_Make_OfficeNumber)];
            //  console.log(`🟢 mainCustomerNumber overridden with Nid_Make_OfficeNumber: ${mainCustomerNumber} `);

        }
        // 📌 sarvarcopy হলে, detect true না থাকলে ফাংশন স্টপ
        if (orderTag === "SarverCopy" && sarvarCopyDetected !== true) {
            return;
        }

        addToQueue(async () => {
            // ফরওয়ার্ড করো native (মিডিয়া হিসেবে)
            const targetJid = toJid(mainCustomerNumber);
            const mediaForSend = new MessageMedia(media.mimetype, media.data, media.filename || `${filename} `);
            const caption = nameEnglish ? `${nameEnglish} ` : '';
            // messageIndex_Log লজিক শুরু
            // 🔹 ফরওয়ার্ড করা মেসেজ পাঠানো
            const sendMessage = await client.sendMessage(targetJid, mediaForSend, { caption });

            const newMessageId = sendMessage.id._serialized;
            const Customermsgid = { [message.id._serialized]: message.from }; // মূল প্রেরক সংরক্ষণ             

            // ✅ messageIndex_log ফাইলে সেভ করা
            const messageIndexPath = getReportPath("messageIndex_log");
            // 🔹 messageIndex_Log এন্ট্রি আপডেট
            const messageIndex_LogEntry = {
                [newMessageId]: Customermsgid
            };
            saveToJson(messageIndexPath, messageIndex_LogEntry);

            // messageIndex_log লজিক শেষ

            // ফরওয়ার্ড লোগ সংরক্ষণ
            const deliveryPath = getReportPath('OrderDelivery_Details_Log');
            const forwardEntry = {
                timestamp: now(),
                OrderNumbersKey: matchedOrderKey.join(', ') || 'orderKey No Found',
                FileName: media.filename || `unknown_${Date.now()}.pdf`,
                Nid_Number: nationalIDValue || 'Number No Found',
                Nid_Make_OfficeNum: mainCustomerNumber.join(', ') || 'Number No Found',
                MainCustomerNumber: MainCustomerNumbers.join(', ') || 'Number No Found',
                messageBody: pdfText.substring(0, 200),
                messageId,
                status: 'SignCopy Sent Successfully',
                UserType: officeKey,
                fileHash
            };
            saveToJson(deliveryPath, forwardEntry);

            console.log(`[${officeKey}] PDF forwarded to ${mainCustomerNumber} `);

            // রিয়েকশন পাঠান            
            await message.react(getReactEmoji("PdfForwardReact"));
            return;
        });  // addToQueue end
        // temp file cleanup
        //  try { fs.removeSync(tempFile); } catch (e) { }
        return;


    } catch (err) {
        console.error('handleOfficePdfDelivery error:', err);
    }
}

// ================== Reply Handler প্রসেসর ==================
// ==========================
// 🔹 Unified Reply Forwarding Logic
// ==========================
async function handleReply(message) {
    // 🔸 গ্রুপ মেসেজ স্কিপ
    if (message.from?.endsWith('@g.us')) return;
    if (message.body.startsWith('/')) return;
    // 🔸 কোয়োটেড মেসেজ না থাকলে স্কিপ
    if (!message.hasQuotedMsg) return;
    const fromNumber = extractNumberFromId(message.from);
    console.log("Reply from:", fromNumber);

    // Check Customer / PreCustomer
    // const isCustomer = CustomerNumber.includes(fromNumber);
    // const isPreCustomer = Pre_CustomerNumber.includes(fromNumber);
    const isCustomer = CustomerNumber.some(item => item.number === fromNumber);
    const isPreCustomer = Pre_CustomerNumber.some(item => item.number === fromNumber);

    // Check Office
    const isSignCopyOffice = SignCopy_SenderOfficeNumber.includes(fromNumber);

    if (!(isCustomer || isPreCustomer || isSignCopyOffice)) {
        console.log("Reply from unknown sender, ignoring:", fromNumber);
        return;
    }

    const quoted = await message.getQuotedMessage();

    const quotedIdKey = quoted.id._serialized;

    // 🔹 messageIndex_log.json path
    const messageIndexPath = getReportPath("messageIndex_log");

    // 🔹 ফাইল থেকে messageIndexLog লোড
    let messageIndexLog = [];
    if (fs.existsSync(messageIndexPath)) {
        try {
            messageIndexLog = JSON.parse(fs.readFileSync(messageIndexPath, "utf8"));
        } catch (err) {
            console.error("❌ messageIndex_log.json পড়তে সমস্যা:", err);
        }
    }
    // 🧩 এখন ফাইলের ডাটা অ্যারে হলে লুপ চালিয়ে খুঁজবো
    let customermsgidFromIndex = null;

    for (const entry of messageIndexLog) {
        if (entry[quotedIdKey]) {
            customermsgidFromIndex = entry[quotedIdKey];
            break;
        }
    }

    if (!customermsgidFromIndex) {
        // console.log("❌ messageIndex_log.json এ কোনো মিল পাওয়া যায়নি");
        return;
    }

    // 🧠 মূল messageId ও প্রেরক বের করা
    const customermsgid = Object.keys(customermsgidFromIndex)[0];
    const MainCustomerNumber = customermsgidFromIndex[customermsgid];
    // 🔹 মূল চ্যাটে যান
    const chat = await client.getChatById(MainCustomerNumber);
    const messages = await chat.fetchMessages({ limit: 50 });
    // 🔹 মূল message খুঁজুন   
    const matchedMessage = messages.find(message => message.id._serialized === customermsgid);

    if (!matchedMessage) {
        console.log("⚠️ কোনো মেসেজ match পাওয়া যায়নি।");
        return;
    }

    const messageId = message.id._serialized;  // Message ID     
    const sendMessage = await matchedMessage.reply(message.body);
    // ✅ ঠিকভাবে quoted হবে

    const newMessageId = sendMessage.id._serialized;
    const Customermsgid = { [messageId]: message.from };

    // 🔹 messageIndex_Log এন্ট্রি আপডেট
    const messageIndex_LogEntry = {
        [newMessageId]: Customermsgid
    };

    saveToJson(messageIndexPath, messageIndex_LogEntry);

    console.log(`📩 Reply forwarded(quoted) to ${matchedMessage.from} `);
    return;
}


// ================== Reaction Handler প্রসেসর ==================
async function handleReaction(reaction) {
    //  console.log('Reaction detected:', reaction);   
    // শুধু নির্দিষ্ট ইমোজি চেক করা
    if (reaction.reaction !== '😢') return; // অন্য কিছু হলে থেমে যাবে
    addToQueue(async () => {
        try {
            console.log('Sad reaction detected 😢');
            // senderId থেকে extractNumberFromId ফাংশন দিয়ে রিয়েকশনকারী ইউজারের নাম্বার (যেমন: 8801777283248)
            const fromNumber = extractNumberFromId(reaction.senderId);
            // শর্ত: যদি রিয়েকশনকারী নাম্বার এবং টার্গেট নাম্বার মেলে    
            if (fromNumber === SignCopy_SenderOfficeNumber[0]) {
                // msgId চেক করা
                if (!reaction.msgId) {
                    console.log("No msgId found in reaction.");
                    return; // msgId না থাকলে কোনো কাজ হবে না
                }
                console.log('Sad reaction detected 😢');
                // মূল মেসেজটি খুঁজে বের করা
                const originalMessage = await client.getMessageById(reaction.msgId._serialized);
                //  console.log("Original message: ", originalMessage);
                // মেসেজের কন্টেন্ট (বডি) বের করা
                const newMessageId = originalMessage.id._serialized;

                // 🔹 messageIndex_log.json path
                const messageIndexPath = getReportPath("messageIndex_log");

                // 🔹 ফাইল থেকে messageIndexLog লোড
                let messageIndexLog = [];
                if (fs.existsSync(messageIndexPath)) {
                    try {
                        messageIndexLog = JSON.parse(fs.readFileSync(messageIndexPath, "utf8"));
                    } catch (err) {
                        console.error("❌ messageIndex_log.json পড়তে সমস্যা:", err);
                    }
                }

                // 🧩 এখন ফাইলের ডাটা অ্যারে হলে লুপ চালিয়ে খুঁজবো
                let customermsgidFromIndex = null;
                for (const entry of messageIndexLog) {
                    if (entry[newMessageId]) {
                        customermsgidFromIndex = entry[newMessageId];
                        break;
                    }
                }

                if (!customermsgidFromIndex) {
                    console.log("❌ messageIndex_log.json এ কোনো মিল পাওয়া যায়নি");
                    return;
                }

                // 🧠 মূল messageId ও প্রেরক বের করা
                const customermsgid = Object.keys(customermsgidFromIndex)[0];
                const MainCustomerNumber = customermsgidFromIndex[customermsgid];
                // 🔹 মূল চ্যাটে যান
                const chat = await client.getChatById(MainCustomerNumber);
                const messages = await chat.fetchMessages({ limit: 50 });
                // 🔹 মূল message খুঁজুন   
                const matchedMessage = messages.find(message => message.id._serialized === customermsgid);

                if (!matchedMessage) {
                    console.log("⚠️ কোনো মেসেজ match পাওয়া যায়নি।");
                    return;
                }
                if (matchedMessage) {
                    // প্রথমে randomDelay ব্যবহার করে ডিলের সময় বের করুন
                    const ReactDelay = randomDelay("ReactDelay");
                    console.log(`Waiting for ${ReactDelay}ms before react...`);
                    // React বিলম্ব প্রয়োগ setTimeout দিয়ে বিলম্ব প্রয়োগ করা হচ্ছে
                    await new Promise(resolve => setTimeout(resolve, ReactDelay));  // এই লাইনে বিলম্ব প্রয়োগ করা হচ্ছে 
                    await matchedMessage.react('😢');  // এখানে রিয়েকশন যোগ করা হচ্ছে (এখানে 😢 রিয়েকশন দেয়া হয়েছে)
                    //   console.log('Reaction added to the matched message:', matchedMessage.body);
                    // রিয়েকশন দেওয়ার পর, reply পাঠানোর জন্য বিলম্ব প্রয়োগ করুন
                    const ReplyDelay = randomDelay("ReplyDelay");  // `ReplyDelay` এর জন্য বিলম্ব সময়
                    // reply বিলম্ব প্রয়োগ setTimeout দিয়ে বিলম্ব প্রয়োগ করা হচ্ছে
                    await new Promise(resolve => setTimeout(resolve, ReplyDelay));  // reply পাঠানোর আগে বিলম্ব প্রয়োগ

                    // এখানে quoted reply পাঠানো হচ্ছে
                    await matchedMessage.reply("ভোটার তথ্য খুঁজে পাওয়া যায়নি");
                    return; // থামিয়ে দিন মেসেজ প্রক্রিয়াকরণ
                }

            } else {
                //  console.log('fromNumber and SignCopy Sender Office not match!');
            }
        } catch (err) {
            console.error('Reaction process error:', err);
        }
    });  // addToQueue end   
}

// ================== message ইভেন্টে প্রথমে message হ্যান্ডলিং, পরে office pdf হ্যান্ডলিং ==================
client.on('message', async (message) => {

    // কমান্ড সিস্টেমের জন্য মেসেজ হ্যান্ডলিং
    await handleCommands(message);

    // প্রথমে সাধারণ মেসেজ প্রসেস
    await handleIncomingMessage(message);

    // তারপর অফিস-দিয়ে আসা PDF প্রসেস
    await handleOfficePdfDelivery(message);

    // Reply Handler প্রসেস
    await handleReply(message);
});

// ================== reaction ইভেন্টে হ্যান্ডলিং ==================
client.on('message_reaction', async (reaction) => {
    // Reaction Handler প্রসেস
    await handleReaction(reaction);
});

// start client
client.initialize();


























