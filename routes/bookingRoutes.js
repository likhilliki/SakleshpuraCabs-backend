const express = require('express');
const router = express.Router();
const {
  createBooking,
  confirmPayment,
  getBooking,
  cancelBooking,
  rideHistory,
  activeBooking,
  startRide,
  completeRide,
  cashConfirm,
  rateRide,
  getFareOptions,
} = require('../controllers/bookingController');
const { protect, protectUser, protectDriver } = require('../middleware/authMiddleware');

router.get('/fare-options', protect, getFareOptions);
router.post('/create', protectUser, createBooking);
router.post('/confirm-payment', protectUser, confirmPayment);
router.get('/history', protect, rideHistory);
router.get('/active', protect, activeBooking);
router.get('/:id', protect, getBooking);
router.put('/:id/cancel', protect, cancelBooking);
router.put('/:id/cash-confirm', protectUser, cashConfirm);
router.post('/:id/rate', protectUser, rateRide);

// Driver actions
router.put('/:id/start', protectDriver, startRide);
router.put('/:id/complete', protectDriver, completeRide);

module.exports = router;
