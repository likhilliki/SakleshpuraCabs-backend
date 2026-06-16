const express = require('express');
const router = express.Router();
const {
  register, verifyOtp, login, resendOtp,
  forgotPassword, resetPassword, getProfile, updateProfile, saveFcmToken,
} = require('../controllers/authController');
const { protect, protectUser } = require('../middleware/authMiddleware');

// Public — no token needed
router.post('/register',        register);        // Step 1: signup → sends OTP
router.post('/verify-otp',      verifyOtp);       // Step 2: verify OTP → activate account
router.post('/login',           login);           // Login with mobile/email + password
router.post('/resend-otp',      resendOtp);       // Resend OTP for unverified account
router.post('/forgot-password', forgotPassword);  // Send OTP for password reset
router.post('/reset-password',  resetPassword);   // Verify OTP + set new password

// Protected
router.get('/profile',          protect,     getProfile);
router.put('/update-profile',   protectUser, updateProfile);
router.post('/fcm-token',       protectUser, saveFcmToken);

module.exports = router;
