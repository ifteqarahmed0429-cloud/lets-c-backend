// ==========================================
// 🌍 Let's C – Secure Video Chat Backend
// ==========================================

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// -------------------------------
// 🔒 Security Middleware Setup
// -------------------------------
const app = express();

// 1️⃣ Helmet – sets safe HTTP headers
app.use(helmet());

// 2️⃣ CORS – restrict access to allowed domains
const allowedOrigins = [
  "http://localhost:5173", // dev environment
  "https://letsc.live",    // your production domain (update later)
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST"],
  })
);

// 3️⃣ Rate Limiting – prevent abuse & DDoS
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 100,          // max 100 requests per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use(limiter);

// 4️⃣ Body Parser
app.use(express.json());

// -------------------------------
// ⚙️ Create HTTP + Socket Server
// -------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

// -------------------------------
// 🧩 Matchmaking Queues
// -------------------------------
const queues = new Map(); // country => [socketId]
const globalQueue = [];   // fallback for global pool
const prefs = new Map();  // socketId => { country }

function enqueue(socket, country) {
  if (country === "Global") globalQueue.push(socket.id);
  else {
    if (!queues.has(country)) queues.set(country, []);
    queues.get(country).push(socket.id);
  }
}

function findPartnerFor(country, selfId) {
  const take = (arr) => {
    while (arr.length) {
      const id = arr.shift();
      if (id && id !== selfId) return id;
    }
    return null;
  };

  // Try same-country first
  if (country !== "Global" && queues.has(country)) {
    const id = take(queues.get(country));
    if (id) return id;
  }

  // Then global queue fallback
  const gid = take(globalQueue);
  if (gid) return gid;

  return null;
}

// -------------------------------
// 🔗 Socket.io Events
// -------------------------------
io.on("connection", (socket) => {
  console.log("👤 User connected:", socket.id);
  prefs.set(socket.id, { country: "Global" });

  // 🕐 Idle timeout (auto disconnect after 5 min)
  const idleTimer = setTimeout(() => {
    console.log(`⏰ Idle timeout for ${socket.id}`);
    socket.disconnect(true);
  }, 5 * 60 * 1000);

  socket.on("activity", () => clearTimeout(idleTimer)); // reset if frontend emits "activity"

  // Set country preference
  socket.on("set-preference", ({ country }) => {
    prefs.set(socket.id, { country: country || "Global" });
  });

  // Try pairing users
  const tryPair = () => {
    const pref = prefs.get(socket.id) || { country: "Global" };
    const partnerId = findPartnerFor(pref.country, socket.id);

    if (partnerId) {
      const partnerPref = prefs.get(partnerId) || { country: "Global" };

      socket.emit("partner-found", {
        partnerId,
        initiator: true,
        country: partnerPref.country,
      });

      io.to(partnerId).emit("partner-found", {
        partnerId: socket.id,
        initiator: false,
        country: pref.country,
      });

      console.log(`✅ Matched ${socket.id} ↔ ${partnerId}`);
    } else {
      enqueue(socket, pref.country);
      console.log(`🕓 Queued ${socket.id} (${pref.country})`);
    }
  };

  tryPair();

  // WebRTC signaling relay
  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // Next button: requeue both users
  socket.on("next", ({ partnerId }) => {
    console.log(`🔁 ${socket.id} requested next`);
    const pref = prefs.get(socket.id) || { country: "Global" };
    tryPair();
    if (partnerId) io.to(partnerId).emit("partner-left");
  });

  // ⚠️ Handle user reports
const reports = new Map(); // socketId => count

socket.on("report-user", ({ partnerId }) => {
  if (!partnerId) return;
  const count = (reports.get(partnerId) || 0) + 1;
  reports.set(partnerId, count);
  console.log(`🚨 User ${partnerId} reported. Count: ${count}`);

  // Auto-disconnect user after 3 reports in a short period
  if (count >= 3) {
    io.to(partnerId).emit("partner-left");
    io.sockets.sockets.get(partnerId)?.disconnect(true);
    console.log(`❌ User ${partnerId} auto-disconnected for abuse.`);
    reports.delete(partnerId);
  }
});

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);
    prefs.delete(socket.id);

    // Clean from all queues
    for (const arr of queues.values()) {
      const idx = arr.indexOf(socket.id);
      if (idx !== -1) arr.splice(idx, 1);
    }

    const gidx = globalQueue.indexOf(socket.id);
    if (gidx !== -1) globalQueue.splice(gidx, 1);

    socket.broadcast.emit("partner-left");
  });
});

// -------------------------------
// 🚀 Start Server
// -------------------------------
const PORT = 5050;
server.listen(PORT, () => {
  console.log(`✅ Let's C server running securely on http://localhost:${PORT}`);
});
