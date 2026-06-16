const Driver = require('../models/Driver');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create Razorpay order for wallet topup
const createTopupOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 500) {
      return res.status(400).json({ success: false, message: 'Minimum topup is ₹500' });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: `wallet_${req.user._id}_${Date.now()}`,
      notes: { driverId: req.user._id.toString(), type: 'wallet_topup' },
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: amount * 100,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('[Wallet] createTopupOrder error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Verify Razorpay payment and credit wallet
const confirmTopup = async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, amount } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !amount) {
      return res.status(400).json({ success: false, message: 'All payment fields are required' });
    }

    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

    const driver = await Driver.findByIdAndUpdate(
      req.user._id,
      {
        $inc: { walletBalance: amount },
        $push: {
          walletTransactions: {
            type: 'credit',
            amount,
            reason: 'Wallet topup via Razorpay',
            razorpayPaymentId,
          },
        },
        $set: { hasMinimumWallet: true },
      },
      { new: true }
    );

    res.json({
      success: true,
      walletBalance: driver.walletBalance,
      message: `₹${amount} added to wallet`,
    });
  } catch (err) {
    console.error('[Wallet] confirmTopup error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get wallet balance and transactions
const getWallet = async (req, res) => {
  try {
    const driver = await Driver.findById(req.user._id).select('walletBalance walletTransactions');
    res.json({
      success: true,
      walletBalance: driver.walletBalance,
      transactions: driver.walletTransactions?.slice(-50).reverse() || [],
    });
  } catch (err) {
    console.error('[Wallet] getWallet error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Request UPI withdrawal
const requestWithdrawal = async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    const driver = await Driver.findById(req.user._id);

    if (!driver.bankAccount?.accountNumber && !upiId) {
      return res.status(400).json({
        success: false,
        message: 'Please add bank account or provide UPI ID first',
      });
    }

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum withdrawal is ₹100' });
    }

    if (driver.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    const destination = upiId || driver.bankAccount?.accountNumber;

    await Driver.findByIdAndUpdate(req.user._id, {
      $inc: { walletBalance: -amount },
      $push: {
        walletTransactions: {
          type: 'debit',
          amount,
          reason: `Withdrawal to: ${destination}`,
        },
      },
    });

    res.json({
      success: true,
      message: `Withdrawal of ₹${amount} requested. Will be processed within 24 hours.`,
    });
  } catch (err) {
    console.error('[Wallet] requestWithdrawal error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createTopupOrder, confirmTopup, getWallet, requestWithdrawal };
