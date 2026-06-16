const axios = require('axios');

const sendOTP = async (mobile, otp) => {
  const formattedMobile = `91${mobile}`;

  // Always attempt real SMS via MSG91 — never skip in any environment.
  // If MSG91_AUTH_KEY is not set, fall back to console log only (local dev without key).
  if (!process.env.MSG91_AUTH_KEY) {
    console.log(`[OTP] No MSG91_AUTH_KEY set. OTP for ${mobile}: ${otp}`);
    return { success: true };
  }

  try {
    const url = `https://api.msg91.com/api/v5/otp?mobile=${formattedMobile}&authkey=${process.env.MSG91_AUTH_KEY}&otp=${otp}&template_id=${process.env.MSG91_TEMPLATE_ID || ''}`;
    const response = await axios.post(url, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log(`[OTP] MSG91 sent to ${mobile}:`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('[OTP] MSG91 Error:', error.response?.data || error.message);
    // Don't fail silently — surface the error so admin can diagnose
    return { success: false, error: error.response?.data || error.message };
  }
};

module.exports = sendOTP;
