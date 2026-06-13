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

// Make io and socket maps available to controllers via app locals
app.locals.io = io;
app.locals.userSockets = userSockets;
app.locals.driverSockets = driverSockets;

// Initialize booking cleanup scheduler
initializeBookingCleanup();

app.use(helmet({
    // React Native's HTTP client is treated as a cross-origin request.
    // "same-origin" (helmet default) blocks it with no response — causes
    // "Network Error" on the app. Set to "cross-origin" to allow mobile clients.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // COEP "require-corp" would also block RN — keep it disabled for APIs.
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

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.set('trust proxy', true);
app.use(limiter);

app.use("/api/auth", authRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/places", placeRoutes);
app.use("/api/admin", adminRoutes);

app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "Sakleshpur Cabs API running", timestamp: new Date() });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Server Error" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});