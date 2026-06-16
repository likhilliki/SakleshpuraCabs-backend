const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage — we pipe the buffer to Cloudinary ourselves
const memStorage = multer.memoryStorage();

const uploadKYC = multer({
  storage: memStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'), false);
    }
    cb(null, true);
  },
});

const uploadProfile = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'), false);
    }
    cb(null, true);
  },
});

/**
 * Upload a buffer to Cloudinary and return the secure URL.
 * @param {Buffer} buffer
 * @param {Object} options  - folder, public_id, transformation, etc.
 * @returns {Promise<string>} secure_url
 */
const uploadBufferToCloudinary = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
};

/**
 * Express middleware: after multer (memoryStorage) runs, iterate over req.files
 * and upload each buffer to Cloudinary, replacing file.buffer with file.path (Cloudinary URL).
 * This keeps driverController.js interface unchanged — req.files[field][0].path = Cloudinary URL.
 */
const uploadFilesToCloudinary = async (req, res, next) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) return next();

    const driverId = req.user?._id || 'unknown';
    const kycFields = ['aadhaarPhoto', 'drivingLicensePhoto', 'rcBookPhoto'];
    const profileFields = ['profilePhoto'];

    await Promise.all(
      Object.entries(req.files).map(async ([fieldName, fileArr]) => {
        const file = fileArr[0];
        const isProfile = profileFields.includes(fieldName);
        const folder = isProfile
          ? 'vibzz/profiles'
          : `vibzz/kyc/${driverId}`;
        const transformation = isProfile
          ? [{ width: 400, height: 400, crop: 'fill', quality: 'auto' }]
          : [{ width: 1200, quality: 'auto', fetch_format: 'auto' }];

        const url = await uploadBufferToCloudinary(file.buffer, {
          folder,
          public_id: `${fieldName}-${Date.now()}`,
          transformation,
        });
        // Patch .path so driverController reads it directly
        req.files[fieldName][0].path = url;
      })
    );
    next();
  } catch (err) {
    console.error('[Cloudinary] Upload error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to upload images. Please try again.' });
  }
};

module.exports = { cloudinary, uploadKYC, uploadProfile, uploadBufferToCloudinary, uploadFilesToCloudinary };
