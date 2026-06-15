const express = require('express');
const router = express.Router();
const {
  adminLogin,
  getDashboardStats,
  getLiveData,
  getAllDrivers,
  getDriverById,
  approveDriver,
  rejectDriver,
  blockDriver,
  getAllBookings,
  getBookingById,
  getAllUsers,
  getRevenueChart,
  updatePlaceFare,
  getAllPlacesAdmin,
  createPlace,
  updatePlace,
  deletePlace,
  getAnalytics,
} = require('../controllers/adminController');
const { adminAuth } = require('../middleware/adminMiddleware');

// Public
router.post('/login', adminLogin);

// Dashboard
router.get('/stats',     adminAuth, getDashboardStats);

// Live map
router.get('/live',      adminAuth, getLiveData);

// Drivers
router.get('/drivers',           adminAuth, getAllDrivers);
router.get('/drivers/:id',       adminAuth, getDriverById);
router.put('/drivers/:id/approve', adminAuth, approveDriver);
router.put('/drivers/:id/reject',  adminAuth, rejectDriver);
router.put('/drivers/:id/block',   adminAuth, blockDriver);

// Bookings
router.get('/bookings',      adminAuth, getAllBookings);
router.get('/bookings/:id',  adminAuth, getBookingById);

// Users
router.get('/users', adminAuth, getAllUsers);

// Revenue & Analytics
router.get('/revenue',   adminAuth, getRevenueChart);
router.get('/analytics', adminAuth, getAnalytics);

// Places — full CRUD
router.get('/places',              adminAuth, getAllPlacesAdmin);
router.post('/places',             adminAuth, createPlace);
router.put('/places/:id',          adminAuth, updatePlace);
router.put('/places/:id/fare',     adminAuth, updatePlaceFare);
router.delete('/places/:id',       adminAuth, deletePlace);

module.exports = router;
