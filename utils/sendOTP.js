/**
 * sendOTP — Multi-provider SMS gateway for India
 *
 * Primary:  Fast2SMS  (route=otp, no DLT required, has free tier)
 * Fallback: MSG91     (v5 OTP API, requires DLT template + SMS credits)
 *
 * Configuration via .env:
 *   FAST2SMS_API_KEY   — get from fast2sms.com → Dev API section (required for primary)
 *   MSG91_AUTH_KEY     — MSG91 auth key (fallback)
 *   MSG91_TEMPLATE_ID  — DLT approved template ID on MSG91 (fallback)
 */

const axios = require('axios');

/* ─── Fast2SMS ──────────────────────────────────────────────────────────────
   Endpoint: GET https://www.fast2sms.com/dev/bulk
   Params:   authorization (API key in header), route=otp, variables_values=OTP,
             numbers=10-digit mobile
   No DLT registration needed for "otp" route.
   Free account gives ₹50 credit which handles ~100+ OTPs.
   Sign up: https://www.fast2sms.com/
──────────────────────────────────────────────────────────────────────────── */
const sendViaFast2SMS = async (mobile, otp) => {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'FAST2SMS_API_KEY not configured' };
  }

  try {
    const response = await axios.get('https://www.fast2sms.com/dev/bulk', {
      params: {
        authorization: apiKey,
        variables_values: otp,
        route: 'otp',
        numbers: mobile,
      },
      headers: {
        'Cache-Control': 'no-cache',
      },
      timeout: 10000,
    });

    const data = response.data;
    console.log(`[OTP] Fast2SMS response for ${mobile}:`, JSON.stringify(data));

    // Fast2SMS returns { return: true, request_id: '...', message: [...] } on success
    if (data?.return === true) {
      return { success: true, provider: 'fast2sms', data };
    }

    // Non-true return means failure
    return { success: false, provider: 'fast2sms', error: data?.message || 'Unknown Fast2SMS error' };
  } catch (err) {
    const errDetail = err.response?.data || err.message;
    console.error('[OTP] Fast2SMS error:', JSON.stringify(errDetail));
    return { success: false, provider: 'fast2sms', error: errDetail };
  }
};

/* ─── MSG91 ─────────────────────────────────────────────────────────────────
   Requires: SMS credits + DLT-registered template in India
   Used as fallback if Fast2SMS is not configured or fails.
──────────────────────────────────────────────────────────────────────────── */
const sendViaMsg91 = async (mobile, otp) => {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID || '';

  if (!authKey) {
    return { success: false, error: 'MSG91_AUTH_KEY not configured' };
  }

  try {
    const formattedMobile = `91${mobile}`;
    let url = `https://api.msg91.com/api/v5/otp?mobile=${formattedMobile}&authkey=${authKey}&otp=${otp}`;
    if (templateId) url += `&template_id=${templateId}`;

    const response = await axios.post(url, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    console.log(`[OTP] MSG91 response for ${mobile}:`, JSON.stringify(response.data));

    if (response.data?.type === 'success') {
      return { success: true, provider: 'msg91', data: response.data };
    }

    return { success: false, provider: 'msg91', error: response.data };
  } catch (err) {
    const errDetail = err.response?.data || err.message;
    console.error('[OTP] MSG91 error:', JSON.stringify(errDetail));
    return { success: false, provider: 'msg91', error: errDetail };
  }
};

/* ─── Main export ────────────────────────────────────────────────────────── */
const sendOTP = async (mobile, otp) => {
  console.log(`[OTP] Sending OTP to ${mobile}`);

  // Try Fast2SMS first
  if (process.env.FAST2SMS_API_KEY) {
    const result = await sendViaFast2SMS(mobile, otp);
    if (result.success) {
      console.log(`[OTP] ✓ Delivered via Fast2SMS to ${mobile}`);
      return { success: true };
    }
    console.warn(`[OTP] Fast2SMS failed:`, result.error, '— trying MSG91 fallback...');
  }

  // Fallback to MSG91
  if (process.env.MSG91_AUTH_KEY) {
    const result = await sendViaMsg91(mobile, otp);
    if (result.success) {
      console.log(`[OTP] ✓ Delivered via MSG91 to ${mobile}`);
      return { success: true };
    }
    console.error(`[OTP] MSG91 also failed:`, result.error);
    return { success: false, error: `SMS delivery failed. Fast2SMS: ${JSON.stringify(result.error)}` };
  }

  // No provider configured
  console.error('[OTP] No SMS provider configured! Set FAST2SMS_API_KEY in .env');
  return { success: false, error: 'No SMS provider configured' };
};

module.exports = sendOTP;
