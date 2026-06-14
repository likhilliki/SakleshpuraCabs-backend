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
} = require('../controllers/driverController');
const { protectDriver } = require('../middleware/authMiddleware');

router.post('/kyc', protectDriver, submitKYC);
router.get('/status', protectDriver, getDriverStatus);
router.get('/profile', protectDriver, getDriverProfile);
router.put('/vehicle', protectDriver, updateVehicle);
router.put('/bank', protectDriver, updateBank);
router.put('/toggle-online', protectDriver, toggleOnline);
router.put('/location', protectDriver, updateLocation);
router.get('/online', getOnlineDrivers);

module.exports = router;
