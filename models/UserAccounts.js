// UserAccountsSchema বা models UserAccounts => UserAccounts folder 
const mongoose = require("mongoose");

const UserAccountsSchema = new mongoose.Schema({
  number: { type: String, unique: true },
  role: String,
  balance: Number,
  due: Number,
  createdAt: String,
  updatedAt: String,
  history: [Object]
});

module.exports =
  mongoose.models.Account ||
  mongoose.model("UserAccounts", UserAccountsSchema);
