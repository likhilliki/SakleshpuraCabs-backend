const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  mobile: { type: String, unique: true, required: true, trim: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  password: { type: String }, // bcrypt hash
  otp: { type: String },
  otpExpiry: { type: Date },
  isVerified: { type: Boolean, default: false },
  profilePhoto: { type: String },
  fcmToken: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (plain) {
  if (!this.password) return false;
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { id: this._id.toString(), role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '30d' }
  );
};

module.exports = mongoose.model('User', userSchema);
