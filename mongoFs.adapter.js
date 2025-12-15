const path = require("path");
const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema({
    path: { type: String, unique: true },
    content: String,
    updatedAt: { type: Date, default: Date.now }
});

const VirtualFile =
    mongoose.models.VirtualFile || mongoose.model("VirtualFile", FileSchema);

// helper
function isMongoPath(filePath) {
    const normalized = path.normalize(filePath);

    return (
        normalized.endsWith(`${path.sep}Config${path.sep}mainConfig.json`) ||
        normalized.includes(`${path.sep}Reports${path.sep}`)
    );
}

module.exports = {
    readFileSync(filePath) {
        if (!isMongoPath(filePath)) {
            return require("fs").readFileSync(filePath, "utf8");
        }

        const doc = VirtualFile.findOne({ path: filePath }).lean().execSync();
        return doc ? doc.content : "[]";
    },

    writeFileSync(filePath, content) {
        if (!isMongoPath(filePath)) {
            return require("fs").writeFileSync(filePath, content);
        }

        return VirtualFile.updateOne(
            { path: filePath },
            { content, updatedAt: new Date() },
            { upsert: true }
        ).exec();
    },

    ensureDirSync() {
        // MongoDB এ directory লাগে না → noop
        return;
    }
};
