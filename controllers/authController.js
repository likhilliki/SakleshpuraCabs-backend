const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Driver = require('../models/Driver');
const generateOTP = require('../utils/generateOTP');
const generateToken = require('../utils/generateToken');
const sendOTP = require('../utils/sendOTP');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Register — collect name + mobile + password, send OTP to verify mobile
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, mobile, password, email, userType = 'user' } = req.body;

    if (!name?.trim() || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Full name is required (minimum 2 characters)' });

    if (!mobile || !/^[0-9]{10}$/.test(mobile))
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });

    if (!password || password.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    if (!['user', 'driver'].includes(userType))
      return res.status(400).json({ success: false, message: 'Invalid userType' });

    const Model = userType === 'user' ? User : Driver;

    // Check if mobile already registered and verified
    const existing = await Model.findOne({ mobile });
    if (existing && existing.isVerified) {
      return res.status(409).json({ success: false, message: 'This mobile number is already registered. Please login instead.' });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    if (existing && !existing.isVerified) {
      // Re-registration attempt — update details and resend OTP
      existing.name = name.trim();
      existing.password = password; // pre-save hook will hash it
      existing.otp = otp;
      existing.otpExpiry = otpExpiry;
      if (email) existing.email = email.toLowerCase().trim();
      await existing.save();
    } else {
      // New registration
      const newRecord = { name: name.trim(), mobile, password, otp, otpExpiry };
      if (email) newRecord.email = email.toLowerCase().trim();
      await Model.create(newRecord);
    }

    const result = await sendOTP(mobile, otp);
    if (!result.success) {
      return res.status(500).json({ success: false, message: 'Could not send OTP. Please try again.' });
    }

    const response = { success: true, message: `OTP sent to +91 ${mobile}` };
    if (process.env.DEBUG_OTP === 'true') response.otp = otp;
    return res.status(200).json(response);
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      return res.status(409).json({ success: false, message: `${field === 'email' ? 'Email' : 'Mobile'} already registered. Please login.` });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Verify OTP — confirms mobile ownership, activates account
// POST /api/auth/verify-otp
// ─────────────────────────────────────────────────────────────────────────────
const verifyOtp = async (req, res) => {
  try {
    const { mobile, otp, userType = 'user' } = req.body;

    if (!mobile || !otp)
      return res.status(400).json({ success: false, message: 'Mobile and OTP are required' });

    if (!/^[0-9]{10}$/.test(mobile) || !/^[0-9]{6}$/.test(otp))
      return res.status(400).json({ success: false, message: 'Invalid mobile or OTP format' });

    const Model = userType === 'user' ? User : Driver;
    const record = await Model.findOne({ mobile });

    if (!record)
      return res.status(404).json({ success: false, message: 'Mobile not found. Please register first.' });

    if (record.otp !== otp)
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });

    if (!record.otpExpiry || record.otpExpiry < new Date())
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });

    record.isVerified = true;
    record.otp = null;
    record.otpExpiry = null;
    await record.save();

    const token = generateToken(record._id, userType);

    if (userType === 'user') {
      return res.status(200).json({
        success: true,
        message: 'Mobile verified. Welcome to Vibzz!',
        token,
        user: { _id: record._id, name: record.name, mobile: record.mobile, email: record.email, isVerified: true },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Mobile verified. Welcome, Captain!',
      token,
      driver: { _id: record._id, name: record.name, mobile: record.mobile, isVerified: true, isApproved: record.isApproved, kycSubmitted: record.kycSubmitted },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN — mobile or email + password (no OTP needed after first verification)
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { identifier, password, userType = 'user' } = req.body;

    if (!identifier?.trim() || !password)
      return res.status(400).json({ success: false, message: 'Mobile/email and password are required' });

    if (!['user', 'driver'].includes(userType))
      return res.status(400).json({ success: false, message: 'Invalid userType' });

    const Model = userType === 'user' ? User : Driver;

    // Find by mobile or email
    const isMobile = /^[0-9]{10}$/.test(identifier.trim());
    const query = isMobile
      ? { mobile: identifier.trim() }
      : { email: identifier.toLowerCase().trim() };

    const record = await Model.findOne(query);

    if (!record)
      return res.status(401).json({ success: false, message: 'Account not found. Please sign up first.' });

    if (!record.isVerified)
      return res.status(401).json({ success: false, message: 'Mobile not verified. Please complete OTP verification.' });

    if (!record.password)
      return res.status(401).json({ success: false, message: 'No password set. Please sign up again.' });

    const passwordMatch = await record.comparePassword(password);
    if (!passwordMatch)
      return res.status(401).json({ success: false, message: 'Incorrect password. Please try again.' });

    // Check if driver is blocked
    if (userType === 'driver' && record.isBlocked)
      return res.status(403).json({ success: false, message: 'Your account has been suspended. Contact support.' });

    const token = generateToken(record._id, userType);

    if (userType === 'user') {
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        user: { _id: record._id, name: record.name, mobile: record.mobile, email: record.email, isVerified: true },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      driver: { _id: record._id, name: record.name, mobile: record.mobile, isVerified: true, isApproved: record.isApproved, kycSubmitted: record.kycSubmitted, isOnline: record.isOnline },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESEND OTP — for unverified accounts
// POST /api/auth/resend-otp
// ─────────────────────────────────────────────────────────────────────────────
const resendOtp = async (req, res) => {
  try {
    const { mobile, userType = 'user' } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile))
      return res.status(400).json({ success: false, message: 'Valid mobile number required' });

    const Model = userType === 'user' ? User : Driver;
    const record = await Model.findOne({ mobile });
    if (!record)
      return res.status(404).json({ success: false, message: 'Mobile not found. Please register first.' });

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    record.otp = otp;
    record.otpExpiry = otpExpiry;
    await record.save();

    const result = await sendOTP(mobile, otp);
    if (!result.success)
      return res.status(500).json({ success: false, message: 'Failed to send OTP. Try again.' });

    const response = { success: true, message: `OTP resent to +91 ${mobile}` };
    if (process.env.DEBUG_OTP === 'true') response.otp = otp;
    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FORGOT PASSWORD — send OTP to reset password
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  try {
    const { mobile, userType = 'user' } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile))
      return res.status(400).json({ success: false, message: 'Valid mobile number required' });

    const Model = userType === 'user' ? User : Driver;
    const record = await Model.findOne({ mobile });
    if (!record)
      return res.status(404).json({ success: false, message: 'Account not found with this mobile number.' });

    const otp = generateOTP();
    record.otp = otp;
    record.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await record.save();

    const result = await sendOTP(mobile, otp);
    if (!result.success)
      return res.status(500).json({ success: false, message: 'Could not send OTP.' });

    const response = { success: true, message: `Password reset OTP sent to +91 ${mobile}` };
    if (process.env.DEBUG_OTP === 'true') response.otp = otp;
    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESET PASSWORD — verify OTP then set new password
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { mobile, otp, newPassword, userType = 'user' } = req.body;
    if (!mobile || !otp || !newPassword)
      return res.status(400).json({ success: false, message: 'Mobile, OTP, and new password required' });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const Model = userType === 'user' ? User : Driver;
    const record = await Model.findOne({ mobile });
    if (!record) return res.status(404).json({ success: false, message: 'Account not found' });
    if (record.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (!record.otpExpiry || record.otpExpiry < new Date())
      return res.status(400).json({ success: false, message: 'OTP expired' });

    record.password = newPassword; // pre-save hook hashes it
    record.otp = null;
    record.otpExpiry = null;
    await record.save();

    return res.status(200).json({ success: true, message: 'Password reset successfully. Please login.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET PROFILE, UPDATE PROFILE, SAVE FCM TOKEN
// ─────────────────────────────────────────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const { user, role } = req;
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    if (role === 'user') {
      const u = await User.findById(user._id).select('-otp -otpExpiry -password');
      return res.status(200).json({ success: true, user: u });
    }
    const d = await Driver.findById(user._id).select('-otp -otpExpiry -password -walletTransactions');
    return res.status(200).json({ success: true, driver: d });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
    const user = await User.findByIdAndUpdate(req.user._id, { name: name.trim() }, { new: true }).select('-otp -otpExpiry -password');
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const saveFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM token required' });
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    return res.json({ success: true, message: 'FCM token saved' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { register, verifyOtp, login, resendOtp, forgotPassword, resetPassword, getProfile, updateProfile, saveFcmToken };
