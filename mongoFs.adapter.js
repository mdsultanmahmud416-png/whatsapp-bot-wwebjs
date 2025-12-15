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
// In-memory cache
// ===============================
const memoryStore = new Map();
let initialized = false;

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
// Init (call once at startup)
// ===============================
async function initMongoFs() {
    if (initialized) return;

    const docs = await VirtualFile.find({}).lean();
    for (const d of docs) {
        memoryStore.set(d.path, d.content);
    }

    initialized = true;
    console.log("🟢 mongoFs initialized (memory cache ready)");
}

// ===============================
// Adapter API (fs-compatible)
// ===============================
module.exports = {
    initMongoFs,

    // -------- readFileSync --------
    readFileSync(filePath, encoding = "utf8") {
        if (!isMongoPath(filePath)) {
            return fs.readFileSync(filePath, encoding);
        }

        return memoryStore.get(filePath) ?? "[]";
    },

    // -------- writeFileSync --------
    writeFileSync(filePath, content) {
        if (!isMongoPath(filePath)) {
            return fs.writeFileSync(filePath, content);
        }

        // memory update
        memoryStore.set(filePath, content);

        // async mongo save (non-blocking)
        VirtualFile.updateOne(
            { path: filePath },
            { content, updatedAt: new Date() },
            { upsert: true }
        ).catch(err => {
            console.error("❌ Mongo write failed:", err.message);
        });
    },

    // -------- ensureDirSync --------
    ensureDirSync() {
        // noop — MongoDB এ directory লাগে না
    }
};
