const jwt = require('jsonwebtoken');
const Booking = require('../models/Booking');
const Driver = require('../models/Driver');
const User = require('../models/User');
const { sendPushNotification } = require('../config/firebase');

const userSockets = new Map();
const driverSockets = new Map();
const socketIdentities = new Map();
const driverOfflineTimers = new Map();
const DRIVER_OFFLINE_GRACE_MS = 15000;

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const initSocket = (io) => {
  io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // ── IDENTITY REGISTRATION ──
    socket.on('register', ({ userId, role }) => {
      try {
        if (!userId || !role) return;
        socketIdentities.set(socket.id, { id: userId, role });
        if (role === 'driver') {
          driverSockets.set(userId, socket.id);
          if (driverOfflineTimers.has(userId)) {
            clearTimeout(driverOfflineTimers.get(userId));
            driverOfflineTimers.delete(userId);
          }
          console.log(`[Socket] Driver registered: ${userId}`);
        } else if (role === 'user') {
          userSockets.set(userId, socket.id);
          console.log(`[Socket] User registered: ${userId}`);
        }
      } catch (err) {
        console.error('[Socket] register error:', err.message);
      }
    });

    // ── ADMIN ROOM ──
    socket.on('join:admin', async ({ adminToken }) => {
      try {
        const decoded = jwt.verify(adminToken, process.env.JWT_SECRET);
        if (decoded.role === 'admin') {
          socket.join('admin_room');
          console.log('[Socket] Admin joined admin_room');
        }
      } catch (err) {
        socket.emit('error', { message: 'Invalid admin token' });
      }
    });

    // ── JOIN BOOKING ROOM ──
    socket.on('user:joinBookingRoom', ({ bookingId }) => {
      try { if (bookingId) socket.join(`booking_${bookingId}`); } catch (_) {}
    });

    socket.on('driver:joinBookingRoom', ({ bookingId }) => {
      try { if (bookingId) socket.join(`booking_${bookingId}`); } catch (_) {}
    });

    // ── DRIVER LOCATION UPDATE ──
    socket.on('driver:updateLocation', async ({ driverId, lat, lng, bearing }) => {
      try {
        if (!driverId || lat === undefined || lng === undefined) return;
        await Driver.findByIdAndUpdate(driverId, { currentLocation: { lat: parseFloat(lat), lng: parseFloat(lng), bearing: parseFloat(bearing) || 0, updatedAt: new Date() } });
        const activeBooking = await Booking.findOne({ driverId, status: { $in: ['accepted', 'started'] } }).select('_id');
        if (activeBooking) {
          io.to(`booking_${activeBooking._id}`).emit('user:driverLocation', { lat: parseFloat(lat), lng: parseFloat(lng), bearing: parseFloat(bearing) || 0, timestamp: Date.now() });
        }
      } catch (err) {
        console.error('[Socket] driver:updateLocation error:', err.message);
      }
    });

    // ── DRIVER ACCEPTS RIDE ──
    socket.on('driver:acceptRide', async ({ bookingId, driverId }) => {
      try {
        if (!bookingId || !driverId) return;
        const booking = await Booking.findById(bookingId).populate('pickupPlace', 'name lat lng').populate('dropPlace', 'name lat lng').populate('userId', 'name mobile fcmToken');
        if (!booking) { socket.emit('error', { message: 'Booking not found' }); return; }
        if (booking.status !== 'searching') { socket.emit('error', { message: 'Booking no longer available' }); return; }
        await Booking.findByIdAndUpdate(bookingId, { driverId, status: 'accepted', driverAssignedAt: new Date() });
        const driver = await Driver.findById(driverId).select('name mobile vehicleNumber vehicleModel vehicleColor vehicleType rating currentLocation profilePhoto');
        socket.join(`booking_${bookingId}`);
        const acceptPayload = {
          bookingId,
          driver: { _id: driver._id, name: driver.name, mobile: driver.mobile, vehicleNumber: driver.vehicleNumber, vehicleModel: driver.vehicleModel, vehicleColor: driver.vehicleColor, vehicleType: driver.vehicleType, rating: driver.rating, currentLocation: driver.currentLocation, profilePhoto: driver.profilePhoto },
          message: 'Driver is on the way!',
        };
        io.to(`booking_${bookingId}`).emit('booking:accepted', acceptPayload);
        const userSocketId = userSockets.get(booking.userId._id.toString());
        if (userSocketId) {
          const userSocket = io.sockets.sockets.get(userSocketId);
          if (!userSocket?.rooms.has(`booking_${bookingId}`)) {
            io.to(userSocketId).emit('booking:accepted', acceptPayload);
          }
        }
        // Push to user
        if (booking.userId?.fcmToken) {
          await sendPushNotification({ token: booking.userId.fcmToken, title: '🚗 Driver Found!', body: `${driver.name} is on the way in ${driver.vehicleModel}`, data: { bookingId: bookingId.toString(), screen: 'Tracking', type: 'driver_accepted' } });
        }
        // Notify admin
        io.to('admin_room').emit('admin:bookingUpdate', { bookingId, status: 'accepted', driverName: driver.name });
        console.log(`[Socket] Driver ${driverId} accepted booking ${bookingId}`);
      } catch (err) {
        console.error('[Socket] driver:acceptRide error:', err.message);
        socket.emit('error', { message: 'Failed to accept ride' });
      }
    });

    // ── DRIVER DECLINES RIDE ──
    socket.on('driver:declineRide', async ({ bookingId, driverId }) => {
      try {
        if (!bookingId || !driverId) return;
        const booking = await Booking.findById(bookingId).populate('pickupPlace', 'lat lng name').populate('dropPlace', 'name lat lng');
        if (!booking || booking.status !== 'searching') return;
        await Booking.findByIdAndUpdate(bookingId, { $unset: { driverId: 1 } });

        const allOnlineDrivers = await Driver.find({ isOnline: true, isApproved: true, _id: { $ne: driverId }, vehicleType: booking.requestedVehicleType || 'car', 'currentLocation.lat': { $exists: true } }).select('_id currentLocation name mobile vehicleNumber fcmToken');
        const nearbyDrivers = allOnlineDrivers
          .filter(d => d.currentLocation?.lat && d.currentLocation?.lng)
          .map(d => ({ ...d.toObject(), distance: haversineDistance(booking.pickupPlace.lat, booking.pickupPlace.lng, d.currentLocation.lat, d.currentLocation.lng) }))
          .filter(d => d.distance <= 10)
          .sort((a, b) => a.distance - b.distance);

        if (nearbyDrivers.length === 0) {
          await Booking.findByIdAndUpdate(bookingId, { status: 'cancelled', cancelReason: 'No drivers available nearby', cancelledBy: 'admin' });
          io.to(`booking_${bookingId}`).emit('booking:noDrivers', { bookingId, message: 'Sorry, no drivers are available nearby right now.' });
          const userSocketId = userSockets.get(booking.userId.toString());
          if (userSocketId) io.to(userSocketId).emit('booking:noDrivers', { message: 'No drivers available. Please try again.' });
          return;
        }

        const nextDriver = nearbyDrivers[0];
        const nextDriverSocketId = driverSockets.get(nextDriver._id.toString());
        const rideRequestPayload = {
          bookingId: booking._id,
          pickup: { name: booking.pickupPlace.name, lat: booking.pickupPlace.lat, lng: booking.pickupPlace.lng },
          drop: { name: booking.dropPlace?.name || 'Destination', lat: booking.dropPlace?.lat, lng: booking.dropPlace?.lng },
          fare: booking.fare,
          vehicleType: booking.requestedVehicleType,
          distance: Math.round(nextDriver.distance * 10) / 10,
          timeoutSeconds: 15,
        };
        if (nextDriverSocketId) {
          io.to(nextDriverSocketId).emit('driver:sendNewRideRequest', rideRequestPayload);
        } else {
          // fallback push
          if (nextDriver.fcmToken) {
            await sendPushNotification({ token: nextDriver.fcmToken, title: '🔔 New Ride Request!', body: `₹${booking.fare} · ${booking.pickupPlace?.name}`, data: { bookingId: booking._id.toString(), screen: 'RideRequest', type: 'new_ride', fare: String(booking.fare) } });
          }
        }
      } catch (err) {
        console.error('[Socket] driver:declineRide error:', err.message);
      }
    });

    // ── DRIVER STARTS RIDE (OTP verification) ──
    socket.on('driver:startRide', async ({ bookingId, driverId, rideOtp }) => {
      try {
        if (!bookingId || !driverId || !rideOtp) { socket.emit('error', { message: 'bookingId, driverId, and rideOtp are required' }); return; }
        const booking = await Booking.findById(bookingId);
        if (!booking) { socket.emit('error', { message: 'Booking not found' }); return; }
        if (booking.status !== 'accepted') { socket.emit('error', { message: 'Cannot start. Status: ' + booking.status }); return; }
        if (booking.rideOtp !== rideOtp.toString()) { socket.emit('ride:otpInvalid', { message: 'Invalid OTP. Ask passenger for the correct OTP.' }); return; }
        await Booking.findByIdAndUpdate(bookingId, { status: 'started', startTime: new Date() });
        io.to(`booking_${bookingId}`).emit('ride:started', { bookingId, startTime: new Date(), message: 'Ride has started. Enjoy your journey!' });
        console.log(`[Socket] Ride started: booking ${bookingId} by driver ${driverId}`);
      } catch (err) {
        console.error('[Socket] driver:startRide error:', err.message);
        socket.emit('error', { message: 'Failed to start ride' });
      }
    });

    // ── DRIVER COMPLETES RIDE ──
    socket.on('driver:completeRide', async ({ bookingId, driverId }) => {
      try {
        if (!bookingId || !driverId) return;
        const booking = await Booking.findById(bookingId).populate('pickupPlace', 'name').populate('dropPlace', 'name');
        if (!booking) { socket.emit('error', { message: 'Booking not found' }); return; }
        if (booking.status === 'completed') {
          const driverEarning = booking.driverEarning || Math.round(booking.fare * 0.9);
          io.to(`booking_${bookingId}`).emit('booking:completed', { bookingId, endTime: booking.endTime, fare: booking.fare, driverEarning, paymentMethod: booking.paymentMethod, paymentStatus: booking.paymentStatus, pickup: booking.pickupPlace?.name, drop: booking.dropPlace?.name, message: 'You have reached your destination!' });
          return;
        }
        if (booking.status !== 'started') { socket.emit('error', { message: 'Cannot complete. Status: ' + booking.status }); return; }
        const endTime = new Date();
        const driverEarning = booking.driverEarning || Math.round(booking.fare * 0.9);
        await Booking.findByIdAndUpdate(bookingId, { status: 'completed', endTime, paymentStatus: booking.paymentMethod === 'cash' ? 'pending' : booking.paymentStatus });
        await Driver.findByIdAndUpdate(driverId, { $inc: { totalRides: 1, totalEarnings: driverEarning }, isOnline: true });

        if (booking.paymentMethod === 'cash') {
          await Driver.findByIdAndUpdate(driverId, { $inc: { walletBalance: -200 }, $push: { walletTransactions: { type: 'debit', amount: 200, reason: 'Platform commission for cash trip', bookingId } } });
        } else if (booking.paymentMethod === 'online' && booking.paymentStatus === 'paid') {
          await Driver.findByIdAndUpdate(driverId, { $inc: { walletBalance: driverEarning }, $push: { walletTransactions: { type: 'credit', amount: driverEarning, reason: 'Online trip earning', bookingId } } });
        }

        io.to(`booking_${bookingId}`).emit('booking:completed', { bookingId, endTime, fare: booking.fare, driverEarning, paymentMethod: booking.paymentMethod, paymentStatus: booking.paymentStatus, pickup: booking.pickupPlace?.name, drop: booking.dropPlace?.name, message: 'You have reached your destination!' });

        // Push to user
        const user = await User.findById(booking.userId).select('fcmToken');
        if (user?.fcmToken) {
          await sendPushNotification({ token: user.fcmToken, title: '✅ Ride Complete!', body: `You have arrived at ${booking.dropPlace?.name}. Fare: ₹${booking.fare}`, data: { bookingId: bookingId.toString(), screen: 'Payment', type: 'ride_completed' } });
        }
        // Notify admin
        io.to('admin_room').emit('admin:rideCompleted', { bookingId, fare: booking.fare, driverName: (await Driver.findById(driverId).select('name'))?.name });
        console.log(`[Socket] Ride completed (socket): booking ${bookingId}`);
      } catch (err) {
        console.error('[Socket] driver:completeRide error:', err.message);
        socket.emit('error', { message: 'Failed to complete ride' });
      }
    });

    // ── USER CANCELS RIDE ──
    socket.on('user:cancelRide', async ({ bookingId, userId, reason }) => {
      try {
        if (!bookingId || !userId) return;
        const booking = await Booking.findById(bookingId);
        if (!booking || ['completed', 'cancelled'].includes(booking.status)) return;
        await Booking.findByIdAndUpdate(bookingId, { status: 'cancelled', cancelReason: reason || 'Cancelled by user', cancelledBy: 'user' });
        if (booking.driverId) {
          const driverSocketId = driverSockets.get(booking.driverId.toString());
          if (driverSocketId) io.to(driverSocketId).emit('booking:cancelledByUser', { bookingId, message: 'User has cancelled the ride.' });
          const driver = await Driver.findById(booking.driverId).select('fcmToken');
          if (driver?.fcmToken) {
            await sendPushNotification({ token: driver.fcmToken, title: '❌ Ride Cancelled', body: 'Passenger has cancelled the ride.', data: { bookingId: bookingId.toString(), type: 'ride_cancelled' } });
          }
        }
        io.to(`booking_${bookingId}`).emit('booking:cancelled', { bookingId, message: 'Booking cancelled' });
        console.log(`[Socket] Ride cancelled by user: booking ${bookingId}`);
      } catch (err) {
        console.error('[Socket] user:cancelRide error:', err.message);
      }
    });

    // ── DISCONNECT ──
    socket.on('disconnect', async () => {
      try {
        const identity = socketIdentities.get(socket.id);
        if (identity) {
          if (identity.role === 'driver') {
            driverSockets.delete(identity.id);
            const driverId = identity.id;
            if (driverOfflineTimers.has(driverId)) clearTimeout(driverOfflineTimers.get(driverId));
            const timer = setTimeout(async () => {
              driverOfflineTimers.delete(driverId);
              try {
                const activeBooking = await Booking.findOne({ driverId, status: { $in: ['accepted', 'started'] } }).select('_id');
                if (!activeBooking) {
                  await Driver.findByIdAndUpdate(driverId, { isOnline: false });
                  console.log(`[Socket] Driver marked offline: ${driverId}`);
                }
              } catch (err) {
                console.error('[Socket] Failed to set driver offline:', err.message);
              }
            }, DRIVER_OFFLINE_GRACE_MS);
            driverOfflineTimers.set(driverId, timer);
          } else if (identity.role === 'user') {
            userSockets.delete(identity.id);
          }
          socketIdentities.delete(socket.id);
        }
        console.log(`[Socket] Disconnected: ${socket.id}`);
      } catch (err) {
        console.error('[Socket] disconnect error:', err.message);
      }
    });
  });

  return { userSockets, driverSockets };
};

module.exports = { initSocket };
