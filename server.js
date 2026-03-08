require("dotenv").config({ quiet: true });
const { spawn } = require("child_process");
process.env.DEBUG_LOGS = "1";
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const mongoose = require("mongoose");
const fs = require("fs");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

console.log("🚀 بدء السيرفر...");

// ================ ثوابت وإعدادات عامة ================
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const blackmoonKey = process.env.BLACKMOON_KEY || null;
const MAX_PROFILES = 20;

const GIFT_MAX_BURST = parseInt(process.env.GIFT_MAX_BURST || "50", 10);
const PROCESSED_TTL_MS = 60 * 1000;
const LIKE_MAX_DELTA = 500;
const LIKE_THRESHOLD_WINDOW_MS = 2000;
const GIFT_STREAK_TTL_MS = 15 * 1000;

// ================ صورة افتراضية محلية (Data URI) ================
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='35'%20height='35'%20viewBox='0%200%2035%2035'%3E%3Crect%20width='35'%20height='35'%20fill='%234caf50'/%3E%3Ctext%20x='50%25'%20y='50%25'%20font-size='12'%20fill='%23ffffff'%20text-anchor='middle'%20dy='.3em'%3EGift%3C/text%3E%3C/svg%3E";

// ================ إعداد المجلدات الثابتة ================
const audioDir = path.join(__dirname, "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const imagesDir = path.join(__dirname, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

const videoDir = path.join(__dirname, "videos");
if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

// مجلد لتحميل العميل (اختياري)
const downloadsDir = path.join(__dirname, "public", "downloads");
if (!fs.existsSync(downloadsDir))
  fs.mkdirSync(downloadsDir, { recursive: true });

// ================ Middleware ================
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public", "tik_black")));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
      "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io; " +
      "connect-src 'self' " +
      "http://localhost:3000 ws://localhost:3000 " +
      "http://[::1]:3000 ws://[::1]:3000 " + // إضافة IPv6 localhost
      "https://gta5-tiktok-integration-production.up.railway.app " +
      "wss://gta5-tiktok-integration-production.up.railway.app " +
      "https://cdn.socket.io; " +
      "img-src 'self' data: https://via.placeholder.com https://ui-avatars.com https://*.tiktokcdn.com;",
  );
  next();
});

app.use(
  "/audio",
  express.static(audioDir, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".mp3") res.setHeader("Content-Type", "audio/mpeg");
      else if (ext === ".wav") res.setHeader("Content-Type", "audio/wav");
      else if (ext === ".ogg") res.setHeader("Content-Type", "audio/ogg");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  }),
);
app.use("/images", express.static(imagesDir));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/videos", express.static(videoDir));
// إضافة مجلد التحميلات
app.use("/downloads", express.static(downloadsDir));

app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.url}`);
  const oldSend = res.send;
  res.send = function (data) {
    console.log(`✅ ${req.method} ${req.url} - ${res.statusCode}`);
    return oldSend.call(this, data);
  };
  next();
});

// ================ MongoDB ================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ متصل بنجاح بـ MongoDB Atlas السحابية");
    seedAudio();
  })
  .catch((err) => console.error("❌ فشل الاتصال بـ Atlas:", err));

// ================ نماذج Mongoose ================

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    screenToken: {
      type: String,
      required: true,
      unique: true,
      default: () => require("crypto").randomBytes(16).toString("hex"),
    },
    tiktokUsername: { type: String, default: null },
    currentProfile: { type: Number, default: 1, min: 1, max: MAX_PROFILES },
  },
  { timestamps: true },
);
const UserModel = mongoose.model("User", UserSchema);

const GiftCommandSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    giftId: mongoose.Schema.Types.Mixed,
    name: { type: String, default: "" },
    webhookUrl: { type: String, default: "" },
    repeat: { type: Number, default: 1 },
    interval: { type: Number, default: 500 },
    delayBefore: { type: Number, default: 0 },
    audio: String,
    volume: { type: Number, default: 100 },
    video: String,
    screen: { type: Number, default: 1 },
    targetUser: { type: String, default: "all" },
    active: { type: Boolean, default: true },
    playSound: { type: Boolean, default: true },
    playVideo: { type: Boolean, default: true },
    oncePerLive: { type: Boolean, default: false },
    profile: { type: Number, default: 1, min: 1, max: MAX_PROFILES },
  },
  { timestamps: true },
);
const GiftCommandModel = mongoose.model("GiftCommand", GiftCommandSchema);

const InteractionCommandSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["follow", "like", "comment", "share", "gift", "all"],
      required: true,
    },
    name: { type: String, default: "" },
    webhookUrl: { type: String, default: "" },
    repeat: { type: Number, default: 1 },
    interval: { type: Number, default: 500 },
    delayBefore: { type: Number, default: 0 },
    audio: String,
    volume: { type: Number, default: 100 },
    video: String,
    screen: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
    playSound: { type: Boolean, default: true },
    playVideo: { type: Boolean, default: true },
    targetUser: { type: String, default: "all" },
    keyword: { type: String, default: "" },
    threshold: { type: Number, default: 0 },
    oncePerLive: { type: Boolean, default: false },
    profile: { type: Number, default: 1, min: 1, max: MAX_PROFILES },
  },
  { timestamps: true },
);
const InteractionCommandModel = mongoose.model(
  "InteractionCommand",
  InteractionCommandSchema,
);

const GiftSchema = new mongoose.Schema({
  id: Number,
  name: String,
  describe: String,
  diamond_count: Number,
  type: Number,
  source: Number,
  image: mongoose.Schema.Types.Mixed,
});
const GiftModel = mongoose.model("Gift", GiftSchema);

const AudioSchema = new mongoose.Schema({
  name: String,
  file: String,
});
const AudioModel = mongoose.model("Audio", AudioSchema);

// ================ دوال مساعدة ================

async function seedAudio() {
  try {
    const files = fs
      .readdirSync(audioDir)
      .filter(
        (f) => f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".ogg"),
      );
    for (let file of files) {
      await AudioModel.updateOne(
        { file },
        { name: file.replace(/\.(mp3|wav|ogg)$/i, ""), file },
        { upsert: true },
      );
    }
    console.log(`✅ ${files.length} audio files synced`);
  } catch (err) {
    console.error("❌ Error seeding audio:", err);
  }
}

function normalizeUser(u) {
  if (!u) return "unknown";
  return String(u).trim().toLowerCase();
}

function getSenderFromEvent(data) {
  if (!data) return "Unknown";
  const user = data.user || {};
  const candidates = [
    user.uniqueId,
    user.unique_id,
    user.username,
    user.nickName,
    user.nickname,
    user.displayName,
    user.userId,
    user.id,
    data.uniqueId,
    data.unique_id,
    data.username,
    data.userId,
    data.user_id,
    data.id,
    data.uid,
  ];
  for (let c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
    if (typeof c === "number") return String(c);
  }
  return "Unknown";
}

// ================ كاش لكل مستخدم ================
const userGiftCommandsCache = new Map();
const userInteractionCommandsCache = new Map();

async function refreshUserCaches(userId) {
  try {
    const giftMap = new Map();
    const gifts = await GiftCommandModel.find({ userId });
    for (const g of gifts) giftMap.set(String(g.giftId), g);
    userGiftCommandsCache.set(String(userId), giftMap);

    const interactions = await InteractionCommandModel.find({ userId });
    userInteractionCommandsCache.set(String(userId), interactions);

    console.log(`♻️ Caches refreshed for user ${userId}`);
  } catch (err) {
    console.error("❌ Error refreshing user caches:", err.message);
  }
}

function getGiftCommandForUser(userId, giftIdStrOrNum) {
  const userMap = userGiftCommandsCache.get(String(userId));
  if (!userMap) return null;
  const key = String(giftIdStrOrNum);
  if (userMap.has(key)) return userMap.get(key);
  const num = Number(giftIdStrOrNum);
  if (Number.isFinite(num) && userMap.has(String(num)))
    return userMap.get(String(num));
  return null;
}

function getInteractionCommandsForUser(userId) {
  return userInteractionCommandsCache.get(String(userId)) || [];
}

// ================ دوال تشغيل الصوت والفيديو والويب هوك ================

async function sendWebhook(webhookUrl, data) {
  try {
    if (!webhookUrl || !webhookUrl.trim()) return;
    console.log(`🌐 [WEBHOOK] Sending to: ${webhookUrl.substring(0, 50)}...`);

    const tryFetch = async (url) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "BlackMoon/1.0",
          },
          body: JSON.stringify(data),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    };

    try {
      const response = await tryFetch(webhookUrl);
      if (response.ok) console.log(`✅ [WEBHOOK] Success (${response.status})`);
      else console.warn(`⚠️ [WEBHOOK] Failed (${response.status})`);
    } catch (err) {
      // إذا كان الخطأ بسبب رفض الاتصال والرابط يشير إلى localhost، حاول باستخدام 127.0.0.1
      if (
        err.message.includes("ECONNREFUSED") &&
        webhookUrl.includes("localhost")
      ) {
        const ipv4Url = webhookUrl.replace("localhost", "127.0.0.1");
        console.log(
          `⚠️ فشل الاتصال بـ localhost (ربما IPv6). إعادة المحاولة باستخدام ${ipv4Url}`,
        );
        const response = await tryFetch(ipv4Url);
        if (response.ok)
          console.log(
            `✅ [WEBHOOK] Success (${response.status}) after retry with IPv4`,
          );
        else
          console.warn(`⚠️ [WEBHOOK] Failed (${response.status}) after retry`);
      } else {
        if (err.name === "AbortError") console.error("❌ [WEBHOOK] Timeout");
        else console.error("❌ [WEBHOOK] Error:", err.message);
      }
    }
  } catch (err) {
    console.error("❌ [WEBHOOK] Unexpected error:", err.message);
  }
}
// ================ دالة جديدة لإرسال الويب هوك عبر العميل المحلي ================
async function sendWebhookOrDesktop(
  userId,
  webhookUrl,
  data,
  repeat = 1,
  interval = 500,
  delayBefore = 0,
) {
  if (!webhookUrl) return;

  // التحقق مما إذا كان الرابط يشير إلى localhost (أي يحتاج إلى تنفيذ محلي)
  const isLocalhost =
    webhookUrl.includes("localhost") || webhookUrl.includes("127.0.0.1");

  if (isLocalhost) {
    const desktopRoom = `desktop:${userId}`;
    // التحقق من وجود عملاء متصلين في غرفة desktop
    const socketsInRoom = await io.in(desktopRoom).fetchSockets();
    if (socketsInRoom.length > 0) {
      io.to(desktopRoom).emit("webhook-request", {
        url: webhookUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        repeat: repeat,
        interval: interval,
        delayBefore: delayBefore,
      });
      console.log(`📦 [User ${userId}] Sent to desktop client: ${webhookUrl}`);
    } else {
      console.warn(
        `⚠️ [User ${userId}] No desktop client connected. Webhook not sent: ${webhookUrl}`,
      );
    }
  } else {
    // رابط خارجي عادي نرسله عبر HTTP
    await sendWebhook(webhookUrl, data);
  }
}

async function playAudio(userId, file, volume = 100) {
  try {
    const audioPath = path.join(audioDir, file);
    if (!fs.existsSync(audioPath)) {
      console.warn(`⚠️ Audio file not found: ${file}`);
      return;
    }
    io.to(String(userId)).emit("play-sound", {
      filename: file,
      volume: Math.min(100, Math.max(0, parseInt(volume) || 100)),
      timestamp: Date.now(),
    });
    console.log(`🔊 [User ${userId}] Emitted: ${file} (volume: ${volume}%)`);
  } catch (err) {
    console.error("❌ Audio error:", err.message);
  }
}

async function runCommandObject(userId, cmdObj, triggerUser = "Unknown") {
  try {
    if (!cmdObj || !cmdObj.webhookUrl) {
      console.log("⚠️ No webhook URL to execute");
      return;
    }

    const {
      webhookUrl,
      repeat = 1,
      interval = 500,
      delayBefore = 0,
      audio = null,
      volume = 100,
      video = null,
      screen = 1,
      active = true,
      name = "",
    } = cmdObj;

    if (!active) {
      console.log(
        `🚫 Webhook inactive: ${name || webhookUrl.substring(0, 30)}`,
      );
      return;
    }

    if (delayBefore > 0) {
      console.log(
        `⏳ Waiting ${delayBefore}ms before executing webhook: ${name || webhookUrl.substring(0, 30)}...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayBefore));
    }

    const webhookData = {
      name: name || "",
      user: triggerUser,
      type: cmdObj.type || "gift",
      timestamp: new Date().toISOString(),
      profile:
        cmdObj.profile ||
        (await UserModel.findById(userId))?.currentProfile ||
        1,
      event: "webhook_execution",
      repeat,
      interval,
    };

    // استبدال sendWebhook بـ sendWebhookOrDesktop
    for (let i = 0; i < repeat; i++) {
      if (i > 0 && interval > 0)
        await new Promise((resolve) => setTimeout(resolve, interval));
      await sendWebhookOrDesktop(userId, webhookUrl, webhookData, 1, 0, 0);
    }

    if (audio && cmdObj.playSound !== false) {
      playAudio(userId, audio, volume);
    }

    if (video && cmdObj.playVideo !== false) {
      console.log(`🎬 [User ${userId}] Sending video to screen: ${screen}`);
      io.to(String(userId)).emit("gift-video", {
        videoId: encodeURIComponent(video),
        user: triggerUser,
        screen,
        volume,
      });
    }

    console.log(
      `✅ Webhook executed: ${name || webhookUrl.substring(0, 30)}...`,
    );
  } catch (err) {
    console.error("❌ Error in runCommandObject:", err.message);
  }
}

// ================ إدارة اتصالات TikTok لكل مستخدم ================
const userTikTokConnections = new Map();

function resetUserLiveState(userState) {
  userState.executedOncePerLive = new Set();
  userState.likeCounters = {};
  userState.followExecutedUsers = new Set();
  userState.lastLikeCount = new Map();
  userState.giftStreakState = new Map();
}

async function setupTikTokConnection(userId, username) {
  if (userTikTokConnections.has(userId)) {
    try {
      userTikTokConnections.get(userId).connection.disconnect();
    } catch (e) {}
    userTikTokConnections.delete(userId);
  }

  const connection = new TikTokLiveConnection(username, {
    apiKey: blackmoonKey,
  });
  const userState = {
    connection,
    currentLiveStatus: false,
    currentRoomId: null,
    executedOncePerLive: new Set(),
    likeCounters: {},
    followExecutedUsers: new Set(),
    lastLikeCount: new Map(),
    giftStreakState: new Map(),
  };

  // GIFT
  connection.on(WebcastEvent.GIFT, async (data) => {
    try {
      const sender = normalizeUser(getSenderFromEvent(data));
      const giftIdStr = String(
        data.giftId ??
          data.gift_id ??
          data.giftDetails?.id ??
          data.id ??
          "unknown",
      );
      const repeatCount = Math.max(
        1,
        parseInt(
          String(
            data.repeatCount ??
              data.repeat_count ??
              data.repeat ??
              data.comboCount ??
              1,
          ),
          10,
        ) || 1,
      );
      const giftType = Number(
        data.giftType ?? data.gift_type ?? data.giftDetails?.giftType ?? 0,
      );
      const repeatEnd = !!(data.repeatEnd ?? data.repeat_end);

      const processDelta = async (delta, newRepeat) => {
        let giftCommand = getGiftCommandForUser(userId, giftIdStr);
        if (!giftCommand) {
          giftCommand = await GiftCommandModel.findOne({
            userId,
            giftId: giftIdStr,
          });
          if (giftCommand) {
            if (!userGiftCommandsCache.has(String(userId)))
              userGiftCommandsCache.set(String(userId), new Map());
            userGiftCommandsCache
              .get(String(userId))
              .set(String(giftCommand.giftId), giftCommand);
          }
        }

        if (giftCommand && giftCommand.webhookUrl) {
          const targetOk =
            !giftCommand.targetUser ||
            normalizeUser(giftCommand.targetUser) === "all" ||
            normalizeUser(giftCommand.targetUser) === sender;
          if (targetOk) {
            const cmdObj = { ...giftCommand.toObject() };
            const configuredRepeat = Math.max(
              1,
              parseInt(cmdObj.repeat || 1, 10) || 1,
            );
            // تعديل: إزالة الضرب في delta
            cmdObj.repeat = configuredRepeat;
            await runCommandObject(userId, cmdObj, sender);
          }
        }

        const giftInteractions = getInteractionCommandsForUser(userId).filter(
          (i) => i.type === "gift",
        );
        for (const ic of giftInteractions) {
          if (
            ic.targetUser &&
            normalizeUser(ic.targetUser) !== "all" &&
            normalizeUser(ic.targetUser) !== sender
          )
            continue;
          const threshold = parseInt(ic.threshold || 0, 10) || 0;
          if (threshold > 0) {
            const times = Math.floor(newRepeat / threshold);
            if (times > 0) {
              const icObj = { ...ic.toObject() };
              icObj.repeat = Math.max(1, (icObj.repeat || 1) * times);
              await runCommandObject(userId, icObj, sender);
            }
          } else {
            const icObj = { ...ic.toObject() };
            // تعديل: إزالة الضرب في delta
            icObj.repeat = Math.max(1, icObj.repeat || 1);
            await runCommandObject(userId, icObj, sender);
          }
        }
      };

      if (giftType === 1) {
        const streakKey =
          data.repeatId ??
          data.repeat_id ??
          data.comboId ??
          `${sender}:${giftIdStr}`;
        const now = Date.now();
        let st = userState.giftStreakState.get(streakKey) || {
          lastRepeat: 0,
          ts: now,
        };
        const prevRepeat = st.lastRepeat || 0;
        let delta = 0;
        if (repeatCount > prevRepeat) {
          delta = repeatCount - prevRepeat;
          st.lastRepeat = repeatCount;
          st.ts = now;
          userState.giftStreakState.set(streakKey, st);
        } else if (repeatCount < prevRepeat) {
          delta = repeatCount;
          st.lastRepeat = repeatCount;
          st.ts = now;
          userState.giftStreakState.set(streakKey, st);
        }
        if (repeatEnd) {
          if (delta > 0) await processDelta(delta, repeatCount);
          userState.giftStreakState.delete(streakKey);
          return;
        }
        if (delta <= 0) return;
        await processDelta(delta, repeatCount);
      } else {
        await processDelta(repeatCount, repeatCount);
      }
    } catch (err) {
      console.error(`❌ GIFT handler error for user ${userId}:`, err.message);
    }
  });

  // CHAT
  connection.on(WebcastEvent.CHAT, async (data) => {
    try {
      const sender = normalizeUser(getSenderFromEvent(data));
      const comment = (data.comment || "").toString();
      if (!comment) return;

      const commands = getInteractionCommandsForUser(userId).filter(
        (c) => c.type === "comment" && c.active,
      );
      for (let cmd of commands) {
        if (
          cmd.targetUser &&
          normalizeUser(cmd.targetUser) !== "all" &&
          normalizeUser(cmd.targetUser) !== sender
        )
          continue;
        if (cmd.keyword && cmd.keyword.trim().length > 0) {
          const kw = cmd.keyword.trim().toLowerCase();
          if (comment.toLowerCase().includes(kw)) {
            await runCommandObject(userId, cmd, sender);
          }
        } else {
          await runCommandObject(userId, cmd, sender);
        }
      }
    } catch (err) {
      console.error(`❌ CHAT handler error for user ${userId}:`, err.message);
    }
  });

  // FOLLOW
  connection.on(WebcastEvent.FOLLOW, async (data) => {
    try {
      const sender = normalizeUser(getSenderFromEvent(data));
      const commands = getInteractionCommandsForUser(userId).filter(
        (c) => c.type === "follow" && c.active,
      );
      for (let cmd of commands) {
        if (
          cmd.targetUser &&
          normalizeUser(cmd.targetUser) !== "all" &&
          normalizeUser(cmd.targetUser) !== sender
        )
          continue;
        if (cmd.oncePerLive) {
          const key = `follow:${String(cmd._id)}:${sender}`;
          if (userState.followExecutedUsers.has(key)) continue;
          await runCommandObject(userId, cmd, sender);
          userState.followExecutedUsers.add(key);
        } else {
          await runCommandObject(userId, cmd, sender);
        }
      }
    } catch (err) {
      console.error(`❌ FOLLOW handler error for user ${userId}:`, err.message);
    }
  });

  // LIKE
  connection.on(WebcastEvent.LIKE, async (data) => {
    try {
      const sender = normalizeUser(getSenderFromEvent(data));
      let delta =
        parseInt(
          String(data.likeCount ?? data.like_count ?? data.count ?? 1).replace(
            /\D/g,
            "",
          ),
          10,
        ) || 1;
      if (delta > LIKE_MAX_DELTA) delta = LIKE_MAX_DELTA;
      if (delta <= 0) return;

      const commands = getInteractionCommandsForUser(userId).filter(
        (c) => c.type === "like" && c.active,
      );
      for (let cmd of commands) {
        if (
          cmd.targetUser &&
          normalizeUser(cmd.targetUser) !== "all" &&
          normalizeUser(cmd.targetUser) !== sender
        )
          continue;
        const threshold = parseInt(cmd.threshold || 0, 10) || 0;
        const keyUser = `${String(cmd._id)}:${sender}`;
        userState.likeCounters[keyUser] =
          (userState.likeCounters[keyUser] || 0) + delta;

        if (threshold <= 0) {
          await runCommandObject(userId, cmd, sender);
          continue;
        }

        const times = Math.floor(userState.likeCounters[keyUser] / threshold);
        if (times <= 0) continue;

        const cmdObj = { ...cmd.toObject() };
        cmdObj.repeat = Math.max(1, (cmdObj.repeat || 1) * times);
        await runCommandObject(userId, cmdObj, sender);

        userState.likeCounters[keyUser] =
          userState.likeCounters[keyUser] - times * threshold;
        if (userState.likeCounters[keyUser] < 0)
          userState.likeCounters[keyUser] = 0;
      }
    } catch (err) {
      console.error(`❌ LIKE handler error for user ${userId}:`, err.message);
    }
  });

  // SHARE
  connection.on(WebcastEvent.SHARE, async (data) => {
    try {
      const sender = normalizeUser(getSenderFromEvent(data));
      const commands = getInteractionCommandsForUser(userId).filter(
        (c) => c.type === "share" && c.active,
      );
      for (let cmd of commands) {
        if (
          cmd.targetUser &&
          normalizeUser(cmd.targetUser) !== "all" &&
          normalizeUser(cmd.targetUser) !== sender
        )
          continue;
        await runCommandObject(userId, cmd, sender);
      }
    } catch (err) {
      console.error(`❌ SHARE handler error for user ${userId}:`, err.message);
    }
  });

  // ROOM UPDATE
  connection.on(WebcastEvent.ROOM_UPDATE, (data) => {
    const prev = userState.currentLiveStatus;
    const newRoomId = data?.roomId ?? data?.room_id ?? null;
    const newIsLive =
      typeof data?.isLive === "boolean" ? data.isLive : !!newRoomId;

    if (!prev && newIsLive) {
      resetUserLiveState(userState);
      console.log(`🟢 [User ${userId}] Live started`);
    }
    if (prev && !newIsLive) {
      resetUserLiveState(userState);
      console.log(`🔴 [User ${userId}] Live ended`);
    }

    userState.currentLiveStatus = newIsLive;
    userState.currentRoomId = newIsLive ? newRoomId : null;
  });

  // DISCONNECTED / ERROR
  connection.on(WebcastEvent.DISCONNECTED, () => {
    userState.currentLiveStatus = false;
    userState.currentRoomId = null;
    userTikTokConnections.delete(userId);
    console.log(`⚠️ [User ${userId}] Disconnected from TikTok`);
  });

  connection.on(WebcastEvent.ERROR, (err) => {
    if (err && err.message && err.message.includes("illegal tag")) {
      console.warn(`⚠️ [User ${userId}] Webcast message ignored`);
      return;
    }
    console.error(`❌ [User ${userId}] TikTok connection error:`, err.message);
    userState.currentLiveStatus = false;
    userState.currentRoomId = null;
    userTikTokConnections.delete(userId);
  });

  try {
    await connection.connect();
    console.log(`✅ [User ${userId}] Connected to @${username}`);
    userState.currentLiveStatus = true;
    resetUserLiveState(userState);
  } catch (err) {
    console.log(`⚠️ [User ${userId}] @${username} is not live`);
    userState.currentLiveStatus = false;
  }

  userTikTokConnections.set(userId, userState);
  return userState;
}

// ================ Middleware للمصادقة ================
async function authenticateToken(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(" ")[1];
  if (!token)
    return res.status(401).json({ success: false, message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await UserModel.findById(decoded.id);
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "User not found" });
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: "Invalid token" });
  }
}

// ================ مسارات المصادقة ================
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res
        .status(400)
        .json({ success: false, message: "Username and password required" });
    const existing = await UserModel.findOne({ username });
    if (existing)
      return res
        .status(400)
        .json({ success: false, message: "Username already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const screenToken = require("crypto").randomBytes(16).toString("hex");
    const user = await UserModel.create({
      username,
      password: hashedPassword,
      screenToken,
    });
    const token = jwt.sign(
      { id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.cookie("token", token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "strict",
    });
    res.json({
      success: true,
      user: { username: user.username, screenToken: user.screenToken },
    });
  } catch (err) {
    console.error("❌ Registration error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res
        .status(400)
        .json({ success: false, message: "Username and password required" });
    const user = await UserModel.findOne({ username });
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    const token = jwt.sign(
      { id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.cookie("token", token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "strict",
    });
    res.json({
      success: true,
      user: { username: user.username, screenToken: user.screenToken },
    });
  } catch (err) {
    console.error("❌ Login error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/api/me", authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: {
      username: req.user.username,
      screenToken: req.user.screenToken,
      tiktokUsername: req.user.tiktokUsername,
      currentProfile: req.user.currentProfile,
    },
  });
});

// إضافة مسار جديد في السيرفر لتسجيل الدخول للعميل
app.get("/desktop-auth", (req, res) => {
  // يمكن أن نعرض صفحة تسجيل دخول بسيطة
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Desktop Client Authentication</title>
  </head>
  <body>
    <h2>تسجيل الدخول لتطبيق سطح المكتب</h2>
    <form action="/desktop-login" method="POST">
      <input type="text" name="username" placeholder="اسم المستخدم" required /><br/>
      <input type="password" name="password" placeholder="كلمة المرور" required /><br/>
      <button type="submit">دخول</button>
    </form>
  </body>
  </html>
  `;
  res.send(html);
});

app.post(
  "/desktop-login",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await UserModel.findOne({ username });
      if (!user) {
        return res.status(401).send("بيانات غير صحيحة");
      }
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).send("بيانات غير صحيحة");
      }
      // إعادة التوجيه إلى العميل المحلي مع التوكن
      // استخدام عنوان الخادم المحلي (افتراضياً localhost:3001)
      const redirectUrl = `http://localhost:3001/callback?token=${user.screenToken}`;
      res.redirect(redirectUrl);
    } catch (err) {
      console.error(err);
      res.status(500).send("خطأ داخلي");
    }
  },
);

// ================ مسارات TikTok username ================
app.post("/api/tiktok-user", authenticateToken, async (req, res) => {
  const { username } = req.body;
  if (!username)
    return res
      .status(400)
      .json({ success: false, message: "Username required" });
  req.user.tiktokUsername = username;
  await req.user.save();
  await setupTikTokConnection(req.user._id, username);
  res.json({ success: true });
});

app.get("/api/live-status", authenticateToken, (req, res) => {
  const conn = userTikTokConnections.get(String(req.user._id));
  res.json({
    username: req.user.tiktokUsername,
    isLive: conn ? conn.currentLiveStatus : false,
    profile: req.user.currentProfile,
  });
});

// ================ مسارات Profiles ================
app.get("/api/profiles", authenticateToken, (req, res) => {
  const list = [];
  for (let i = 1; i <= MAX_PROFILES; i++) {
    list.push({
      id: i,
      name: `Profile ${i}`,
      active: i === Number(req.user.currentProfile),
    });
  }
  res.json({ success: true, profiles: list });
});

app.post("/api/profile/select", authenticateToken, async (req, res) => {
  try {
    const p = parseInt(req.body.profile, 10);
    if (!p || p < 1 || p > MAX_PROFILES)
      return res.status(400).json({
        success: false,
        message: `Profile must be 1..${MAX_PROFILES}`,
      });
    req.user.currentProfile = p;
    await req.user.save();
    console.log(`🎛️ User ${req.user.username} switched to profile ${p}`);
    await refreshUserCaches(req.user._id);
    res.json({ success: true, profile: p });
  } catch (err) {
    console.error("❌ Profile select error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================ مسارات GiftCommands ================
app.get("/api/gift-commands", authenticateToken, async (req, res) => {
  try {
    const p = req.query.profile
      ? Math.max(
          1,
          Math.min(MAX_PROFILES, parseInt(req.query.profile, 10) || 1),
        )
      : req.user.currentProfile;
    const gifts = await GiftCommandModel.find({
      userId: req.user._id,
      $or: [{ profile: p }, { profile: { $exists: false } }],
    }).sort({ createdAt: -1 });
    res.json({ success: true, gifts });
  } catch (err) {
    console.error("❌ Error fetching gift webhooks:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/gift-commands/:id", authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid ID" });
    const gift = await GiftCommandModel.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!gift)
      return res
        .status(404)
        .json({ success: false, message: "Webhook not found" });
    res.json({ success: true, gift });
  } catch (err) {
    console.error("❌ Error fetching gift webhook:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/gift-commands", authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const profile = Math.max(
      1,
      Math.min(
        MAX_PROFILES,
        parseInt(body.profile || req.user.currentProfile, 10) ||
          req.user.currentProfile,
      ),
    );

    if (!body.giftId && body.giftId !== 0)
      return res
        .status(400)
        .json({ success: false, message: "giftId is required" });
    const giftIdToSave = String(body.giftId).trim();

    const exists = await GiftCommandModel.findOne({
      userId: req.user._id,
      giftId: giftIdToSave,
      profile,
    });
    if (exists)
      return res.status(400).json({
        success: false,
        message: "This gift already has a webhook in this profile",
      });

    if (!body.webhookUrl || !body.webhookUrl.trim())
      return res
        .status(400)
        .json({ success: false, message: "Webhook URL is required" });

    const newGift = await GiftCommandModel.create({
      userId: req.user._id,
      giftId: giftIdToSave,
      name: body.name || `Gift ${giftIdToSave}`,
      webhookUrl: body.webhookUrl.trim(),
      repeat: parseInt(body.repeat || 1, 10) || 1,
      interval: parseInt(body.interval || 500, 10) || 500,
      delayBefore: parseInt(body.delayBefore || 0, 10) || 0,
      audio: body.audio || null,
      volume: parseInt(body.volume || 100, 10) || 100,
      video: body.video || null,
      screen: parseInt(body.screen || 1, 10) || 1,
      targetUser: body.targetUser || "all",
      active: body.active !== false,
      playSound: body.playSound !== false,
      playVideo: body.playVideo !== false,
      oncePerLive: !!body.oncePerLive,
      profile,
    });

    await refreshUserCaches(req.user._id);
    res.json({ success: true, gift: newGift });
  } catch (err) {
    console.error("❌ Error creating gift webhook:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put("/api/gift-commands/:id", authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid ID format" });
    const gift = await GiftCommandModel.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!gift)
      return res
        .status(404)
        .json({ success: false, message: "Webhook not found" });
    Object.assign(gift, req.body);
    await gift.save();
    await refreshUserCaches(req.user._id);
    res.json({ success: true, gift });
  } catch (err) {
    console.error("❌ Error updating gift webhook:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/gift-commands/:id", authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid ID" });
    await GiftCommandModel.deleteOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    await refreshUserCaches(req.user._id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error deleting gift webhook:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(
  "/api/gift-commands/:id/execute",
  authenticateToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ success: false, message: "Invalid ID" });
      const gift = await GiftCommandModel.findOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      if (!gift)
        return res
          .status(404)
          .json({ success: false, message: "Webhook not found" });

      const count = Math.max(1, parseInt(req.body?.count || 1, 10) || 1);
      const timesToRun = Math.min(count, 10);
      const requestedScreen = req.body?.screen
        ? parseInt(req.body.screen)
        : null;

      const cmdObj = gift.toObject ? { ...gift.toObject() } : { ...gift };
      const configuredRepeat = Math.max(
        1,
        parseInt(cmdObj.repeat || 1, 10) || 1,
      );

      for (let t = 0; t < timesToRun; t++) {
        const one = {
          ...cmdObj,
          repeat: configuredRepeat,
          screen: requestedScreen || cmdObj.screen || 1,
        };
        await runCommandObject(req.user._id, one, "ManualTest");
      }

      res.json({
        success: true,
        message: "Webhook executed",
        count: timesToRun,
        webhookUrl: gift.webhookUrl,
        screen: requestedScreen || cmdObj.screen,
      });
    } catch (err) {
      console.error("❌ Error executing webhook:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ================ مسارات InteractionCommands ================
app.get("/api/interaction-commands", authenticateToken, async (req, res) => {
  try {
    const p = req.query.profile
      ? Math.max(
          1,
          Math.min(MAX_PROFILES, parseInt(req.query.profile, 10) || 1),
        )
      : req.user.currentProfile;
    const list = await InteractionCommandModel.find({
      userId: req.user._id,
      $or: [{ profile: p }, { profile: { $exists: false } }],
    }).sort({ createdAt: -1 });
    res.json({ success: true, list });
  } catch (err) {
    console.error("❌ Error fetching interaction webhooks:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(
  "/api/interaction-commands/:id",
  authenticateToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ success: false, message: "Invalid ID" });
      const cmd = await InteractionCommandModel.findOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      if (!cmd)
        return res
          .status(404)
          .json({ success: false, message: "Webhook not found" });
      res.json({ success: true, command: cmd });
    } catch (err) {
      console.error("❌ Error fetching interaction webhook:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

app.post("/api/interaction-commands", authenticateToken, async (req, res) => {
  try {
    const payload = { ...(req.body || {}) };
    const profile = Math.max(
      1,
      Math.min(
        MAX_PROFILES,
        parseInt(payload.profile || req.user.currentProfile, 10) ||
          req.user.currentProfile,
      ),
    );

    if (!payload.type)
      return res.status(400).json({
        success: false,
        message: "Type is required (follow, like, comment, share, gift)",
      });
    payload.type = String(payload.type).trim().toLowerCase();
    const allowed = ["follow", "like", "comment", "share", "gift", "all"];
    if (!allowed.includes(payload.type))
      return res.status(400).json({
        success: false,
        message: `Invalid type. Allowed: ${allowed.join(", ")}`,
      });

    if (!payload.webhookUrl || !payload.webhookUrl.trim())
      return res
        .status(400)
        .json({ success: false, message: "Webhook URL is required" });

    payload.userId = req.user._id;
    payload.profile = profile;
    payload.webhookUrl = payload.webhookUrl.trim();
    payload.repeat = parseInt(payload.repeat || 1, 10) || 1;
    payload.interval = parseInt(payload.interval || 500, 10) || 500;
    payload.delayBefore = parseInt(payload.delayBefore || 0, 10) || 0;
    payload.threshold = parseInt(payload.threshold || 0, 10) || 0;
    payload.volume = parseInt(payload.volume || 100, 10) || 100;
    payload.screen = parseInt(payload.screen || 1, 10) || 1;
    payload.active = payload.active !== false;
    payload.playSound = payload.playSound !== false;
    payload.playVideo = payload.playVideo !== false;
    payload.oncePerLive = !!payload.oncePerLive;

    const created = await InteractionCommandModel.create(payload);
    await refreshUserCaches(req.user._id);
    res.json({ success: true, command: created });
  } catch (err) {
    console.error("❌ Error creating interaction webhook:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put(
  "/api/interaction-commands/:id",
  authenticateToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res
          .status(400)
          .json({ success: false, message: "Invalid ID format" });
      const cmd = await InteractionCommandModel.findOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      if (!cmd)
        return res
          .status(404)
          .json({ success: false, message: "Webhook not found" });
      Object.assign(cmd, req.body);
      await cmd.save();
      await refreshUserCaches(req.user._id);
      res.json({ success: true, command: cmd });
    } catch (err) {
      console.error("❌ Error updating interaction webhook:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

app.delete(
  "/api/interaction-commands/:id",
  authenticateToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ success: false, message: "Invalid ID" });
      await InteractionCommandModel.deleteOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      await refreshUserCaches(req.user._id);
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Error deleting interaction webhook:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

app.post(
  "/api/interaction-commands/:id/execute",
  authenticateToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ success: false, message: "Invalid ID" });
      const cmd = await InteractionCommandModel.findOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      if (!cmd)
        return res
          .status(404)
          .json({ success: false, message: "Webhook not found" });

      const count = Math.max(1, parseInt(req.body?.count || 1, 10) || 1);
      const timesToRun = Math.min(count, 10);
      const requestedScreen = req.body?.screen
        ? parseInt(req.body.screen)
        : null;

      const cmdObj = cmd.toObject ? { ...cmd.toObject() } : { ...cmd };
      const configuredRepeat = Math.max(
        1,
        parseInt(cmdObj.repeat || 1, 10) || 1,
      );

      for (let t = 0; t < timesToRun; t++) {
        const one = {
          ...cmdObj,
          repeat: configuredRepeat,
          screen: requestedScreen || cmdObj.screen || 1,
        };
        await runCommandObject(req.user._id, one, "ManualTest");
      }

      res.json({
        success: true,
        message: "Webhook executed",
        count: timesToRun,
        webhookUrl: cmd.webhookUrl,
        screen: requestedScreen || cmdObj.screen,
      });
    } catch (err) {
      console.error("❌ Error executing webhook:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ================ مسارات الهدايا والصوت والفيديو العامة ================
app.get("/api/gifts", async (req, res) => {
  try {
    let gifts = await GiftModel.find().sort({ diamond_count: 1 });
    gifts = gifts.map((g) => {
      const gift = g.toObject();
      if (!gift.image) gift.image = { url_list: [] };
      if (!gift.image.url_list || gift.image.url_list.length === 0) {
        gift.image = { url_list: [PLACEHOLDER_IMAGE] };
      }
      return gift;
    });
    res.json({ success: true, gifts });
  } catch (err) {
    console.error("❌ Error fetching gifts:", err.message);
    res.status(500).json({ success: false, gifts: [] });
  }
});

app.get("/api/audio", async (req, res) => {
  try {
    const audios = await AudioModel.find().sort({ name: 1 });
    res.json({ success: true, audios });
  } catch (err) {
    console.error("❌ Error fetching audio:", err.message);
    res.status(500).json({ success: false, audios: [] });
  }
});

app.post("/api/play-sound", authenticateToken, (req, res) => {
  const { filename, volume = 100 } = req.body || {};
  if (!filename)
    return res
      .status(400)
      .json({ success: false, message: "filename required" });
  playAudio(req.user._id, filename, volume);
  res.json({ success: true });
});

app.post("/api/test-webhook", async (req, res) => {
  try {
    const { url, payload } = req.body;
    function isValidUrl(u) {
      if (!u || u.trim() === "") return false;
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    }
    if (!url || !isValidUrl(url))
      return res
        .status(400)
        .json({ success: false, message: "Invalid webhook URL" });

    const testData = payload || {
      test: true,
      timestamp: new Date().toISOString(),
      message: "Test webhook from Black Moon",
      source: "blackmoon_tester",
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "BlackMoon/1.0",
      },
      body: JSON.stringify(testData),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const responseText = await response.text();
    res.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      response: responseText.substring(0, 500),
      url,
    });
  } catch (err) {
    console.error("❌ Test webhook error:", err.message);
    res
      .status(500)
      .json({ success: false, message: err.message, type: err.name });
  }
});

app.post("/api/reset-live-state", authenticateToken, (req, res) => {
  const conn = userTikTokConnections.get(String(req.user._id));
  if (conn) resetUserLiveState(conn);
  res.json({ success: true });
});

// رفع فيديو
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videoDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/\s+/g, "-");
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});
const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 1000 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(mp4|mov|webm|mkv)$/i;
    const ext = path.extname(file.originalname).toLowerCase();
    allowedTypes.test(ext)
      ? cb(null, true)
      : cb(new Error("Only video files are allowed"));
  },
});

app.post(
  "/api/upload-video",
  authenticateToken,
  uploadVideo.single("video"),
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "No file uploaded" });
      const { giftId, screen = 1 } = req.body;
      const filename = req.file.filename;

      if (giftId) {
        const gift = await GiftCommandModel.findOne({
          userId: req.user._id,
          giftId,
        });
        if (gift) {
          gift.video = filename;
          gift.screen = parseInt(screen, 10) || 1;
          await gift.save();
        }
      }

      res.json({
        success: true,
        filename,
        message: "Video uploaded successfully",
      });
    } catch (err) {
      console.error("❌ Video upload error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ================ مسارات الشاشات ================

// صفحة قائمة الشاشات
app.get("/screens", authenticateToken, (req, res) => {
  const token = req.user.screenToken;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const screens = [];

  for (let i = 1; i <= 10; i++) {
    screens.push({ number: i, url: `${baseUrl}/screens/${token}/${i}.html` });
  }

  const html = `<!DOCTYPE html>
<html lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io; connect-src 'self' http://localhost:3000 ws://localhost:3000 http://[::1]:3000 ws://[::1]:3000 https://cdn.socket.io; img-src 'self' data: https://via.placeholder.com https://ui-avatars.com;">
  <title>Black Moon - OBS Screens</title>
  <style>
    body { font-family: 'Open Sans', sans-serif; background: #0a0a0a; color: #fff; margin: 0; padding: 30px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #4caf50; margin-bottom: 10px; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .screens-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    .screen-card { background: #1a1a1a; border-radius: 12px; padding: 20px; border: 1px solid #333; }
    .screen-card:hover { border-color: #4caf50; }
    .screen-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; }
    .screen-number { background: #4caf50; color: white; width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 20px; }
    .url-box { background: #0a0a0a; padding: 12px; border-radius: 6px; border: 1px solid #333; word-break: break-all; color: #4caf50; font-size: 13px; }
    .copy-btn { background: #333; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: 0.2s; }
    .copy-btn:hover { background: #4caf50; }
    .instructions { background: #1e3a2e; padding: 20px; border-radius: 8px; margin-top: 30px; border-left: 4px solid #4caf50; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 Black Moon - OBS Screens</h1>
    <div class="subtitle">10 Screens Ready - Click copy to get URL</div>
    
    <div class="screens-grid">
      ${screens
        .map(
          (screen) => `
        <div class="screen-card">
          <div class="screen-header">
            <div class="screen-number">${screen.number}</div>
            <button class="copy-btn" onclick="copyUrl('${screen.url}')">📋 Copy URL</button>
          </div>
          <div class="url-box">${screen.url}</div>
          <div style="margin-top: 10px; color: #888;">🎯 Screen ${screen.number} - Receives videos only for this screen</div>
        </div>
      `,
        )
        .join("")}
    </div>

    <div class="instructions">
      <h3>📌 How to add to OBS:</h3>
      <ol style="color: #ddd; line-height: 1.8;">
        <li>1. Add new <strong>Browser Source</strong> in OBS</li>
        <li>2. Paste the screen URL (e.g., http://localhost:3000/screens/TOKEN/1.html)</li>
        <li>3. Set width: <strong>1920</strong>, height: <strong>1080</strong></li>
        <li>4. Check ✅ "Use custom frame rate" = 60fps</li>
        <li>5. The screen is transparent, video will play automatically</li>
      </ol>
    </div>
  </div>

  <script>
    function copyUrl(url) {
      navigator.clipboard.writeText(url).then(() => {
        const btn = event.currentTarget;
        btn.textContent = '✅ Copied!';
        btn.style.background = '#4caf50';
        setTimeout(() => {
          btn.textContent = '📋 Copy URL';
          btn.style.background = '#333';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
  res.send(html);
});

// عرض شاشة محددة
app.get("/screens/:token/:screenNumber", async (req, res) => {
  try {
    const { token, screenNumber } = req.params;
    const screenNum = parseInt(screenNumber.replace(".html", ""), 10);
    if (isNaN(screenNum) || screenNum < 1 || screenNum > 10)
      return res.status(404).send("Screen not found");

    const user = await UserModel.findOne({ screenToken: token });
    if (!user) return res.status(404).send("Invalid screen token");

    const html = `<!DOCTYPE html>
<html lang="ar">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io; connect-src 'self' http://localhost:3000 ws://localhost:3000 http://[::1]:3000 ws://[::1]:3000 https://cdn.socket.io; img-src 'self' data: https://via.placeholder.com https://ui-avatars.com;">
  <title>Screen ${screenNum} - ${user.username}</title>
  <style>
    html,body{ margin:0;padding:0;width:100%;height:100%; background:transparent; overflow:hidden; }
    video{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:transparent; display:none; }
  </style>
</head>
<body>
  <video id="videoPlayer" autoplay playsinline></video>
  <script src="https://cdn.socket.io/4.7.1/socket.io.min.js"></script>
  <script>
  (function(){
    const SCREEN_NUMBER = ${screenNum};
    const USER_TOKEN = '${token}';
    console.log('🎬 Screen ' + SCREEN_NUMBER + ' loaded for user ' + USER_TOKEN);
    
    // استخدام نفس origin الذي تم تحميل الصفحة منه لإنشاء اتصال Socket.IO
    const socket = io(window.location.origin, { 
      query: { token: USER_TOKEN },
      transports: ['websocket', 'polling']
    });
    const AUDIO_BASE = "/audio/";
    const VIDEO_BASE = "/videos/";

    const MAX_POOL = 8;
    const audioPool = [];
    let poolIndex = 0;
    let audioUnlocked = false;

    function getAudioElement(){
      while(audioPool.length < MAX_POOL){
        const a = new Audio();
        a.preload = 'auto';
        a.crossOrigin = 'anonymous';
        a.onended = () => {};
        audioPool.push(a);
      }
      return audioPool[(poolIndex++) % audioPool.length];
    }

    async function tryUnlockAudio(){
      if(audioUnlocked) return true;
      try {
        if (typeof AudioContext !== 'undefined') {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          g.gain.value = 0;
          o.connect(g); g.connect(ctx.destination);
          o.start(0);
          setTimeout(()=>{ try{ o.stop(); ctx.close(); }catch(e){} }, 50);
        } else {
          const a = getAudioElement();
          a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
          a.volume = 0;
          await a.play().catch(()=>{});
          a.pause();
        }
        audioUnlocked = true;
        return true;
      } catch (e) {
        console.warn('audio unlock failed', e);
        return false;
      }
    }

    window.addEventListener('load', ()=>{ tryUnlockAudio(); });

    socket.on('play-sound', async (payload) => {
      try {
        if (!payload || !payload.filename) return;
        if (!audioUnlocked) await tryUnlockAudio();
        const filename = payload.filename;
        const vol100 = typeof payload.volume !== 'undefined' ? Number(payload.volume) : 100;
        const vol = Math.min(100, Math.max(0, vol100)) / 100;
        const a = getAudioElement();
        a.src = AUDIO_BASE + encodeURIComponent(filename);
        a.volume = vol;
        a.currentTime = 0;
        a.play().catch(err => console.warn('audio play blocked', err));
      } catch (err) {
        console.error('play-sound handler error', err);
      }
    });

    const video = document.getElementById('videoPlayer');
    const videoQueue = [];
    let isPlaying = false;
    
    function playNextVideo(){
      if (isPlaying || videoQueue.length === 0) return;
      const src = videoQueue.shift();
      isPlaying = true;
      video.src = src;
      video.style.display = 'block';
      video.muted = false;
      video.play().catch(e => console.warn('video autoplay blocked', e));
      video.onended = () => {
        isPlaying = false;
        video.style.display = 'none';
        video.src = '';
        playNextVideo();
      };
    }

    socket.on('gift-video', (data) => {
      try {
        if (data.screen !== SCREEN_NUMBER) return;
        const vidName = decodeURIComponent(data.videoId || '');
        console.log('🎬 Screen ' + SCREEN_NUMBER + ' playing:', vidName);
        videoQueue.push(VIDEO_BASE + encodeURIComponent(vidName));
        playNextVideo();
      } catch (err) {
        console.error('gift-video handler error', err);
      }
    });

    socket.on('connect_error', (err) => console.warn('socket connect_error', err));
    socket.on('connect', () => console.log('✅ Socket connected'));
  })();
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error("❌ Error serving screen:", err.message);
    res.status(500).send("Internal server error");
  }
});

// ================ مسار لجلب رمز الربط للعميل المحلي ================
app.get("/api/client-token", authenticateToken, (req, res) => {
  res.json({ success: true, token: req.user.screenToken });
});

// ================ Socket.IO مع مصادقة ================
io.use(async (socket, next) => {
  const token = socket.handshake.query.token;
  if (!token) return next(new Error("Authentication error: token missing"));
  try {
    const user = await UserModel.findOne({ screenToken: token });
    if (!user) return next(new Error("Authentication error: invalid token"));
    socket.userId = String(user._id);
    next();
  } catch (err) {
    next(new Error("Authentication error: " + err.message));
  }
}).on("connection", (socket) => {
  console.log(
    `📱 Socket.IO client connected: ${socket.id} for user ${socket.userId}`,
  );
  socket.join(socket.userId);

  // استماع لتسجيل العميل المحلي (desktop client)
  socket.on("register", (data) => {
    if (data && data.type === "desktop") {
      socket.join(`desktop:${socket.userId}`);
      console.log(`💻 Desktop client registered for user ${socket.userId}`);
    }
  });

  socket.on("disconnect", () => {
    console.log(`📱 Socket.IO client disconnected: ${socket.id}`);
    socket.leave(socket.userId);
    // يمكن إزالة العميل من غرفة desktop تلقائيًا عند قطع الاتصال
  });
});

// ================ مسارات عامة ================
app.get("/api/test-connection", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    timestamp: new Date().toISOString(),
    features: {
      audio: fs.existsSync(audioDir),
      mongodb: mongoose.connection.readyState === 1,
    },
  });
});

app.get("/api/audio-files", (req, res) => {
  try {
    const files = fs
      .readdirSync(audioDir)
      .filter(
        (f) => f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".ogg"),
      )
      .map((f) => ({
        name: f,
        path: `/audio/${f}`,
        size: fs.statSync(path.join(audioDir, f)).size,
      }));
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================ بدء التشغيل ================
mongoose.connection.once("open", async () => {
  try {
    await seedAudio();
    const users = await UserModel.find({ tiktokUsername: { $ne: null } });
    for (const user of users) {
      await refreshUserCaches(user._id);
      if (user.tiktokUsername) {
        setupTikTokConnection(user._id, user.tiktokUsername).catch((err) => {
          console.error(
            `Failed to connect TikTok for user ${user.username}:`,
            err.message,
          );
        });
      }
    }
    console.log("✅ MongoDB ready, connections restored");
  } catch (err) {
    console.error("❌ Error starting services:", err.message);
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "tik_black", "index.html"));
});

server.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل الآن على المنفذ: ${PORT} (IPv4 & IPv6)`);
});
