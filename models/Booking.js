const mongoose = require('mongoose');

const BookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  pickupPlace: { type: mongoose.Schema.Types.ObjectId, ref: 'Place' },
  dropPlace: { type: mongoose.Schema.Types.ObjectId, ref: 'Place' },

  // Custom location support (Google Places)
  pickupCustom: {
    name: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    placeId: { type: String },
  },
  dropCustom: {
    name: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    placeId: { type: String },
  },

  fare: { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  driverEarning: { type: Number, default: 0 },

  // Vehicle type
  requestedVehicleType: {
    type: String,
    enum: ['auto', 'bike', 'car', 'suv', 'xuv'],
    default: 'car',
  },
  vehicleTypeMultiplier: { type: Number, default: 1.0 },

  status: {
    type: String,
    enum: ['pending', 'searching', 'accepted', 'started', 'completed', 'cancelled'],
    default: 'pending',
  },

  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'online'],
    default: 'online',
  },

  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },

  rideOtp: { type: String },

  startTime: { type: Date },
  endTime: { type: Date },
  cancelReason: { type: String },
  cancelledBy: { type: String, enum: ['user', 'driver', 'admin'] },

  driverAssignedAt: { type: Date },
  searchRadius: { type: Number, default: 5 },

  userRating: { type: Number, min: 1, max: 5 },
  userFeedback: { type: String },

  createdAt: { type: Date, default: Date.now },
});

BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ userId: 1, createdAt: -1 });
BookingSchema.index({ driverId: 1, createdAt: -1 });

module.exports = mongoose.model('Booking', BookingSchema);
