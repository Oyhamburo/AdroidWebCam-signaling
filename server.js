// ===== deps =====
// npm i express ws
// (opcional mDNS:)
// npm i bonjour-service
// npm i bonjour
const http = require("http");
const express = require("express");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

// ===== config =====
const HOST = "0.0.0.0";
const PORT = 8080;

// ===== app =====
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== estado =====
let android = null;
let browser = null;

const state = {
  androidConnected: false,
  browserConnected: false,
  config: {
    micEnabled: false,
    width: 1280,
    height: 720,
    fps: 30,
    bitrateKbps: 6000,
    aspect: "AUTO_MAX",
    camera: "back",
    cameraName: null
  },
  caps: {
    cameras: [],
    formatsByCameraName: {},
    supportedAspects: ["AUTO_MAX","R16_9","R4_3","R1_1"]
  }
};

// ===== logging helpers =====
function now() {
  const d = new Date();
  return `[${d.toISOString().replace("T"," ").slice(0,23)}]`;
}
function log(...a){ console.log(now(), ...a); }
function warn(...a){ console.warn(now(), ...a); }

// ===== HTTP API =====
app.get("/api/config", (req, res) => {
  log(`GET /api/config -> android=${state.androidConnected} browser=${state.browserConnected}`);
  res.json({
    connected: state.androidConnected || state.browserConnected,
    androidConnected: state.androidConnected,
    browserConnected: state.browserConnected,
    ...state.config
  });
});

app.post("/api/config", (req, res) => {
  const body = req.body || {};
  state.config = {
    ...state.config,
    micEnabled: !!body.micEnabled,
    width: Number.isFinite(body.width) ? body.width : state.config.width,
    height: Number.isFinite(body.height) ? body.height : state.config.height,
    fps: Number.isFinite(body.fps) ? body.fps : state.config.fps,
    bitrateKbps: Number.isFinite(body.bitrateKbps) ? body.bitrateKbps : state.config.bitrateKbps,
    aspect: body.aspect || state.config.aspect,
    camera: body.camera || state.config.camera,
    cameraName: (body.cameraName ?? state.config.cameraName)
  };

  try {
    if (android && android.readyState === android.OPEN) {
      android.send(JSON.stringify({ type: "config", ...state.config }));
    }
  } catch (e) {
    warn("[WS] Error enviando config al Android:", e.message);
  }

  res.json({ ok: true });
});

app.get("/api/caps", (req, res) => {
  log(`GET /api/caps cameras=${state.caps.cameras.length}`);
  res.json({
    ...state.caps,
    current: {
      cameraName: state.config.cameraName,
      aspect: state.config.aspect,
      width: state.config.width,
      height: state.config.height,
      fps: state.config.fps
    }
  });
});

// ===== HTTP + WS =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const HEARTBEAT_MS = 30000;
function heartbeat() { this.isAlive = true; }
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(interval));

let nextId = 1;
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws._id = nextId++;
  ws._role = "unknown";

  const ip = req.socket.remoteAddress;
  const ua = (req.headers["user-agent"] || "").slice(0,120);
  const origin = req.headers.origin || "";
  log(`Nueva conexión WS#${ws._id} role=${ws._role} ip=${ip} origin=${origin} ua=${ua} total=${wss.clients.size}`);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.role === "android") {
      ws._role = "android";
      android = ws;
      state.androidConnected = true;
      log(`WS#${ws._id} role=${ws._role} ip=${ip} Rol asignado: ANDROID (antes=unknown)`);
      try { android.send(JSON.stringify({ type: "request-caps" })); } catch {}
      try { android.send(JSON.stringify({ type: "config", ...state.config })); } catch {}
      return;
    }
    if (msg.role === "browser") {
      ws._role = "browser";
      browser = ws;
      state.browserConnected = true;
      log(`WS#${ws._id} role=${ws._role} ip=${ip} Rol asignado: BROWSER (antes=unknown)`);
      return;
    }

    log(`WS#${ws._id} role=${ws._role} ip=${ip} ← msg type=${msg.type} bytes=${data.length}`);

    if (msg.type === "caps") {
      const caps = (msg.payload && typeof msg.payload === "object") ? msg.payload : msg;
      state.caps = {
        cameras: Array.isArray(caps.cameras) ? caps.cameras : [],
        formatsByCameraName: (caps.formatsByCameraName && typeof caps.formatsByCameraName === "object")
          ? caps.formatsByCameraName : {},
        supportedAspects: Array.isArray(caps.supportedAspects) && caps.supportedAspects.length
          ? caps.supportedAspects : ["AUTO_MAX","R16_9","R4_3","R1_1"]
      };
      log(`[WS] CAPS actualizadas. Cámaras: ${state.caps.cameras.length}`);
      return;
    }

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      if (ws === android && browser && browser.readyState === browser.OPEN) {
        browser.send(JSON.stringify(msg));
      } else if (ws === browser && android && android.readyState === android.OPEN) {
        android.send(JSON.stringify(msg));
      }
      return;
    }

    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }

    if (msg.type === "browser-ready") {
      const ok = !!(android && android.readyState === android.OPEN);
      log(`WS#${ws._id} role=${ws._role} ip=${ip} browser-ready -> android ok=${ok}`);
      if (ok) {
        try { android.send(JSON.stringify({ type: "browser-ready" })); } catch {}
      }
      return;
    }

    if (msg.type === "orientation") {
      if (browser && browser.readyState === browser.OPEN) {
        try { browser.send(JSON.stringify(msg)); } catch {}
      }
      return;
    }
  });

  ws.on("close", () => {
    if (ws === android) {
      android = null;
      state.androidConnected = false;
      log(`[WS] ANDROID desconectado (#${ws._id})`);
    }
    if (ws === browser) {
      browser = null;
      state.browserConnected = false;
      log(`[WS] BROWSER desconectado (#${ws._id})`);
    }
  });

  ws.on("error", (err) => {
    warn("[WS] Error socket:", err.message);
  });
});

// ===== arranque HTTP/WS =====
server.listen(PORT, HOST, () => {
  log(`HTTP/WS escuchando en http://${HOST}:${PORT}`);
  mdns.start(); // <- publicar mDNS al arrancar
});

// ===== mDNS / Bonjour =====
const mdns = (function makeMdns() {
  let bonjour = null;
  let mdnsSvc = null;
  let libName = "none";
  let lastError = null;
  let publishStarted = false;
  let upEventFired = false;

  function safeRequire(name) {
    try { return require(name); } catch (e) { return { __error: e }; }
  }

  function listIfs() {
    const ifs = os.networkInterfaces();
    const ipv4 = Object.values(ifs).flat().filter(Boolean)
      .filter(i => i.family === "IPv4" && !i.internal)
      .map(i => `${i.address}/${i.netmask} (${i.mac || "no-mac"})`);
    return ipv4;
  }

  function tryLoadBonjour() {
    // 1) bonjour-service (constructor)
    const modA = safeRequire("bonjour-service");
    if (!modA.__error) {
      const exp = modA && (modA.default || modA);
      log("[mDNS] inspección bonjour-service:",
          `typeof=${typeof exp}`,
          `keys=${Object.keys(modA||{}).join(",") || "(none)"}`);
      if (typeof exp === "function") {
        try {
          bonjour = new exp();
          libName = "bonjour-service (ctor)";
          return true;
        } catch (e) {
          warn("[mDNS] bonjour-service no se pudo instanciar como constructor:", e.message);
        }
      } else if (exp && typeof exp.Bonjour === "function") {
        try {
          bonjour = new exp.Bonjour();
          libName = "bonjour-service (exp.Bonjour)";
          return true;
        } catch (e) {
          warn("[mDNS] bonjour-service exp.Bonjour falló:", e.message);
        }
      }
    } else {
      warn("[mDNS] require('bonjour-service') falló:", modA.__error.message);
    }

    // 2) bonjour (factory)
    const modB = safeRequire("bonjour");
    if (!modB.__error) {
      const exp = modB && (modB.default || modB);
      log("[mDNS] inspección bonjour:",
          `typeof=${typeof exp}`,
          `keys=${Object.keys(modB||{}).join(",") || "(none)"}`);
      if (typeof exp === "function") {
        try {
          bonjour = exp(); // factory
          libName = "bonjour (factory)";
          return true;
        } catch (e) {
          warn("[mDNS] bonjour factory falló:", e.message);
        }
      } else {
        warn("[mDNS] 'bonjour' no es función. typeof=", typeof exp);
      }
    } else {
      warn("[mDNS] require('bonjour') falló:", modB.__error.message);
    }

    return false;
  }

  function publish() {
    if (!bonjour) {
      lastError = "No hay instancia bonjour cargada";
      warn("[mDNS] No se pudo publicar: bonjour=null");
      return false;
    }
    const serviceName = `Celsocam @ ${os.hostname()}`;
    try {
      mdnsSvc = bonjour.publish({
        name: serviceName,
        type: "celsocam", // _celsocam._tcp
        port: PORT,
        txt: { ver: "1", ws: "1", path: "/" }
      });

      publishStarted = true;
      upEventFired = false;

      // eventos soportados por ambas libs (si existen)
      mdnsSvc.on?.("up", () => {
        upEventFired = true;
        log(`[mDNS] UP name="${serviceName}" type=_celsocam._tcp port=${PORT}`);
      });
      mdnsSvc.on?.("error", (e) => {
        lastError = e?.message || String(e);
        warn("[mDNS] Error publicación:", lastError);
      });

      // algunas versiones requieren start() explícito
      if (typeof mdnsSvc.start === "function") {
        mdnsSvc.start();
        log("[mDNS] mdnsSvc.start() llamado");
      }

      // log de interfaces
      const ifs = listIfs();
      log("[mDNS] interfaces LAN:", ifs.join(", ") || "(ninguna)");

      return true;
    } catch (e) {
      lastError = e.message;
      warn("[mDNS] publish error:", lastError);
      return false;
    }
  }

  function start() {
    const ok = tryLoadBonjour();
    if (!ok) {
      lastError = "No se pudo cargar ni 'bonjour-service' ni 'bonjour'. ¿Instalados?";
      warn("[mDNS] " + lastError);
      return;
    }
    log(`[mDNS] usando librería: ${libName}`);
    publish();
  }

  function stop(cb) {
    try { mdnsSvc?.stop?.(() => log("[mDNS] stop ok")); } catch {}
    try { bonjour?.destroy?.(); } catch {}
    if (cb) cb();
  }

  // endpoint de depuración
  app.get("/debug/mdns", (_req, res) => {
    res.json({
      libName,
      publishStarted,
      upEventFired,
      lastError,
      interfaces: os.networkInterfaces(),
      flatIPv4: listIfs()
    });
  });

  // cierre ordenado
  function shutdown() {
    log("Apagando…");
    try { stop(() => log("[mDNS] detenido")); } catch {}
    try { server.close(() => log("HTTP/WS cerrado")); } catch {}
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { start, stop };
})();
