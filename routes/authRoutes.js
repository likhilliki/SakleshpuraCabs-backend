const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, getProfile, updateProfile, saveFcmToken } = require('../controllers/authController');
const { protect, protectUser } = require('../middleware/authMiddleware');

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.get('/profile', protect, getProfile);
router.put('/update-profile', protectUser, updateProfile);
router.post('/fcm-token', protectUser, saveFcmToken);

module.exports = router;
