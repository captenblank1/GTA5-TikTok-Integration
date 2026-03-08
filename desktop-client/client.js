const { io } = require("socket.io-client");
const fetch = require("node-fetch");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// إعدادات
const SERVER_URL =
  process.env.SERVER_URL ||
  "https://gta5-tiktok-integration-production.up.railway.app"; // غيّر لرابط السيرفر
const LOCAL_PORT = 3001; // منفذ الاستماع المحلي لاستقبال التوكن
const CONFIG_PATH = path.join(
  process.env.APPDATA || process.env.HOME || __dirname,
  "blackmoon-client",
  "config.json",
);

let socket = null;
let localServer = null;

// دالة لفتح المتصفح بدون مكتبة خارجية
function openBrowser(url) {
  const platform = process.platform;
  let command;
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, (error) => {
    if (error) {
      console.error("فشل فتح المتصفح:", error.message);
      console.log("يرجى فتح الرابط يدويًا:", url);
    }
  });
}

// دالة قراءة وحفظ الإعدادات
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("خطأ في قراءة ملف الإعدادات:", err.message);
  }
  return { token: null };
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("خطأ في حفظ الإعدادات:", err.message);
  }
}

// دالة بدء خادم محلي لاستقبال التوكن
function startLocalServer(callback) {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname === "/callback" && parsedUrl.query.token) {
      const token = parsedUrl.query.token;
      console.log("تم استقبال التوكن:", token);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
        <head><title>تم</title></head>
        <body>
          <h2>تم تسجيل الدخول بنجاح! يمكنك إغلاق هذه الصفحة.</h2>
        </body>
        </html>
      `);
      setTimeout(() => {
        server.close();
        callback(null, token);
      }, 1000);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(LOCAL_PORT, () => {
    console.log(`الخادم المحلي يستمع على المنفذ ${LOCAL_PORT}`);
    openBrowser(`${SERVER_URL}/desktop-auth`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `المنفذ ${LOCAL_PORT} مشغول. يرجى إغلاق أي تطبيق آخر يستخدمه.`,
      );
    } else {
      console.error("خطأ في الخادم المحلي:", err.message);
    }
    callback(err);
  });

  return server;
}

// دالة الاتصال بالسيرفر الرئيسي باستخدام التوكن
function connectToServer(token) {
  if (socket) socket.disconnect();

  socket = io(SERVER_URL, {
    query: { token },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    console.log("✅ متصل بالسيرفر");
    socket.emit("register", { type: "desktop" });
  });

  socket.on("connect_error", (err) => {
    console.error("❌ خطأ في الاتصال:", err.message);
  });

  socket.on("webhook-request", async (data) => {
    console.log("📦 استقبال طلب ويب هوك:", data);

    const {
      url,
      method = "POST",
      headers = {},
      body = {},
      repeat = 1,
      interval = 500,
      delayBefore = 0,
    } = data;

    if (delayBefore > 0) {
      console.log(`⏳ انتظار ${delayBefore}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayBefore));
    }

    for (let i = 0; i < repeat; i++) {
      if (i > 0 && interval > 0) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      try {
        console.log(`🔁 تنفيذ ${i + 1}/${repeat} إلى ${url}`);
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: method !== "GET" ? JSON.stringify(body) : undefined,
        });

        const responseText = await response.text();
        console.log(
          `✅ استجابة (${response.status}): ${responseText.substring(0, 200)}`,
        );
      } catch (err) {
        console.error("❌ فشل تنفيذ الطلب:", err.message);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("🔌 تم قطع الاتصال");
  });
}

// الدالة الرئيسية
async function main() {
  const config = loadConfig();
  let token = config.token;

  if (!token) {
    console.log("لم يتم العثور على توكن. بدء عملية تسجيل الدخول...");
    localServer = await startLocalServer((err, newToken) => {
      if (err) {
        console.error("فشل الحصول على التوكن:", err.message);
        process.exit(1);
      }
      token = newToken;
      saveConfig({ token });
      console.log("تم حفظ التوكن. الاتصال بالسيرفر...");
      connectToServer(token);
    });
  } else {
    console.log("تم العثور على توكن مخزن. الاتصال المباشر بالسيرفر...");
    connectToServer(token);
  }
}

main();

// الحفاظ على تشغيل العملية
process.stdin.resume();
