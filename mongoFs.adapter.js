/**
 * mongoFs.adapter.js
 * Purpose:
 *  - fs-extra এর drop-in replacement
 *  - Config + Reports MongoDB তে Virtual File হিসেবে সেভ
 *  - Existing code 100% unchanged রেখে কাজ করবে
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const deasync = require("deasync");

// ===============================
// Mongo Connection (safe auto-connect)
// ===============================
if (mongoose.connection.readyState === 0) {
    mongoose.connect(process.env.MONGODB_URI, {
        dbName: "whatsapp_bot",
    });
}

// ===============================
// Schema
// ===============================
const FileSchema = new mongoose.Schema({
    path: { type: String, unique: true },
    content: String,
    updatedAt: { type: Date, default: Date.now }
});

const VirtualFile =
    mongoose.models.VirtualFile || mongoose.model("VirtualFile", FileSchema);

// ===============================
// Helper: কোন path Mongo তে যাবে
// ===============================
function isMongoPath(filePath) {
    const normalized = path.normalize(filePath);

    return (
        normalized.endsWith(`${path.sep}Config${path.sep}mainConfig.json`) ||
        normalized.includes(`${path.sep}Reports${path.sep}`)
    );
}

// ===============================
// Adapter API (fs-compatible)
// ===============================
module.exports = {
    // -------- readFileSync --------
    readFileSync(filePath, encoding = "utf8") {
        if (!isMongoPath(filePath)) {
            return fs.readFileSync(filePath, encoding);
        }

        let done = false;
        let result = null;

        VirtualFile.findOne({ path: filePath })
            .lean()
            .exec((err, doc) => {
                result = doc;
                done = true;
            });

        deasync.loopWhile(() => !done);

        // config.json হলে object, report হলে array → দুটোই string আকারে ফেরত দিচ্ছি
        return result && result.content ? result.content : "[]";
    },

    // -------- writeFileSync --------
    writeFileSync(filePath, content) {
        if (!isMongoPath(filePath)) {
            return fs.writeFileSync(filePath, content);
        }

        VirtualFile.updateOne(
            { path: filePath },
            { content, updatedAt: new Date() },
            { upsert: true }
        ).exec();
    },

    // -------- ensureDirSync --------
    ensureDirSync() {
        // MongoDB এ directory লাগে না → noop
        return;
    }
};
