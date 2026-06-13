const User = require("../models/User");
const Driver = require("../models/Driver");
const generateOTP = require("../utils/generateOTP");
const generateToken = require("../utils/generateToken");
const sendOTP = require("../utils/sendOTP");

const sendOtp = async (req, res) => {
  try {
    const { mobile, userType } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile)) {
      return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number" });
    }
    if (!userType || !["user", "driver"].includes(userType)) {
      return res.status(400).json({ success: false, message: "userType must be either user or driver" });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    let record;

    if (userType === "user") {
      record = await User.findOneAndUpdate(
        { mobile },
        { mobile, otp, otpExpiry },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      // Auto-create driver on first OTP request (self-registration flow)
      record = await Driver.findOneAndUpdate(
        { mobile },
        { mobile, otp, otpExpiry },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const result = await sendOTP(mobile, otp);
    if (!result.success) {
      return res.status(500).json({ success: false, message: "Failed to send OTP. Try again." });
    }

    const responseData = {
      success: true,
      message: `OTP sent to ${mobile}`,
    };
    if (process.env.NODE_ENV === "development") {
      responseData.otp = otp;
    }

    return res.status(200).json(responseData);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const { mobile, otp, userType } = req.body;
    if (!mobile || !otp || !userType) {
      return res.status(400).json({ success: false, message: "Mobile, OTP, and userType are required" });
    }
    if (!/^[0-9]{10}$/.test(mobile) || !/^[0-9]{6}$/.test(otp)) {
      return res.status(400).json({ success: false, message: "Enter a valid mobile number and 6-digit OTP" });
    }
    if (!["user", "driver"].includes(userType)) {
      return res.status(400).json({ success: false, message: "userType must be either user or driver" });
    }

    const Model = userType === "user" ? User : Driver;
    const record = await Model.findOne({ mobile });
    if (!record) {
      return res.status(404).json({ success: false, message: "Mobile number not registered. Please send OTP first." });
    }

    if (record.otp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP. Please check and try again." });
    }

    if (!record.otpExpiry || record.otpExpiry < new Date()) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }

    const updated = await Model.findByIdAndUpdate(
      record._id,
      { isVerified: true, otp: null, otpExpiry: null },
      { new: true }
    );

    const token = generateToken(updated._id, userType);
    if (userType === "user") {
      return res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: {
          _id: updated._id,
          name: updated.name,
          mobile: updated.mobile,
          isVerified: updated.isVerified,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      driver: {
        _id: updated._id,
        name: updated.name,
        mobile: updated.mobile,
        isVerified: updated.isVerified,
        isApproved: updated.isApproved,
        isOnline: updated.isOnline,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getProfile = async (req, res) => {
  try {
    const { user, role } = req;
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (role === 'user') {
      const foundUser = await User.findById(user._id).select('-otp -otpExpiry');
      return res.status(200).json({ success: true, user: foundUser });
    }

    const foundDriver = await Driver.findById(user._id).select('-otp -otpExpiry');
    return res.status(200).json({ success: true, driver: foundDriver });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { sendOtp, verifyOtp, getProfile };
