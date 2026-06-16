const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const WalletTransactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true },
  reason: { type: String },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  razorpayPaymentId: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const DriverSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  password: { type: String }, // bcrypt hash
  otp: { type: String },
  otpExpiry: { type: Date },
  isVerified: { type: Boolean, default: false },

  // KYC fields
  aadhaarNumber: { type: String, trim: true },
  aadhaarPhoto: { type: String },
  drivingLicenseNumber: { type: String, trim: true },
  drivingLicensePhoto: { type: String },
  rcBookNumber: { type: String, trim: true },
  rcBookPhoto: { type: String },
  profilePhoto: { type: String },

  // KYC status
  kycSubmitted: { type: Boolean, default: false },
  kycSubmittedAt: { type: Date },
  isApproved: { type: Boolean, default: false },
  isRejected: { type: Boolean, default: false },
  rejectionReason: { type: String },
  approvedAt: { type: Date },
  isBlocked: { type: Boolean, default: false },

  // Vehicle info
  vehicleNumber: { type: String, trim: true },
  vehicleModel: { type: String, trim: true },
  vehicleColor: { type: String, trim: true },
  vehicleYear: { type: String },
  vehicleType: {
    type: String,
    enum: ['auto', 'bike', 'car', 'suv', 'xuv'],
    default: 'car',
  },

  // Live status
  isOnline: { type: Boolean, default: false },
  currentLocation: {
    lat: { type: Number },
    lng: { type: Number },
    bearing: { type: Number, default: 0 },
    updatedAt: { type: Date },
  },

  // Stats
  rating: { type: Number, default: 5 },
  totalRides: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },

  // Bank details for payouts
  bankAccount: {
    accountNumber: { type: String },
    ifsc: { type: String },
    accountName: { type: String },
    isVerified: { type: Boolean, default: false },
  },

  // Wallet
  walletBalance: { type: Number, default: 0 },
  walletTransactions: [WalletTransactionSchema],
  hasMinimumWallet: { type: Boolean, default: false },

  // Push notifications
  fcmToken: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
});

DriverSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

DriverSchema.methods.comparePassword = async function (plain) {
  if (!this.password) return false;
  return bcrypt.compare(plain, this.password);
};

DriverSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { id: this._id.toString(), role: 'driver' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
};

module.exports = mongoose.model('Driver', DriverSchema);
