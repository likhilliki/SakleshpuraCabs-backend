const admin = require('firebase-admin');

let firebaseApp;

const initFirebase = () => {
  if (firebaseApp) return firebaseApp;

  const serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };

  try {
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (err) {
    // Already initialized
    firebaseApp = admin.app();
  }
  return firebaseApp;
};

const sendPushNotification = async ({ token, title, body, data = {} }) => {
  try {
    if (!token) return { success: false, error: 'No FCM token' };
    if (!process.env.FIREBASE_PROJECT_ID) {
      console.warn('[FCM] Firebase not configured — skipping push notification');
      return { success: false, error: 'Firebase not configured' };
    }
    initFirebase();
    const message = {
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      token,
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'sakleshpur_cabs' },
      },
    };
    const response = await admin.messaging().send(message);
    return { success: true, messageId: response };
  } catch (err) {
    console.error('[FCM] sendPushNotification error:', err.message);
    return { success: false, error: err.message };
  }
};

const sendMulticastNotification = async ({ tokens, title, body, data = {} }) => {
  try {
    if (!tokens?.length) return { success: false };
    if (!process.env.FIREBASE_PROJECT_ID) return { success: false, error: 'Firebase not configured' };
    initFirebase();
    const message = {
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      tokens: tokens.filter(Boolean),
      android: { priority: 'high', notification: { sound: 'default', channelId: 'sakleshpur_cabs' } },
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    return { success: true, successCount: response.successCount };
  } catch (err) {
    console.error('[FCM] sendMulticastNotification error:', err.message);
    return { success: false, error: err.message };
  }
};

module.exports = { sendPushNotification, sendMulticastNotification, initFirebase };
