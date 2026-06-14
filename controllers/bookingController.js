const crypto = require('crypto');
const Razorpay = require('razorpay');
const Booking = require('../models/Booking');
const Place = require('../models/Place');
const Driver = require('../models/Driver');
const User = require('../models/User');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Helper function: Calculate distance using Haversine formula
const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const findNearestDriver = async (bookingId, pickupPlace, req) => {
  try {
    const allOnlineDrivers = await Driver.find({
      isOnline: true,
      isApproved: true,
      'currentLocation.lat': { $exists: true },
      'currentLocation.lng': { $exists: true }
    }).select('_id currentLocation name mobile vehicleNumber vehicleModel rating');

    const haversineDistance = (lat1, lng1, lat2, lng2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    const nearbyDrivers = allOnlineDrivers
      .filter(d => d.currentLocation && d.currentLocation.lat)
      .map(d => ({
        ...d.toObject(),
        distance: haversineDistance(
          pickupPlace.lat,
          pickupPlace.lng,
          d.currentLocation.lat,
          d.currentLocation.lng
        )
      }))
      .filter(d => d.distance <= 10)
      .sort((a, b) => a.distance - b.distance);

    if (nearbyDrivers.length === 0) {
      await Booking.findByIdAndUpdate(bookingId, {
        status: 'cancelled',
        cancelReason: 'No drivers available nearby',
        cancelledBy: 'admin'
      });

      if (req && req.app) {
        const io = req.app.locals.io;
        const booking = await Booking.findById(bookingId);
        if (booking && io) {
          io.to(`booking_${bookingId}`).emit('booking:noDrivers', {
            message: 'No drivers available nearby. Please try again.'
          });
        }
      }
      return null;
    }

    const nearestDriver = nearbyDrivers[0];

    // Update booking with driver
    const booking = await Booking.findByIdAndUpdate(bookingId, {
      driverId: nearestDriver._id,
      status: 'searching'
    }, { new: true })
      .populate('pickupPlace', 'name lat lng')
      .populate('dropPlace', 'name');

    // Dispatch ride request to driver via socket
    if (req && req.app) {
      const io = req.app.locals.io;
      const driverSockets = req.app.locals.driverSockets;
      const driverSocketId = driverSockets.get(nearestDriver._id.toString());

      if (driverSocketId && io) {
        io.to(driverSocketId).emit('driver:sendNewRideRequest', {
          bookingId: booking._id,
          pickup: {
            name: booking.pickupPlace.name,
            lat: booking.pickupPlace.lat,
            lng: booking.pickupPlace.lng
          },
          drop: {
            name: booking.dropPlace.name
          },
          fare: booking.fare,
          distance: Math.round(nearestDriver.distance * 10) / 10,
          timeoutSeconds: 15
        });
        console.log(`[Booking] Ride request sent to driver ${nearestDriver._id} for booking ${bookingId}`);
      } else {
        console.log(`[Booking] Driver ${nearestDriver._id} is not connected via socket`);
      }
    }

    return nearestDriver;
  } catch (err) {
    console.error('[Booking] findNearestDriver error:', err.message);
    return null;
  }
};

// FUNCTION 1: createBooking
exports.createBooking = async (req, res) => {
  try {
    const { pickupPlaceId, dropPlaceId, paymentMethod } = req.body;
    const userId = req.user._id;

    console.log(`[Booking] CREATE REQUEST - User: ${userId}, Pickup: ${pickupPlaceId}, Drop: ${dropPlaceId}, Method: ${paymentMethod}`);
    console.log(`[Booking] Full request body:`, JSON.stringify(req.body, null, 2));

    // Check if user already has an active booking (exclude pending - those are payment incomplete)
    const activeBooking = await Booking.findOne({
      userId,
      status: { $in: ['searching', 'accepted', 'started'] }
    });

    if (activeBooking) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active booking. Complete or cancel it first.'
      });
    }

    // Find both places
    const [pickupPlace, dropPlace] = await Promise.all([
      Place.findById(pickupPlaceId),
      Place.findById(dropPlaceId)
    ]);

    if (!pickupPlace || !dropPlace) {
      return res.status(404).json({
        success: false,
        message: 'One or both places not found'
      });
    }

    // Calculate fare
    let fare;
    if (pickupPlace.fareFromTown === 0) {
      fare = dropPlace.fareFromTown;
    } else if (dropPlace.fareFromTown === 0) {
      fare = pickupPlace.fareFromTown;
    } else {
      fare = Math.round((pickupPlace.fareFromTown + dropPlace.fareFromTown) * 0.7);
    }

    // Calculate platform fee and driver earning
    const platformFee = Math.round(fare * 0.10);
    const driverEarning = fare - platformFee;

    // Generate 4-digit OTP
    const rideOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Create booking
    let booking;

    if (paymentMethod === 'online') {
      // Create Razorpay order
      const order = await razorpay.orders.create({
        amount: fare * 100, // paise
        currency: 'INR',
        receipt: 'booking_' + Date.now(),
        notes: {
          userId: userId.toString(),
          pickupPlace: pickupPlaceId,
          dropPlace: dropPlaceId
        }
      });

      console.log(`[Booking] Creating online booking - User: ${userId}, Pickup: ${pickupPlaceId}, Drop: ${dropPlaceId}, Fare: ${fare}`);

      booking = await Booking.create({
        userId,
        pickupPlace: pickupPlaceId,
        dropPlace: dropPlaceId,
        fare,
        platformFee,
        driverEarning,
        paymentMethod: 'online',
        status: 'pending',
        razorpayOrderId: order.id,
        rideOtp
      });

      console.log(`[Booking] Online booking created successfully - ID: ${booking._id}`);

      return res.status(200).json({
        success: true,
        booking: {
          _id: booking._id,
          fare: booking.fare,
          status: booking.status
        },
        razorpayOrderId: order.id,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        amount: fare * 100,
        currency: 'INR'
      });
    } else if (paymentMethod === 'cash') {
      // Create booking with cash payment
      console.log(`[Booking] Creating cash booking - User: ${userId}, Pickup: ${pickupPlaceId}, Drop: ${dropPlaceId}, Fare: ${fare}`);
      
      booking = await Booking.create({
        userId,
        pickupPlace: pickupPlaceId,
        dropPlace: dropPlaceId,
        fare,
        platformFee,
        driverEarning,
        paymentMethod: 'cash',
        status: 'searching',
        rideOtp
      });

      console.log(`[Booking] Cash booking created successfully - ID: ${booking._id}`);

      // Find nearest driver asynchronously
      findNearestDriver(booking._id, pickupPlace, req);

      return res.status(200).json({
        success: true,
        booking: {
          _id: booking._id,
          fare: booking.fare,
          status: booking.status,
          rideOtp: booking.rideOtp
        },
        message: 'Searching for nearby driver'
      });
    }
  } catch (error) {
    console.error(`[Booking] ERROR creating booking - User: ${req.user._id}`);
    console.error(`[Booking] Error name: ${error.name}`);
    console.error(`[Booking] Error message: ${error.message}`);
    console.error(`[Booking] Error stack:`, error.stack);
    if (error.errors) {
      console.error(`[Booking] Validation errors:`, JSON.stringify(error.errors, null, 2));
    }
    
    // Return validation errors if present
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Booking validation failed',
        errors: error.errors,
        error: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Error creating booking',
      error: error.message
    });
  }
};

// FUNCTION 2: confirmPayment
exports.confirmPayment = async (req, res) => {
  try {
    const { bookingId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;
    const userId = req.user._id;

    console.log(`[Booking] CONFIRM PAYMENT - User: ${userId}, Booking: ${bookingId}, Order: ${razorpayOrderId}`);

    // Find booking and verify ownership
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized for this booking'
      });
    }

    // Check if already paid
    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already confirmed'
      });
    }

    // Verify Razorpay signature
    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpaySignature;

    if (!isValid) {
      booking.paymentStatus = 'failed';
      await booking.save();

      return res.status(400).json({
        success: false,
        message: 'Payment verification failed. Contact support.'
      });
    }

    // Update booking
    booking.paymentStatus = 'paid';
    booking.razorpayPaymentId = razorpayPaymentId;
    booking.razorpaySignature = razorpaySignature;
    booking.status = 'searching';
    await booking.save();

    // Find nearest driver
    const pickupPlace = await Place.findById(booking.pickupPlace);
    findNearestDriver(booking._id, pickupPlace, req);

    return res.status(200).json({
      success: true,
      message: 'Payment confirmed. Finding your driver.',
      booking
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error confirming payment',
      error: error.message
    });
  }
};

// FUNCTION 3: getBooking
exports.getBooking = async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`[Booking] GET BOOKING - ID: ${id}, User: ${req.user._id}`);

    const booking = await Booking.findById(id)
      .populate('userId', 'name mobile')
      .populate('driverId', 'name mobile vehicleNumber vehicleModel vehicleColor rating currentLocation')
      .populate('pickupPlace', 'name lat lng')
      .populate('dropPlace', 'name lat lng');

    if (!booking) {
      console.log(`[Booking] Booking not found - ID: ${id}`);
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    console.log(`[Booking] Booking found - ID: ${id}, Status: ${booking.status}`);

    // Verify ownership
    if (req.user._id.toString() !== booking.userId._id.toString() &&
        (booking.driverId === null || req.user._id.toString() !== booking.driverId._id.toString())) {
      console.log(`[Booking] Authorization failed - User: ${req.user._id}, Booking owner: ${booking.userId._id}`);
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this booking'
      });
    }

    return res.status(200).json({
      success: true,
      booking
    });
  } catch (error) {
    console.error(`[Booking] Error fetching booking:`, error.message);
    return res.status(500).json({
      success: false,
      message: 'Error fetching booking',
      error: error.message
    });
  }
};

// FUNCTION 4: cancelBooking
exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Verify ownership
    if (booking.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this booking'
      });
    }

    // Check if ride is in progress or completed
    if (['started', 'completed'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel a ride in progress or completed.'
      });
    }

    // Update booking
    booking.status = 'cancelled';
    booking.cancelReason = reason || 'User cancelled';
    booking.cancelledBy = 'user';
    await booking.save();

    const message = booking.paymentStatus === 'paid'
      ? 'Booking cancelled. Refund will be processed shortly.'
      : 'Booking cancelled';

    return res.status(200).json({
      success: true,
      message,
      booking
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error cancelling booking',
      error: error.message
    });
  }
};

// FUNCTION 5: rideHistory
exports.rideHistory = async (req, res) => {
  try {
    let query;

    if (req.role === 'driver') {
      query = { driverId: req.user._id, status: 'completed' };
    } else {
      query = { userId: req.user._id, status: 'completed' };
    }

    const bookings = await Booking.find(query)
      .populate('pickupPlace', 'name')
      .populate('dropPlace', 'name')
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({
      success: true,
      count: bookings.length,
      bookings
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error fetching ride history',
      error: error.message
    });
  }
};

// FUNCTION 6: activeBooking
exports.activeBooking = async (req, res) => {
  try {
    let query;

    if (req.role === 'user') {
      // FIXED: Exclude 'pending' status - pending means payment not completed
      query = {
        userId: req.user._id,
        status: { $in: ['searching', 'accepted', 'started'] }
      };
      console.log(`[Booking] GET ACTIVE BOOKING - User: ${req.user._id}`);
    } else if (req.role === 'driver') {
      query = {
        driverId: req.user._id,
        status: { $in: ['accepted', 'started'] }
      };
      console.log(`[Booking] GET ACTIVE BOOKING - Driver: ${req.user._id}`);
    }

    const booking = await Booking.findOne(query)
      .populate('userId')
      .populate('driverId')
      .populate('pickupPlace')
      .populate('dropPlace');

    if (booking) {
      console.log(`[Booking] Active booking found - ID: ${booking._id}, Status: ${booking.status}`);
    } else {
      console.log(`[Booking] No active booking found for user/driver`);
    }

    return res.status(200).json({
      success: true,
      booking: booking || null
    });
  } catch (error) {
    console.error(`[Booking] Error fetching active booking:`, error.message);
    return res.status(500).json({
      success: false,
      message: 'Error fetching active booking',
      error: error.message
    });
  }
};

// REST fallback: Start ride (driver)
exports.startRide = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const driverId = req.user._id;
    const { rideOtp } = req.body;

    if (!rideOtp) {
      return res.status(400).json({ success: false, message: 'rideOtp is required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (booking.status !== 'accepted') {
      return res.status(400).json({ success: false, message: 'Ride cannot be started. Invalid status: ' + booking.status });
    }

    if (booking.rideOtp !== rideOtp.toString()) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    booking.status = 'started';
    booking.startTime = new Date();
    await booking.save();

    // notify via socket if available
    try {
      const io = req.app.locals.io;
      if (io) io.to(`booking_${bookingId}`).emit('ride:started', { bookingId, startTime: booking.startTime, message: 'Ride has started' });
    } catch (err) {
      console.error('[startRide] socket emit error:', err.message);
    }

    return res.status(200).json({ success: true, booking });
  } catch (err) {
    console.error('[startRide] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to start ride', error: err.message });
  }
};

// REST fallback: Complete ride (driver)
exports.completeRide = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const driverId = req.user._id;

    const booking = await Booking.findById(bookingId).populate('pickupPlace', 'name').populate('dropPlace', 'name');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (booking.status !== 'started') {
      return res.status(400).json({ success: false, message: 'Cannot complete ride. Status is: ' + booking.status });
    }

    const endTime = new Date();
    const driverEarning = booking.driverEarning || Math.round(booking.fare * 0.9);

    booking.status = 'completed';
    booking.endTime = endTime;
    if (booking.paymentMethod === 'cash') booking.paymentStatus = 'pending';
    await booking.save();

    await Driver.findByIdAndUpdate(driverId, {
      $inc: {
        totalRides: 1,
        totalEarnings: driverEarning
      },
      isOnline: true
    });

    // notify via socket if available
    try {
      const io = req.app.locals.io;
      if (io) io.to(`booking_${bookingId}`).emit('booking:completed', {
        bookingId,
        endTime,
        fare: booking.fare,
        driverEarning,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        pickup: booking.pickupPlace.name,
        drop: booking.dropPlace.name,
        message: 'You have reached your destination!'
      });
    } catch (err) {
      console.error('[completeRide] socket emit error:', err.message);
    }

    return res.status(200).json({ success: true, booking, driverEarning });
  } catch (err) {
    console.error('[completeRide] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to complete ride', error: err.message });
  }
};

// FUNCTION: cashConfirm — user confirms they paid cash to driver
exports.cashConfirm = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const userId = req.user._id;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.userId.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (booking.paymentMethod !== 'cash') {
      return res.status(400).json({ success: false, message: 'This booking is not a cash payment' });
    }

    if (booking.paymentStatus === 'paid') {
      return res.status(200).json({ success: true, message: 'Already confirmed', booking });
    }

    booking.paymentStatus = 'paid';
    await booking.save();

    console.log(`[Booking] Cash confirmed for booking ${bookingId}`);

    return res.status(200).json({ success: true, message: 'Cash payment confirmed', booking });
  } catch (err) {
    console.error('[cashConfirm] error:', err.message);
    return res.status(500).json({ success: false, message: 'Error confirming cash payment', error: err.message });
  }
};

// FUNCTION: rateRide — user rates driver after ride
exports.rateRide = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const userId = req.user._id;
    const { rating } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.userId.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (booking.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Can only rate completed rides' });
    }

    if (booking.userRating) {
      return res.status(400).json({ success: false, message: 'You have already rated this ride' });
    }

    booking.userRating = rating;
    await booking.save();

    // Update driver's average rating
    if (booking.driverId) {
      const driverBookings = await Booking.find({
        driverId: booking.driverId,
        status: 'completed',
        userRating: { $exists: true, $ne: null }
      }).select('userRating');

      if (driverBookings.length > 0) {
        const avgRating = driverBookings.reduce((sum, b) => sum + b.userRating, 0) / driverBookings.length;
        await Driver.findByIdAndUpdate(booking.driverId, {
          rating: Math.round(avgRating * 10) / 10
        });
      }
    }

    console.log(`[Booking] Rating ${rating} submitted for booking ${bookingId}`);

    return res.status(200).json({ success: true, message: 'Rating submitted. Thank you!' });
  } catch (err) {
    console.error('[rateRide] error:', err.message);
    return res.status(500).json({ success: false, message: 'Error submitting rating', error: err.message });
  }
};
