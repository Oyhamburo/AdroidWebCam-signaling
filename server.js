// npm i express ws
const http = require("http");
const express = require("express");
const path = require("path");
const { WebSocketServer } = require("ws");

const HOST = "0.0.0.0";
const PORT = 8080;

const app = express();

// --------- Middleware / estáticos ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------- Estado global ----------
let android = null; // socket del teléfono
let browser = null; // socket del navegador (visor)

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
    camera: "back",        // compat: "back" | "front"
    cameraName: null       // deviceName exacto (p.ej. "0","1","3")
  },
  caps: {
    cameras: [],                 // [{name,label,facing}]
    formatsByCameraName: {},     // {"0":[{w,h,fps:[..]}], ...}
    supportedAspects: ["AUTO_MAX","R16_9","R4_3","R1_1"]
  }
};

// --------- Helpers de log ----------
function now() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(...a) { console.log(`[${now()}]`, ...a); }

// --------- API: /api/config ----------
app.get("/api/config", (req, res) => {
  const out = {
    connected: state.androidConnected || state.browserConnected,
    androidConnected: state.androidConnected,
    browserConnected: state.browserConnected,
    ...state.config
  };
  log("GET /api/config -> android=%s browser=%s", out.androidConnected, out.browserConnected);
  res.json(out);
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

  log("POST /api/config -> apply width=%d height=%d fps=%d br=%d aspect=%s cam=%s camName=%s",
    state.config.width, state.config.height, state.config.fps, state.config.bitrateKbps,
    state.config.aspect, state.config.camera, state.config.cameraName);

  // reenviar la config al teléfono si está conectado
  try {
    if (android && android.readyState === android.OPEN) {
      android.send(JSON.stringify({ type: "config", ...state.config }));
    }
  } catch (e) {
    log("[WS] Error enviando config al Android:", e.message);
  }

  res.json({ ok: true });
});

// --------- API: /api/caps ----------
app.get("/api/caps", (req, res) => {
  log("GET /api/caps cameras=%d", state.caps.cameras.length);
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

// --------- NUEVO: pedir al Android que reenvíe capacidades ----------
app.post("/api/request-caps", (req, res) => {
  const ok = !!(android && android.readyState === android.OPEN);
  if (!ok) {
    log("POST /api/request-caps -> android conectado? %s", ok);
    return res.status(503).json({ ok: false, error: "Android no conectado" });
  }
  try {
    android.send(JSON.stringify({ type: "request-caps" }));
    log("POST /api/request-caps -> enviado a Android");
    res.json({ ok: true });
  } catch (e) {
    log("POST /api/request-caps -> error enviando: %s", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Keep-alive para limpiar sockets muertos
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

// --------- WS: manejo de mensajes ----------
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.socket.remoteAddress;
  const ua = req.headers['user-agent'];
  const origin = req.headers['origin'];
  const id = [...wss.clients].indexOf(ws) + 1;
  const total = wss.clients.size;

  log("Nueva conexión WS#%d role=unknown ip=%s origin=%s ua=%s total=%d", id, ip, origin, ua, total);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Identificación de rol
    if (msg.role === "android") {
      android = ws;
      state.androidConnected = true;
      log("WS#%d role=ANDROID (antes=unknown)", id);
      // Pedimos capacidades al conectar
      try { android.send(JSON.stringify({ type: "request-caps" })); } catch {}
      // Enviar config actual
      try { android.send(JSON.stringify({ type: "config", ...state.config })); } catch {}
      return;
    }
    if (msg.role === "browser") {
      browser = ws;
      state.browserConnected = true;
      log("WS#%d role=BROWSER (antes=unknown)", id);
      // Aviso al Android que el browser está listo (triggers offer)
      if (android && android.readyState === android.OPEN) {
        try { android.send(JSON.stringify({ type: "browser-ready" })); } catch {}
      }
      return;
    }

    if (msg.type) log("WS#%d ← msg type=%s bytes=%d", id, msg.type, data.length);

    // Teléfono nos publica capacidades
    if (msg.type === "caps") {
      const caps = (msg.payload && typeof msg.payload === "object") ? msg.payload : msg;
      state.caps = {
        cameras: Array.isArray(caps.cameras) ? caps.cameras : [],
        formatsByCameraName: (caps.formatsByCameraName && typeof caps.formatsByCameraName === "object")
          ? caps.formatsByCameraName : {},
        supportedAspects: Array.isArray(caps.supportedAspects) && caps.supportedAspects.length
          ? caps.supportedAspects : ["AUTO_MAX","R16_9","R4_3","R1_1"]
      };
      log("[WS] CAPS actualizadas. Cámaras: %d", state.caps.cameras.length);
      return;
    }

    // Mensajería de señalización
    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      if (ws === android && browser && browser.readyState === browser.OPEN) {
        browser.send(JSON.stringify(msg));
      } else if (ws === browser && android && android.readyState === android.OPEN) {
        android.send(JSON.stringify(msg));
      }
      return;
    }

    // Ping de cliente
    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }

    // Browser anuncia listo (compat)
    if (msg.type === "browser-ready") {
      if (android && android.readyState === android.OPEN) {
        try { android.send(JSON.stringify({ type: "browser-ready" })); } catch {}
      }
      return;
    }
  });

  ws.on("close", () => {
    if (ws === android) {
      android = null;
      state.androidConnected = false;
      log("[WS] ANDROID desconectado");
    }
    if (ws === browser) {
      browser = null;
      state.browserConnected = false;
      log("[WS] BROWSER desconectado");
    }
  });

  ws.on("error", (err) => {
    log("[WS] Error socket:", err.message);
  });
});

// --------- Arranque ----------
server.listen(PORT, HOST, () => {
  log(`HTTP/WS escuchando en http://${HOST}:${PORT}`);
});
