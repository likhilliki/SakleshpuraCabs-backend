require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const { initSocket } = require('./socket/socketHandler');
const { initializeBookingCleanup } = require('./utils/bookingCleanup');
const authRoutes = require('./routes/authRoutes');
const driverRoutes = require('./routes/driverRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const placeRoutes = require('./routes/placeRoutes');
const adminRoutes = require('./routes/adminRoutes');

connectDB();

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const { userSockets, driverSockets } = initSocket(io);
app.set('userSockets', userSockets);
app.set('driverSockets', driverSockets);
app.set('io', io);
app.locals.io = io;
app.locals.userSockets = userSockets;
app.locals.driverSockets = driverSockets;

initializeBookingCleanup();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
});
app.use(limiter);

app.use('/api/auth', authRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/places', placeRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Sakleshpur Cabs API running', timestamp: new Date() });
});

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.message?.includes('Only image files allowed')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  res.status(500).json({ success: false, message: err.message || 'Server Error' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
