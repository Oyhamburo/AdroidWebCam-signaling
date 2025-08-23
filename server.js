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

// --------- API: /api/config ----------
app.get("/api/config", (req, res) => {
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

  // reenviar la config al teléfono si está conectado
  try {
    if (android && android.readyState === android.OPEN) {
      android.send(JSON.stringify({ type: "config", ...state.config }));
    }
  } catch (e) {
    console.warn("[WS] Error enviando config al Android:", e.message);
  }

  res.json({ ok: true });
});

// --------- API: /api/caps ----------
app.get("/api/caps", (req, res) => {
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

// --------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Keep-alive para limpiar sockets muertos
const HEARTBEAT_MS = 30000;
function heartbeat() {
  this.isAlive = true;
}
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
  console.log("[WS] Nueva conexión desde", ip);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Identificación de rol
    if (msg.role === "android") {
      android = ws;
      state.androidConnected = true;
      console.log("[WS] Rol asignado: ANDROID");
      // Pedimos capacidades al conectar
      try { android.send(JSON.stringify({ type: "request-caps" })); } catch {}
      // Opcional: enviarle config actual apenas conecta
      try { android.send(JSON.stringify({ type: "config", ...state.config })); } catch {}
      return;
    }
    if (msg.role === "browser") {
      browser = ws;
      state.browserConnected = true;
      console.log("[WS] Rol asignado: BROWSER");
      return;
    }

    // Teléfono nos publica capacidades
    if (msg.type === "caps") {
      // Soportamos formato con o sin 'payload'
      const caps = (msg.payload && typeof msg.payload === "object") ? msg.payload : msg;
      state.caps = {
        cameras: Array.isArray(caps.cameras) ? caps.cameras : [],
        formatsByCameraName: (caps.formatsByCameraName && typeof caps.formatsByCameraName === "object")
          ? caps.formatsByCameraName : {},
        supportedAspects: Array.isArray(caps.supportedAspects) && caps.supportedAspects.length
          ? caps.supportedAspects : ["AUTO_MAX","R16_9","R4_3","R1_1"]
      };
      console.log("[WS] CAPS actualizadas. Cámaras:", state.caps.cameras.length);
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

    // Browser anuncia listo
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
      console.log("[WS] ANDROID desconectado");
    }
    if (ws === browser) {
      browser = null;
      state.browserConnected = false;
      console.log("[WS] BROWSER desconectado");
    }
  });

  ws.on("error", (err) => {
    console.warn("[WS] Error socket:", err.message);
  });
});

// --------- Arranque ----------
server.listen(PORT, HOST, () => {
  console.log(`HTTP/WS escuchando en http://${HOST}:${PORT}`);
});
