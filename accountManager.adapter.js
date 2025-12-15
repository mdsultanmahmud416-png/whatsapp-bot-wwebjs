/**
 * accountManager.adapter.js
 * Purpose: Keep existing file-based accountManager 100% working
 * while allowing future MongoDB switch
 */

const {
    accountManager: fileAccountManager,
    reminderConfig,
    reminderConfigPath,
    chargeConfig,
    chargeConfigPath
} = require("./accountManager");

// ===============================
// Adapter Class
// ===============================
class AccountManagerAdapter {
    constructor() {
        this.impl = fileAccountManager;
    }

    // ---------- Core ----------
    setChargeRate(...args) { return this.impl.setChargeRate(...args); }
    addChargeRate(...args) { return this.impl.addChargeRate(...args); }
    setRole(...args) { return this.impl.setRole(...args); }

    // ---------- Balance ----------
    deposit(...args) { return this.impl.deposit(...args); }
    mcharge(...args) { return this.impl.mcharge(...args); }
    charge(...args) { return this.impl.charge(...args); }
    refund(...args) { return this.impl.refund(...args); }

    // ---------- Reports ----------
    sendDailyReport(...args) { return this.impl.sendDailyReport(...args); }
    sendOfficeReport(...args) { return this.impl.sendOfficeReport(...args); }

    // ---------- Queries ----------
    getSummary(...args) { return this.impl.getSummary(...args); }
    getHistory(...args) { return this.impl.getHistory(...args); }
    getDueList(...args) { return this.impl.getDueList(...args); }

    // ---------- Reminder ----------
    sendDueReminder(...args) { return this.impl.sendDueReminder(...args); }
    checkOverdueDue(...args) { return this.impl.checkOverdueDue(...args); }

    // ---------- Backup ----------
    backup(...args) { return this.impl.backup(...args); }
}

// ===============================
// Export (same shape as before)
// ===============================
module.exports = {
    accountManager: new AccountManagerAdapter(),
    reminderConfig,
    reminderConfigPath,
    chargeConfig,
    chargeConfigPath
};
