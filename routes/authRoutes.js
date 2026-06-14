const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, getProfile } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// POST /api/auth/send-otp
router.post('/send-otp', sendOtp);

// POST /api/auth/verify-otp
router.post('/verify-otp', verifyOtp);

// GET /api/auth/profile  (protected)
router.get('/profile', protect, getProfile);

module.exports = router;
