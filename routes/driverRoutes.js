const express = require('express');
const router = express.Router();
const {
  submitKYC,
  getDriverStatus,
  updateVehicle,
  updateBank,
  toggleOnline,
  updateLocation,
  getOnlineDrivers,
  getDriverProfile,
  saveFcmToken,
} = require('../controllers/driverController');
const { createTopupOrder, confirmTopup, getWallet, requestWithdrawal } = require('../controllers/walletController');
const { protectDriver } = require('../middleware/authMiddleware');
const { uploadKYC, uploadFilesToCloudinary } = require('../config/cloudinary');

router.post('/kyc', protectDriver, uploadKYC.fields([
  { name: 'aadhaarPhoto', maxCount: 1 },
  { name: 'drivingLicensePhoto', maxCount: 1 },
  { name: 'rcBookPhoto', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
]), uploadFilesToCloudinary, submitKYC);

router.get('/status', protectDriver, getDriverStatus);
router.get('/profile', protectDriver, getDriverProfile);
router.put('/vehicle', protectDriver, updateVehicle);
router.put('/bank', protectDriver, updateBank);
router.put('/toggle-online', protectDriver, toggleOnline);
router.put('/location', protectDriver, updateLocation);
router.get('/online', getOnlineDrivers);
router.post('/fcm-token', protectDriver, saveFcmToken);

// Wallet routes
router.get('/wallet', protectDriver, getWallet);
router.post('/wallet/topup', protectDriver, createTopupOrder);
router.post('/wallet/confirm-topup', protectDriver, confirmTopup);
router.post('/wallet/withdraw', protectDriver, requestWithdrawal);

module.exports = router;
