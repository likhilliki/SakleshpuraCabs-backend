const jwt = require('jsonwebtoken');
const Booking = require('../models/Booking');
const Driver = require('../models/Driver');
const User = require('../models/User');
const Place = require('../models/Place');
const { sendPushNotification } = require('../config/firebase');

const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }
    const token = jwt.sign({ id: 'admin', role: 'admin', email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return res.status(200).json({ success: true, message: 'Admin login successful', token, admin: { email, role: 'admin' } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const [totalRidesToday, completedRidesToday, cancelledRidesToday, revenueToday,
           totalRidesAllTime, totalRevenueAllTime, totalDrivers, pendingKYCDrivers,
           approvedDrivers, onlineDrivers, totalUsers, activeRides] = await Promise.all([
      Booking.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      Booking.countDocuments({ status: 'completed', createdAt: { $gte: today, $lt: tomorrow } }),
      Booking.countDocuments({ status: 'cancelled', createdAt: { $gte: today, $lt: tomorrow } }),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', createdAt: { $gte: today, $lt: tomorrow } } }, { $group: { _id: null, total: { $sum: '$platformFee' } } }]),
      Booking.countDocuments({ status: 'completed' }),
      Booking.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$platformFee' } } }]),
      Driver.countDocuments(),
      Driver.countDocuments({ kycSubmitted: true, isApproved: false, isRejected: false }),
      Driver.countDocuments({ isApproved: true }),
      Driver.countDocuments({ isOnline: true }),
      User.countDocuments(),
      Booking.countDocuments({ status: { $in: ['searching', 'accepted', 'started'] } }),
    ]);
    return res.status(200).json({
      success: true,
      stats: {
        today: { totalRides: totalRidesToday, completedRides: completedRidesToday, cancelledRides: cancelledRidesToday, revenue: revenueToday[0]?.total || 0 },
        allTime: { totalRides: totalRidesAllTime, totalRevenue: totalRevenueAllTime[0]?.total || 0 },
        drivers: { total: totalDrivers, pending: pendingKYCDrivers, approved: approvedDrivers, online: onlineDrivers },
        users: { total: totalUsers },
        activeRides,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getLiveData = async (req, res) => {
  try {
    const drivers = await Driver.find({ isOnline: true, isApproved: true }).select('_id name mobile vehicleNumber vehicleModel vehicleType currentLocation rating');
    const bookings = await Booking.find({ status: { $in: ['searching', 'accepted', 'started'] } })
      .populate('userId', 'name mobile')
      .populate('driverId', 'name mobile vehicleNumber currentLocation')
      .populate('pickupPlace', 'name lat lng')
      .populate('dropPlace', 'name lat lng');
    return res.status(200).json({ success: true, onlineDrivers: drivers, activeBookings: bookings, counts: { onlineDrivers: drivers.length, activeBookings: bookings.length } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllDrivers = async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 20, search } = req.query;
    let filter = {};
    if (status === 'pending') filter = { kycSubmitted: true, isApproved: false, isRejected: false };
    else if (status === 'approved') filter = { isApproved: true };
    else if (status === 'rejected') filter = { isRejected: true };
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { mobile: { $regex: search, $options: 'i' } }];
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [drivers, total] = await Promise.all([
      Driver.find(filter).select('-otp -otpExpiry -walletTransactions').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Driver.countDocuments(filter),
    ]);
    return res.status(200).json({ success: true, drivers, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getDriverById = async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id).select('-otp -otpExpiry');
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    const completedRides = await Booking.countDocuments({ driverId: req.params.id, status: 'completed' });
    return res.status(200).json({ success: true, driver, completedRides });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const approveDriver = async (req, res) => {
  try {
    const { id } = req.params;
    let driver = await Driver.findById(id);
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    if (driver.isApproved) return res.status(400).json({ success: false, message: 'Driver is already approved' });
    driver = await Driver.findByIdAndUpdate(id, { isApproved: true, isRejected: false, rejectionReason: null, approvedAt: new Date() }, { new: true });

    const driverSockets = req.app.locals.driverSockets;
    const io = req.app.locals.io;
    const driverSocketId = driverSockets?.get(id);
    if (driverSocketId && io) {
      io.to(driverSocketId).emit('account:approved', { message: 'Congratulations! Your account has been approved. You can now go online and accept rides.' });
    }
    if (driver.fcmToken) {
      await sendPushNotification({ token: driver.fcmToken, title: '🎉 Account Approved!', body: 'Your KYC has been approved. Go online and start earning!', data: { screen: 'Home', type: 'account_approved' } });
    }
    return res.status(200).json({ success: true, message: 'Driver approved successfully.', driver: { _id: driver._id, name: driver.name, mobile: driver.mobile, isApproved: driver.isApproved, approvedAt: driver.approvedAt } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const rejectDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || reason.length < 10) return res.status(400).json({ success: false, message: 'Rejection reason must be at least 10 characters' });
    let driver = await Driver.findById(id);
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    driver = await Driver.findByIdAndUpdate(id, { isApproved: false, isRejected: true, rejectionReason: reason }, { new: true });

    const driverSockets = req.app.locals.driverSockets;
    const io = req.app.locals.io;
    const driverSocketId = driverSockets?.get(id);
    if (driverSocketId && io) {
      io.to(driverSocketId).emit('account:rejected', { reason, message: 'Your KYC was not approved. Reason: ' + reason });
    }
    if (driver.fcmToken) {
      await sendPushNotification({ token: driver.fcmToken, title: '❌ KYC Rejected', body: `Reason: ${reason}. Please resubmit with correct documents.`, data: { screen: 'Registration', type: 'account_rejected', reason } });
    }
    return res.status(200).json({ success: true, message: 'Driver rejected.', driver: { _id: driver._id, name: driver.name, isRejected: driver.isRejected, rejectionReason: driver.rejectionReason } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const blockDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { block } = req.body;
    let driver = await Driver.findById(id);
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    if (block === true) driver = await Driver.findByIdAndUpdate(id, { isApproved: false, isOnline: false, isBlocked: true }, { new: true });
    else driver = await Driver.findByIdAndUpdate(id, { isBlocked: false }, { new: true });
    const driverSockets = req.app.locals.driverSockets;
    const io = req.app.locals.io;
    const driverSocketId = driverSockets?.get(id);
    if (driverSocketId && io) {
      if (block === true) io.to(driverSocketId).emit('account:blocked', { message: 'Your account has been suspended by admin.' });
      else io.to(driverSocketId).emit('account:unblocked', { message: 'Your account suspension has been lifted.' });
    }
    return res.status(200).json({ success: true, message: block ? 'Driver blocked' : 'Driver unblocked' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllBookings = async (req, res) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 20, driverId, userId } = req.query;
    let filter = {};
    if (status) filter.status = status;
    if (startDate && endDate) filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    if (driverId) filter.driverId = driverId;
    if (userId) filter.userId = userId;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [bookings, total] = await Promise.all([
      Booking.find(filter).populate('userId', 'name mobile').populate('driverId', 'name mobile vehicleNumber').populate('pickupPlace', 'name').populate('dropPlace', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Booking.countDocuments(filter),
    ]);
    return res.status(200).json({ success: true, bookings, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('userId').populate('driverId').populate('pickupPlace').populate('dropPlace');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    return res.status(200).json({ success: true, booking });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    let filter = {};
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { mobile: { $regex: search, $options: 'i' } }];
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter).select('-otp -otpExpiry').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);
    const usersWithRideCount = await Promise.all(users.map(async (user) => {
      const rideCount = await Booking.countDocuments({ userId: user._id });
      return { ...user.toObject(), rideCount };
    }));
    return res.status(200).json({ success: true, users: usersWithRideCount, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getRevenueChart = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    startDate.setHours(0, 0, 0, 0);
    const revenueData = await Booking.aggregate([
      { $match: { paymentStatus: 'paid', createdAt: { $gte: startDate } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, totalRevenue: { $sum: '$fare' }, platformRevenue: { $sum: '$platformFee' }, rides: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]);
    return res.status(200).json({ success: true, data: revenueData, period: days + ' days' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const updatePlaceFare = async (req, res) => {
  try {
    const num = parseInt(req.body.fareFromTown, 10);
    if (isNaN(num) || num < 0) return res.status(400).json({ success: false, message: 'Fare must be 0 or a positive number' });
    const place = await Place.findByIdAndUpdate(req.params.id, { fareFromTown: num }, { new: true });
    if (!place) return res.status(404).json({ success: false, message: 'Place not found' });
    return res.status(200).json({ success: true, message: 'Fare updated to ₹' + num, place: { _id: place._id, name: place.name, fareFromTown: place.fareFromTown } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllPlacesAdmin = async (req, res) => {
  try {
    const places = await Place.find().sort({ isFeatured: -1, fareFromTown: 1 });
    return res.status(200).json({ success: true, count: places.length, places });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const createPlace = async (req, res) => {
  try {
    const { name, category, description, lat, lng, fareFromTown, distanceFromTown, estimatedDuration, isActive, isFeatured } = req.body;
    if (!name || !category || lat === undefined || lng === undefined || fareFromTown === undefined) {
      return res.status(400).json({ success: false, message: 'name, category, lat, lng, fareFromTown are required' });
    }
    const existing = await Place.findOne({ name: { $regex: `^${name.trim()}$`, $options: 'i' } });
    if (existing) return res.status(400).json({ success: false, message: 'A place with this name already exists' });
    const place = await Place.create({ name: name.trim(), category, description: description || '', lat: parseFloat(lat), lng: parseFloat(lng), fareFromTown: parseInt(fareFromTown, 10), distanceFromTown: distanceFromTown ? parseFloat(distanceFromTown) : 0, estimatedDuration: estimatedDuration ? parseInt(estimatedDuration, 10) : 0, isActive: isActive !== false, isFeatured: isFeatured === true });
    return res.status(201).json({ success: true, message: 'Place created successfully', place });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const updatePlace = async (req, res) => {
  try {
    const { name, category, description, lat, lng, fareFromTown, distanceFromTown, estimatedDuration, isActive, isFeatured } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (category !== undefined) updateData.category = category;
    if (description !== undefined) updateData.description = description;
    if (lat !== undefined) updateData.lat = parseFloat(lat);
    if (lng !== undefined) updateData.lng = parseFloat(lng);
    if (fareFromTown !== undefined) updateData.fareFromTown = parseInt(fareFromTown, 10);
    if (distanceFromTown !== undefined) updateData.distanceFromTown = parseFloat(distanceFromTown);
    if (estimatedDuration !== undefined) updateData.estimatedDuration = parseInt(estimatedDuration, 10);
    if (isActive !== undefined) updateData.isActive = isActive;
    if (isFeatured !== undefined) updateData.isFeatured = isFeatured;
    const place = await Place.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!place) return res.status(404).json({ success: false, message: 'Place not found' });
    return res.status(200).json({ success: true, message: 'Place updated successfully', place });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deletePlace = async (req, res) => {
  try {
    const { permanent } = req.query;
    if (permanent === 'true') {
      const activeBookings = await Booking.countDocuments({ $or: [{ pickupPlace: req.params.id }, { dropPlace: req.params.id }], status: { $in: ['searching', 'accepted', 'started'] } });
      if (activeBookings > 0) return res.status(400).json({ success: false, message: 'Cannot delete place with active bookings' });
      await Place.findByIdAndDelete(req.params.id);
      return res.status(200).json({ success: true, message: 'Place permanently deleted' });
    }
    const place = await Place.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!place) return res.status(404).json({ success: false, message: 'Place not found' });
    return res.status(200).json({ success: true, message: 'Place deactivated', place });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const [topRoutes, busiestHours, popularDestinations] = await Promise.all([
      Booking.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: { pickup: '$pickupPlace', drop: '$dropPlace' }, count: { $sum: 1 }, totalRevenue: { $sum: '$fare' } } }, { $sort: { count: -1 } }, { $limit: 5 }, { $lookup: { from: 'places', localField: '_id.pickup', foreignField: '_id', as: 'pickupDetails' } }, { $lookup: { from: 'places', localField: '_id.drop', foreignField: '_id', as: 'dropDetails' } }]),
      Booking.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Booking.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: '$dropPlace', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }, { $lookup: { from: 'places', localField: '_id', foreignField: '_id', as: 'place' } }]),
    ]);
    return res.status(200).json({ success: true, topRoutes, busiestHours, popularDestinations });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  adminLogin, getDashboardStats, getLiveData, getAllDrivers, getDriverById,
  approveDriver, rejectDriver, blockDriver, getAllBookings, getBookingById,
  getAllUsers, getRevenueChart, updatePlaceFare, getAllPlacesAdmin, createPlace,
  updatePlace, deletePlace, getAnalytics,
};
