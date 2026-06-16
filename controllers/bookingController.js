const crypto = require('crypto');
const Razorpay = require('razorpay');
const Booking = require('../models/Booking');
const Place = require('../models/Place');
const Driver = require('../models/Driver');
const User = require('../models/User');
const { sendPushNotification } = require('../config/firebase');
const { getDistanceKm } = require('../utils/helpers');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const VEHICLE_MULTIPLIERS = { auto: 0.8, bike: 0.7, car: 1.0, suv: 1.4, xuv: 1.6 };
const VEHICLE_INFO = {
  auto: { label: 'Auto', icon: '🛺', description: 'Affordable 3-wheeler', seats: 3, eta: '3 min' },
  bike: { label: 'Bike', icon: '🏍', description: 'Fastest & cheapest', seats: 1, eta: '2 min' },
  car:  { label: 'Car',  icon: '🚗', description: 'Comfortable sedan',  seats: 4, eta: '5 min' },
  suv:  { label: 'SUV',  icon: '🚙', description: 'Spacious for families', seats: 6, eta: '7 min' },
  xuv:  { label: 'XUV',  icon: '🛻', description: 'Premium large vehicle', seats: 7, eta: '8 min' },
};

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const findNearestDriver = async (bookingId, pickupLat, pickupLng, vehicleType, req) => {
  try {
    const allOnlineDrivers = await Driver.find({
      isOnline: true,
      isApproved: true,
      vehicleType: vehicleType || 'car',
      'currentLocation.lat': { $exists: true },
      'currentLocation.lng': { $exists: true },
    }).select('_id currentLocation name mobile vehicleNumber vehicleModel rating fcmToken vehicleType');

    const nearbyDrivers = allOnlineDrivers
      .filter(d => d.currentLocation?.lat)
      .map(d => ({
        ...d.toObject(),
        distance: haversineDistance(pickupLat, pickupLng, d.currentLocation.lat, d.currentLocation.lng),
      }))
      .filter(d => d.distance <= 10)
      .sort((a, b) => a.distance - b.distance);

    if (nearbyDrivers.length === 0) {
      await Booking.findByIdAndUpdate(bookingId, {
        status: 'cancelled',
        cancelReason: 'No drivers available nearby',
        cancelledBy: 'admin',
      });
      if (req?.app) {
        const io = req.app.locals.io;
        if (io) io.to(`booking_${bookingId}`).emit('booking:noDrivers', { message: 'No drivers available nearby.' });
        const booking = await Booking.findById(bookingId);
        if (booking) {
          const userSocketId = req.app.locals.userSockets?.get(booking.userId.toString());
          if (userSocketId) io.to(userSocketId).emit('booking:noDrivers', { message: 'No drivers available.' });
          const user = await User.findById(booking.userId).select('fcmToken');
          if (user?.fcmToken) {
            await sendPushNotification({ token: user.fcmToken, title: '😔 No Drivers Found', body: 'No drivers available nearby. Please try again in a few minutes.', data: { screen: 'Home', type: 'no_drivers' } });
          }
        }
      }
      return null;
    }

    const nearestDriver = nearbyDrivers[0];
    const booking = await Booking.findByIdAndUpdate(bookingId, { driverId: nearestDriver._id, status: 'searching' }, { new: true })
      .populate('pickupPlace', 'name lat lng')
      .populate('dropPlace', 'name');

    if (req?.app) {
      const io = req.app.locals.io;
      const driverSockets = req.app.locals.driverSockets;
      const driverSocketId = driverSockets?.get(nearestDriver._id.toString());
      if (driverSocketId && io) {
        io.to(driverSocketId).emit('driver:sendNewRideRequest', {
          bookingId: booking._id,
          pickup: { name: booking.pickupPlace?.name, lat: pickupLat, lng: pickupLng },
          drop: { name: booking.dropPlace?.name },
          fare: booking.fare,
          vehicleType: booking.requestedVehicleType,
          distance: Math.round(nearestDriver.distance * 10) / 10,
          timeoutSeconds: 15,
        });
      }
      if (nearestDriver.fcmToken) {
        await sendPushNotification({
          token: nearestDriver.fcmToken,
          title: '🔔 New Ride Request!',
          body: `₹${booking.fare} · ${booking.pickupPlace?.name} → ${booking.dropPlace?.name}`,
          data: { bookingId: booking._id.toString(), screen: 'RideRequest', type: 'new_ride', fare: String(booking.fare) },
        });
      }
    }
    return nearestDriver;
  } catch (err) {
    console.error('[Booking] findNearestDriver error:', err.message);
    return null;
  }
};

// GET /api/booking/fare-options
exports.getFareOptions = async (req, res) => {
  try {
    const { pickup, drop, pickupLat, pickupLng, dropLat, dropLng } = req.query;
    let baseFare;
    let pickupName = 'Pickup';
    let dropName = 'Drop';

    if (pickup && drop) {
      const [pickupPlace, dropPlace] = await Promise.all([Place.findById(pickup), Place.findById(drop)]);
      if (!pickupPlace || !dropPlace) return res.status(404).json({ success: false, message: 'Place not found' });
      pickupName = pickupPlace.name;
      dropName = dropPlace.name;
      if (pickupPlace.fareFromTown === 0) baseFare = dropPlace.fareFromTown;
      else if (dropPlace.fareFromTown === 0) baseFare = pickupPlace.fareFromTown;
      else baseFare = Math.round((pickupPlace.fareFromTown + dropPlace.fareFromTown) * 0.7);
    } else if (pickupLat && pickupLng && dropLat && dropLng) {
      const distanceKm = getDistanceKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dropLat), parseFloat(dropLng));
      baseFare = Math.max(50, Math.round(distanceKm * 12));
    } else {
      return res.status(400).json({ success: false, message: 'pickup/drop place IDs or coordinates required' });
    }

    const options = Object.entries(VEHICLE_MULTIPLIERS).map(([type, mult]) => {
      const fare = Math.round(baseFare * mult);
      return {
        type,
        ...VEHICLE_INFO[type],
        fare,
        platformFee: Math.round(fare * 0.1),
        driverEarning: Math.round(fare * 0.9),
      };
    });

    res.json({ success: true, baseFare, options, pickupName, dropName });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/booking/create
exports.createBooking = async (req, res) => {
  try {
    const { pickupPlaceId, dropPlaceId, paymentMethod, vehicleType, pickupCustom, dropCustom } = req.body;
    const userId = req.user._id;

    const activeBooking = await Booking.findOne({ userId, status: { $in: ['searching', 'accepted', 'started'] } });
    if (activeBooking) {
      return res.status(400).json({ success: false, message: 'You already have an active booking.' });
    }

    const requestedVehicleType = vehicleType || 'car';
    const multiplier = VEHICLE_MULTIPLIERS[requestedVehicleType] || 1.0;

    let baseFare;
    let pickupLat, pickupLng;
    const bookingData = { userId, paymentMethod: paymentMethod || 'online', requestedVehicleType, vehicleTypeMultiplier: multiplier };

    if (pickupPlaceId && dropPlaceId) {
      const [pickupPlace, dropPlace] = await Promise.all([Place.findById(pickupPlaceId), Place.findById(dropPlaceId)]);
      if (!pickupPlace || !dropPlace) return res.status(404).json({ success: false, message: 'One or both places not found' });
      if (pickupPlace.fareFromTown === 0) baseFare = dropPlace.fareFromTown;
      else if (dropPlace.fareFromTown === 0) baseFare = pickupPlace.fareFromTown;
      else baseFare = Math.round((pickupPlace.fareFromTown + dropPlace.fareFromTown) * 0.7);
      bookingData.pickupPlace = pickupPlaceId;
      bookingData.dropPlace = dropPlaceId;
      pickupLat = pickupPlace.lat;
      pickupLng = pickupPlace.lng;
    } else if (pickupCustom && dropCustom) {
      const distanceKm = getDistanceKm(pickupCustom.lat, pickupCustom.lng, dropCustom.lat, dropCustom.lng);
      baseFare = Math.max(50, Math.round(distanceKm * 12));
      bookingData.pickupCustom = pickupCustom;
      bookingData.dropCustom = dropCustom;
      pickupLat = pickupCustom.lat;
      pickupLng = pickupCustom.lng;
    } else {
      return res.status(400).json({ success: false, message: 'Provide pickupPlaceId/dropPlaceId or pickupCustom/dropCustom' });
    }

    const finalFare = Math.round(baseFare * multiplier);
    const platformFee = Math.round(finalFare * 0.10);
    const driverEarning = finalFare - platformFee;
    const rideOtp = Math.floor(1000 + Math.random() * 9000).toString();

    bookingData.fare = finalFare;
    bookingData.platformFee = platformFee;
    bookingData.driverEarning = driverEarning;
    bookingData.rideOtp = rideOtp;

    if (paymentMethod === 'online') {
      const order = await razorpay.orders.create({
        amount: finalFare * 100,
        currency: 'INR',
        receipt: `booking_${Date.now()}`,
        notes: { userId: userId.toString() },
      });
      bookingData.status = 'pending';
      bookingData.razorpayOrderId = order.id;
      const booking = await Booking.create(bookingData);
      return res.status(200).json({
        success: true,
        booking: { _id: booking._id, fare: booking.fare, status: booking.status },
        razorpayOrderId: order.id,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        amount: finalFare * 100,
        currency: 'INR',
      });
    } else {
      bookingData.status = 'searching';
      const booking = await Booking.create(bookingData);
      findNearestDriver(booking._id, pickupLat, pickupLng, requestedVehicleType, req);
      return res.status(200).json({
        success: true,
        booking: { _id: booking._id, fare: booking.fare, status: booking.status, rideOtp: booking.rideOtp },
        message: 'Searching for nearby driver',
      });
    }
  } catch (error) {
    console.error('[Booking] createBooking error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/booking/confirm-payment
exports.confirmPayment = async (req, res) => {
  try {
    const { bookingId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;
    const userId = req.user._id;
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.userId.toString() !== userId.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (booking.paymentStatus === 'paid') return res.status(400).json({ success: false, message: 'Payment already confirmed' });

    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    if (expectedSignature !== razorpaySignature) {
      booking.paymentStatus = 'failed';
      await booking.save();
      return res.status(400).json({ success: false, message: 'Payment verification failed.' });
    }

    booking.paymentStatus = 'paid';
    booking.razorpayPaymentId = razorpayPaymentId;
    booking.razorpaySignature = razorpaySignature;
    booking.status = 'searching';
    await booking.save();

    let pickupLat, pickupLng;
    if (booking.pickupPlace) {
      const pp = await Place.findById(booking.pickupPlace);
      if (pp) { pickupLat = pp.lat; pickupLng = pp.lng; }
    } else if (booking.pickupCustom) {
      pickupLat = booking.pickupCustom.lat;
      pickupLng = booking.pickupCustom.lng;
    }
    if (pickupLat !== undefined) {
      findNearestDriver(booking._id, pickupLat, pickupLng, booking.requestedVehicleType, req);
    }

    return res.status(200).json({ success: true, message: 'Payment confirmed. Finding your driver.', booking });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate('userId', 'name mobile')
      .populate('driverId', 'name mobile vehicleNumber vehicleModel vehicleColor vehicleType rating currentLocation profilePhoto')
      .populate('pickupPlace', 'name lat lng')
      .populate('dropPlace', 'name lat lng');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (req.user._id.toString() !== booking.userId?._id?.toString() &&
        (!booking.driverId || req.user._id.toString() !== booking.driverId?._id?.toString())) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this booking' });
    }
    return res.status(200).json({ success: true, booking });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (['started', 'completed'].includes(booking.status)) return res.status(400).json({ success: false, message: 'Cannot cancel a ride in progress or completed.' });
    booking.status = 'cancelled';
    booking.cancelReason = reason || 'User cancelled';
    booking.cancelledBy = 'user';
    await booking.save();
    if (booking.driverId) {
      const io = req.app?.locals?.io;
      const driverSockets = req.app?.locals?.driverSockets;
      const driverSocketId = driverSockets?.get(booking.driverId.toString());
      if (driverSocketId && io) {
        io.to(driverSocketId).emit('booking:cancelledByUser', { bookingId: id, message: 'Ride cancelled by passenger.' });
      }
      const driver = await Driver.findById(booking.driverId).select('fcmToken');
      if (driver?.fcmToken) {
        await sendPushNotification({ token: driver.fcmToken, title: '❌ Ride Cancelled', body: 'Passenger has cancelled the ride.', data: { bookingId: id, type: 'ride_cancelled' } });
      }
    }
    const msg = booking.paymentStatus === 'paid' ? 'Booking cancelled. Refund will be processed shortly.' : 'Booking cancelled';
    return res.status(200).json({ success: true, message: msg, booking });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.rideHistory = async (req, res) => {
  try {
    const query = req.role === 'driver'
      ? { driverId: req.user._id, status: 'completed' }
      : { userId: req.user._id, status: 'completed' };
    const bookings = await Booking.find(query)
      .populate('pickupPlace', 'name')
      .populate('dropPlace', 'name')
      .sort({ createdAt: -1 })
      .limit(20);
    return res.status(200).json({ success: true, count: bookings.length, bookings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.activeBooking = async (req, res) => {
  try {
    let query;
    if (req.role === 'user') {
      query = { userId: req.user._id, status: { $in: ['searching', 'accepted', 'started'] } };
    } else {
      query = { driverId: req.user._id, status: { $in: ['accepted', 'started'] } };
    }
    const booking = await Booking.findOne(query)
      .populate('userId')
      .populate('driverId')
      .populate('pickupPlace')
      .populate('dropPlace');
    return res.status(200).json({ success: true, booking: booking || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.startRide = async (req, res) => {
  try {
    const { rideOtp } = req.body;
    if (!rideOtp) return res.status(400).json({ success: false, message: 'rideOtp is required' });
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.status !== 'accepted') return res.status(400).json({ success: false, message: 'Ride cannot be started. Status: ' + booking.status });
    if (booking.rideOtp !== rideOtp.toString()) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    booking.status = 'started';
    booking.startTime = new Date();
    await booking.save();
    try {
      const io = req.app?.locals?.io;
      if (io) io.to(`booking_${req.params.id}`).emit('ride:started', { bookingId: req.params.id, startTime: booking.startTime });
    } catch (_) {}
    return res.status(200).json({ success: true, booking });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.completeRide = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const driverId = req.user._id;
    const booking = await Booking.findById(bookingId).populate('pickupPlace', 'name').populate('dropPlace', 'name');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.status !== 'started') return res.status(400).json({ success: false, message: 'Cannot complete. Status: ' + booking.status });
    const endTime = new Date();
    const driverEarning = booking.driverEarning || Math.round(booking.fare * 0.9);
    booking.status = 'completed';
    booking.endTime = endTime;
    if (booking.paymentMethod === 'cash') booking.paymentStatus = 'pending';
    await booking.save();
    await Driver.findByIdAndUpdate(driverId, { $inc: { totalRides: 1, totalEarnings: driverEarning }, isOnline: true });

    // Wallet: cash trips — deduct platform fee; online trips — credit earning
    if (booking.paymentMethod === 'cash') {
      await Driver.findByIdAndUpdate(driverId, {
        $inc: { walletBalance: -200 },
        $push: { walletTransactions: { type: 'debit', amount: 200, reason: 'Platform commission for cash trip', bookingId } },
      });
    } else if (booking.paymentMethod === 'online' && booking.paymentStatus === 'paid') {
      await Driver.findByIdAndUpdate(driverId, {
        $inc: { walletBalance: driverEarning },
        $push: { walletTransactions: { type: 'credit', amount: driverEarning, reason: 'Online trip earning', bookingId } },
      });
    }

    try {
      const io = req.app?.locals?.io;
      if (io) {
        io.to(`booking_${bookingId}`).emit('booking:completed', {
          bookingId, endTime, fare: booking.fare, driverEarning,
          paymentMethod: booking.paymentMethod, paymentStatus: booking.paymentStatus,
          pickup: booking.pickupPlace?.name, drop: booking.dropPlace?.name,
          message: 'You have reached your destination!',
        });
      }
    } catch (_) {}

    // Push to user
    const user = await User.findById(booking.userId).select('fcmToken');
    if (user?.fcmToken) {
      await sendPushNotification({
        token: user.fcmToken, title: '✅ Ride Complete!',
        body: `You have arrived at ${booking.dropPlace?.name}. Fare: ₹${booking.fare}`,
        data: { bookingId: bookingId.toString(), screen: 'Payment', type: 'ride_completed' },
      });
    }

    return res.status(200).json({ success: true, booking, driverEarning });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.cashConfirm = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (booking.paymentMethod !== 'cash') return res.status(400).json({ success: false, message: 'Not a cash booking' });
    if (booking.paymentStatus === 'paid') return res.status(200).json({ success: true, message: 'Already confirmed', booking });
    booking.paymentStatus = 'paid';
    await booking.save();
    return res.status(200).json({ success: true, message: 'Cash payment confirmed', booking });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.rateRide = async (req, res) => {
  try {
    const { rating, feedback } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1-5' });
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.userId.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (booking.status !== 'completed') return res.status(400).json({ success: false, message: 'Can only rate completed rides' });
    if (booking.userRating) return res.status(400).json({ success: false, message: 'Already rated' });
    booking.userRating = rating;
    booking.userFeedback = feedback || '';
    await booking.save();
    if (booking.driverId) {
      const driverBookings = await Booking.find({ driverId: booking.driverId, userRating: { $exists: true, $gt: 0 } });
      const avgRating = driverBookings.reduce((sum, b) => sum + b.userRating, 0) / driverBookings.length;
      await Driver.findByIdAndUpdate(booking.driverId, { rating: Math.round(avgRating * 10) / 10 });
    }
    return res.status(200).json({ success: true, message: 'Rating submitted. Thank you!' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
