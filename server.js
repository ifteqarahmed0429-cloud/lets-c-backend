// ==========================================
// 🌍 Let's C – Secure Video Chat Backend
// ==========================================

import 'dotenv/config';
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pool } from "./config/db.js";  

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

// -------------------- DATABASE HELPERS --------------------

async function upsertUser(socketId, ip, country) {
  try {
    const [res] = await pool.execute(
      "INSERT INTO users (socket_id, ip, country) VALUES (?, ?, ?)",
      [socketId, ip, country || null]
    );
    return res.insertId; // returns the new user's ID
  } catch (err) {
    console.error("❌ upsertUser error:", err.message);
    return null;
  }
}

async function startSession(userAId, userBId) {
  try {
    const [res] = await pool.execute(
      "INSERT INTO sessions (user_a_id, user_b_id) VALUES (?, ?)",
      [userAId, userBId]
    );
    return res.insertId; // returns the new session ID
  } catch (err) {
    console.error("❌ startSession error:", err.message);
    return null;
  }
}

async function endSession(sessionId, who = 'system') {
  try {
    await pool.execute(
      "UPDATE sessions SET ended_at = NOW(), disconnected_by = ? WHERE id = ? AND ended_at IS NULL",
      [who, sessionId]
    );
  } catch (err) {
    console.error("❌ endSession error:", err.message);
  }
}

async function addReport(reporterUserId, reportedUserId, reason = null) {
  try {
    await pool.execute(
      "INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)",
      [reporterUserId, reportedUserId, reason]
    );

    const [[row]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM reports WHERE reported_id = ? AND created_at >= NOW() - INTERVAL 1 HOUR",
      [reportedUserId]
    );

    return row.cnt; // returns number of reports in last hour
  } catch (err) {
    console.error("❌ addReport error:", err.message);
    return 0;
  }
}

// ----------------------------------------------------------


// -------------------------------
// 🔗 Socket.io Events
// -------------------------------
io.on("connection", async (socket) => {
  console.log("⚡ User connected:", socket.id);

  // --- detect IP + country from the handshake ---
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  let country = "Unknown";

  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json();
    if (data && data.country_name) country = data.country_name;
  } catch {
    country = "Unknown";
  }

  // --- insert user into DB ---
  const userId = await upsertUser(socket.id, ip, country);
  console.log(`✅ User saved in DB [${userId}] from ${country}`);

  // --- when paired with someone ---
  socket.on("partner-found", async ({ partnerId }) => {
    const [partnerUser] = await pool.query("SELECT id FROM users WHERE socket_id = ?", [partnerId]);
    if (partnerUser[0]) {
      const sessionId = await startSession(userId, partnerUser[0].id);
      socket.data.sessionId = sessionId;
      console.log(`🎥 Session started #${sessionId}`);
    }
  });

  // --- when user leaves ---
  socket.on("disconnect", async () => {
    if (socket.data.sessionId) {
      await endSession(socket.data.sessionId, socket.id);
      console.log(`❌ Session ended #${socket.data.sessionId}`);
    }
    await pool.execute("DELETE FROM users WHERE socket_id = ?", [socket.id]);
  });

  // --- when user reports someone ---
  socket.on("report-user", async ({ partnerId, reason }) => {
    const [[partnerUser]] = await pool.query("SELECT id FROM users WHERE socket_id = ?", [partnerId]);
    if (!partnerUser) return;

    const count = await addReport(userId, partnerUser.id, reason);
    console.log(`⚠️ Report added by ${userId} on ${partnerUser.id} (Total recent: ${count})`);

    // optional auto-ban if too many reports in 1 hour
    if (count >= 3) {
      console.log(`🚫 Auto-banning user #${partnerUser.id} (3+ reports)`);
      // add custom ban logic here later
    }
  });
});

// -------------------------------
// 🚀 Start Server
// -------------------------------
const PORT = 5050;
server.listen(PORT, () => {
  console.log(`✅ Let's C server running securely on http://localhost:${PORT}`);
});
