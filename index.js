require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");
const connectDB = require("./config/db");
const { initSocket } = require("./socket/socketHandler");
const { initializeBookingCleanup } = require("./utils/bookingCleanup");
const authRoutes = require("./routes/authRoutes");
const driverRoutes = require("./routes/driverRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const placeRoutes = require("./routes/placeRoutes");
const adminRoutes = require("./routes/adminRoutes");

connectDB();

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// Railway sits behind exactly 1 reverse proxy (Cloudflare / Railway's load
// balancer). Setting this to 1 tells Express to trust the first X-Forwarded-For
// hop only — satisfies express-rate-limit's validation without opening the app
// to IP spoofing from arbitrary clients.
// MUST be set BEFORE rateLimit() is constructed so the limiter sees the correct
// client IP from the start.
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

const { userSockets, driverSockets } = initSocket(io);
app.set('userSockets', userSockets);
app.set('driverSockets', driverSockets);
app.set('io', io);

app.locals.io = io;
app.locals.userSockets = userSockets;
app.locals.driverSockets = driverSockets;

initializeBookingCleanup();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));
app.use(
    fileUpload({
        createParentPath: true,
        limits: { fileSize: 10 * 1024 * 1024 },
    })
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Constructed AFTER trust proxy is set so express-rate-limit can validate
// the proxy config correctly.
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,              // raised slightly — 100 is too tight for mobile polling
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for health checks
    skip: (req) => req.path === '/api/health',
});
app.use(limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/places", placeRoutes);
app.use("/api/admin", adminRoutes);

app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "Sakleshpur Cabs API running", timestamp: new Date() });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Server Error" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
