// server.js
// npm i express ws
const http = require("http");
const express = require("express");
const path = require("path");
const { WebSocketServer } = require("ws");

const HOST = "0.0.0.0";
const PORT = 8080;

const app = express();

// ---------- Util logging ----------
const ts = () => new Date().toISOString().replace("T"," ").replace("Z","");
const shorten = (s, n=200) => (s.length > n ? s.slice(0,n) + `…(+${s.length-n})` : s);
const ipOf = (req) => (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) || req.socket.remoteAddress;

// ---------- Middleware ----------
app.use(express.json());

// HTTP access log compacto
app.use((req, res, next) => {
  const start = Date.now();
  const ip = ipOf(req);
  const ua = req.headers["user-agent"] || "-";
  res.on("finish", () => {
    console.log(`[${ts()}] HTTP ${req.method} ${req.url} ${res.statusCode} ip=${ip} ua=${shorten(ua,120)} tt=${Date.now()-start}ms`);
  });
  next();
});

// estáticos
app.use(express.static(path.join(__dirname, "public")));

// ---------- Estado global ----------
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
    camera: "back",
    cameraName: null
  },
  caps: {
    cameras: [],
    formatsByCameraName: {},
    supportedAspects: ["AUTO_MAX","R16_9","R4_3","R1_1"]
  }
};

// Métricas/debug
const metrics = {
  startAt: new Date().toISOString(),
  wsNextId: 1,
  clients: {}, // id -> {role, ip, ua, connectedAt, lastMsgAt, lastPongAt}
  lastEvents: [], // ring buffer simple
  connectCounts: { android:0, browser:0, unknown:0 },
  lastAndroidMsgAt: null,
  lastBrowserMsgAt: null,
  lastErrors: []
};
const pushEvent = (e) => {
  metrics.lastEvents.push({ t: ts(), ...e });
  if (metrics.lastEvents.length > 200) metrics.lastEvents.shift();
};

// ---------- API: /api/config ----------
app.get("/api/config", (req, res) => {
  console.log(`[${ts()}] GET /api/config -> android=${state.androidConnected} browser=${state.browserConnected}`);
  res.json({
    connected: state.androidConnected || state.browserConnected,
    androidConnected: state.androidConnected,
    browserConnected: state.browserConnected,
    ...state.config
  });
});

app.post("/api/config", (req, res) => {
  const body = req.body || {};
  console.log(`[${ts()}] POST /api/config body=${shorten(JSON.stringify(body), 300)}`);

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
  if (android && android.readyState === android.OPEN) {
    try {
      android.send(JSON.stringify({ type: "config", ...state.config }));
      console.log(`[${ts()}] -> Enviada config a ANDROID`);
    } catch (e) {
      console.warn(`[${ts()}] [WS] Error enviando config al ANDROID: ${e.message}`);
    }
  } else {
    console.warn(`[${ts()}] ANDROID no conectado: no se reenvía config`);
  }

  res.json({ ok: true });
});

// ---------- API: /api/caps ----------
app.get("/api/caps", (req, res) => {
  console.log(`[${ts()}] GET /api/caps cameras=${state.caps.cameras.length}`);
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

// ---------- API: /api/debug ----------
app.get("/api/debug", (req, res) => {
  const summary = {
    now: new Date().toISOString(),
    state: {
      androidConnected: state.androidConnected,
      browserConnected: state.browserConnected,
      config: state.config,
      capsSummary: {
        cameras: state.caps.cameras.length,
        camsSample: state.caps.cameras.slice(0,3),
        aspects: state.caps.supportedAspects
      }
    },
    metrics: {
      ...metrics,
      clients: undefined // oculto detalle grande
    },
    clients: Object.fromEntries(Object.entries(metrics.clients).map(([id, c]) => [
      id, { ...c, ua: shorten(c.ua || "-", 120) }
    ]))
  };
  res.json(summary);
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Keep-alive para limpiar sockets muertos (con logging)
const HEARTBEAT_MS = 30000;
function heartbeat() {
  this.isAlive = true;
  const meta = metrics.clients[this._id] || {};
  meta.lastPongAt = ts();
  metrics.clients[this._id] = meta;
}
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.warn(`[${ts()}] [WS#${ws._id}] sin pong, se termina.`);
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(interval));

// Helpers WS
function tag(ws) {
  const role = ws._role || "unknown";
  return `WS#${ws._id} role=${role} ip=${ws._ip}`;
}
function safeSend(target, obj, note = "") {
  if (!target) return false;
  if (target.readyState !== target.OPEN) {
    console.warn(`[${ts()}] [${note}] destino no OPEN (state=${target.readyState})`);
    return false;
  }
  try {
    const s = JSON.stringify(obj);
    target.send(s);
    return true;
  } catch (e) {
    console.warn(`[${ts()}] Error enviando [${note}]: ${e.message}`);
    return false;
  }
}

wss.on("connection", (ws, req) => {
  ws._id = metrics.wsNextId++;
  ws._ip = ipOf(req);
  ws._ua = req.headers["user-agent"];
  ws._origin = req.headers["origin"];
  ws._role = "unknown";
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  metrics.clients[ws._id] = {
    role: ws._role,
    ip: ws._ip,
    ua: ws._ua,
    origin: ws._origin,
    connectedAt: ts(),
    lastMsgAt: null,
    lastPongAt: ts()
  };
  metrics.connectCounts.unknown++;

  console.log(`[${ts()}] Nueva conexión ${tag(ws)} origin=${ws._origin || "-"} ua=${shorten(ws._ua || "-", 120)} total=${wss.clients.size}`);

  ws.on("message", (data) => {
    const raw = data.toString();
    metrics.clients[ws._id].lastMsgAt = ts();

    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      console.warn(`[${ts()}] ${tag(ws)} mensaje no JSON: ${shorten(raw, 200)}`);
      return;
    }

    const mtype = msg.type || msg.role || "unknown";
    console.log(`[${ts()}] ${tag(ws)} ← msg type=${mtype} bytes=${raw.length}`);

    // Identificación de rol
    if (msg.role === "android" || msg.role === "browser") {
      const prev = ws._role;
      ws._role = msg.role;
      metrics.clients[ws._id].role = ws._role;

      if (msg.role === "android") {
        android = ws;
        state.androidConnected = true;
        metrics.connectCounts.android++;
        console.log(`[${ts()}] ${tag(ws)} Rol asignado: ANDROID (antes=${prev})`);
        // Pedimos capacidades y mandamos config actual
        safeSend(android, { type: "request-caps" }, "request-caps");
        safeSend(android, { type: "config", ...state.config }, "initial-config");
      } else if (msg.role === "browser") {
        browser = ws;
        state.browserConnected = true;
        metrics.connectCounts.browser++;
        console.log(`[${ts()}] ${tag(ws)} Rol asignado: BROWSER (antes=${prev})`);
      }
      return;
    }

    // Caps del teléfono
    if (msg.type === "caps") {
      const caps = (msg.payload && typeof msg.payload === "object") ? msg.payload : msg;
      state.caps = {
        cameras: Array.isArray(caps.cameras) ? caps.cameras : [],
        formatsByCameraName: (caps.formatsByCameraName && typeof caps.formatsByCameraName === "object")
          ? caps.formatsByCameraName : {},
        supportedAspects: Array.isArray(caps.supportedAspects) && caps.supportedAspects.length
          ? caps.supportedAspects : ["AUTO_MAX","R16_9","R4_3","R1_1"]
      };
      console.log(`[${ts()}] ${tag(ws)} CAPS actualizadas. cameras=${state.caps.cameras.length}`);
      pushEvent({ kind:"caps", from: ws._role, count: state.caps.cameras.length });
      return;
    }

    // Reenvío de orientación
    if (msg.type === "orientation") {
      if (ws === android && browser) {
        const ok = safeSend(browser, { type:"orientation", orientation: msg.orientation }, "orientation->browser");
        console.log(`[${ts()}] ${tag(ws)} orientation "${msg.orientation}" reenviado=${ok}`);
      }
      return;
    }

    // Señalización
    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      if (ws === android && browser) {
        const ok = safeSend(browser, msg, `sig:${msg.type} android->browser`);
        console.log(`[${ts()}] ${tag(ws)} fwd ${msg.type} to BROWSER ok=${ok}`);
      } else if (ws === browser && android) {
        const ok = safeSend(android, msg, `sig:${msg.type} browser->android`);
        console.log(`[${ts()}] ${tag(ws)} fwd ${msg.type} to ANDROID ok=${ok}`);
      } else {
        console.warn(`[${ts()}] ${tag(ws)} ${msg.type} recibido pero falta contraparte (android=${!!android} browser=${!!browser})`);
      }
      if (ws._role === "android") metrics.lastAndroidMsgAt = ts();
      if (ws._role === "browser") metrics.lastBrowserMsgAt = ts();
      pushEvent({ kind:"signal", type: msg.type, from: ws._role });
      return;
    }

    // Ping
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong" }, "pong");
      return;
    }

    // Browser listo
    if (msg.type === "browser-ready") {
      const ok = android ? safeSend(android, { type:"browser-ready" }, "browser-ready") : false;
      console.log(`[${ts()}] ${tag(ws)} browser-ready -> android ok=${ok}`);
      return;
    }

    // Mensaje no reconocido (útil para ver si llega algo inesperado)
    console.log(`[${ts()}] ${tag(ws)} msg desconocido: ${shorten(JSON.stringify(msg), 300)}`);
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = reasonBuf?.toString() || "";
    console.warn(`[${ts()}] Cierre ${tag(ws)} code=${code} reason=${shorten(reason,200)}`);

    if (ws === android) {
      android = null;
      state.androidConnected = false;
      console.log(`[${ts()}] ANDROID desconectado`);
    }
    if (ws === browser) {
      browser = null;
      state.browserConnected = false;
      console.log(`[${ts()}] BROWSER desconectado`);
    }
    delete metrics.clients[ws._id];
  });

  ws.on("error", (err) => {
    console.warn(`[${ts()}] Error ${tag(ws)}: ${err.message}`);
    metrics.lastErrors.push({ t: ts(), id: ws._id, msg: err.message });
    if (metrics.lastErrors.length > 100) metrics.lastErrors.shift();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[${ts()}] HTTP/WS escuchando en http://${HOST}:${PORT}`);
});
