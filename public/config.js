// ===== helpers =====
const $ = id => document.getElementById(id);

// ===== Estado de edición / refresh seguro =====
let formDirty = false;
let isSaving = false;
let refreshTimer = null;
let lastCfg = null;   // último /api/config recibido (para sincronizar)
let CAPS = null;      // /api/caps: { cameras:[{name,label,facing}], formatsByCameraName:{...}, supportedAspects:[...] }

const markDirty = () => { formDirty = true; };
const clearDirty = () => { formDirty = false; };

// ===== Utils de aspecto =====
const isClose = (a,b,t=0.02)=>Math.abs(a-b)<t;
const ratio = (w,h)=>w/h;
const aspectFromWH=(w,h)=>{
  const r=ratio(w,h);
  if(isClose(r,16/9))return "R16_9";
  if(isClose(r,4/3)) return "R4_3";
  if(isClose(r,1))   return "R1_1";
  return "AUTO_MAX";
};
const aspectMatch=(w,h,asp)=>{
  if(asp==="AUTO_MAX")return true;
  const r=ratio(w,h);
  if(asp==="R16_9")return isClose(r,16/9);
  if(asp==="R4_3") return isClose(r,4/3);
  if(asp==="R1_1") return isClose(r,1);
  return true;
};

// ===== Fallback de calidades si no hay /api/caps =====
const FALLBACK_QUALS = {
  R16_9: [[3840,2160,[30,60]],[2560,1440,[30,60]],[1920,1080,[24,30,60]],[1600,900,[30]],[1280,720,[24,30,60]],[960,540,[30]],[854,480,[30]],[640,360,[30]]],
  R4_3:  [[4000,3000,[30]],[2560,1920,[30]],[1920,1440,[30,60]],[1600,1200,[30]],[1440,1080,[30,60]],[1280,960,[30]],[1024,768,[30]],[800,600,[30]],[640,480,[30,60]]],
  R1_1:  [[2992,2992,[30]],[1088,1088,[30,60]],[1024,1024,[30]],[960,960,[30]],[720,720,[30,60]],[640,640,[30]],[480,480,[30]]]
};

// ===== Cargar capacidades =====
async function tryLoadCaps(){
  try{
    const r = await fetch("/api/caps",{cache:"no-store"});
    console.log("Caps:", r.status);
    if(!r.ok) return;
    CAPS = await r.json();
  }catch(_){}
}

// ===== CÁMARAS =====
function fillCameraSelectFromCaps(cfg){
  const sel = $("camera");
  sel.innerHTML = "";

  if(CAPS && Array.isArray(CAPS.cameras) && CAPS.cameras.length){
    CAPS.cameras.forEach(cam=>{
      const op = document.createElement("option");
      op.value = cam.name; // deviceName exacto
      op.textContent = cam.label || `${cam.facing ?? "cam"} (${cam.name})`;
      op.dataset.facing = cam.facing || "";
      sel.appendChild(op);
    });

    // Seleccionar actual: 1) por cameraName 2) por facing 3) primera
    let chosen = -1;
    if (cfg?.cameraName) {
      chosen = [...sel.options].findIndex(o => o.value === String(cfg.cameraName));
    }
    if (chosen < 0 && cfg?.camera) {
      chosen = [...sel.options].findIndex(o => (o.dataset.facing === String(cfg.camera)));
    }
    sel.selectedIndex = chosen >= 0 ? chosen : 0;

  } else {
    // fallback: back/front
    const o1 = document.createElement("option");
    o1.value = "back";  o1.textContent = "Trasera"; o1.dataset.facing = "back";
    const o2 = document.createElement("option");
    o2.value = "front"; o2.textContent = "Frontal"; o2.dataset.facing = "front";
    sel.appendChild(o1); sel.appendChild(o2);
    sel.value = (cfg?.camera === "front") ? "front" : "back";
  }
}

// ===== ASPECTOS =====
function fillAspectSelect(currentAspect){
  const sel = $("aspect");
  sel.innerHTML = "";
  const aspects = (CAPS && Array.isArray(CAPS.supportedAspects) && CAPS.supportedAspects.length)
    ? CAPS.supportedAspects
    : ["AUTO_MAX","R16_9","R4_3","R1_1"];

  const labels = {
    "AUTO_MAX": "Auto (máxima)",
    "R16_9": "16:9",
    "R4_3": "4:3",
    "R1_1": "1:1"
  };

  aspects.forEach(a=>{
    const op = document.createElement("option");
    op.value = a;
    op.textContent = labels[a] || a;
    sel.appendChild(op);
  });

  sel.value = currentAspect || "AUTO_MAX";
}

// ===== CALIDADES =====
function qualityListFor(aspect){
  const camVal = $("camera").value; // deviceName o back/front
  let list = [];

  if (CAPS && CAPS.formatsByCameraName && CAPS.formatsByCameraName[camVal]) {
    const arr = CAPS.formatsByCameraName[camVal] || [];
    list = arr
      .filter(f => aspectMatch(f.w, f.h, aspect))
      .flatMap(f => (f.fps || [30]).map(fr => ({w:f.w,h:f.h,fps:fr})));
  } else {
    const buckets = aspect==="AUTO_MAX"
      ? [...FALLBACK_QUALS.R16_9, ...FALLBACK_QUALS.R4_3, ...FALLBACK_QUALS.R1_1]
      : (FALLBACK_QUALS[aspect] || []);
    list = buckets.flatMap(([w,h,fpsArr]) => fpsArr.map(fr => ({w,h,fps:fr})));
  }

  return list.sort((a,b)=>{
    const A=a.w*a.h, B=b.w*b.h;
    if(A!==B) return B-A;
    return b.fps-a.fps;
  });
}

function fillQualitySelect(aspect, curW, curH, curFps){
  const sel = $("quality");
  sel.innerHTML = "";
  const list = qualityListFor(aspect);

  let matchIdx = -1;
  list.forEach((q,i)=>{
    const op = document.createElement("option");
    op.value = `${q.w}x${q.h}@${q.fps}`;
    op.textContent = `${q.w}×${q.h} @ ${q.fps} fps`;
    sel.appendChild(op);
    if(q.w===curW && q.h===curH && q.fps===curFps) matchIdx=i;
  });

  if(matchIdx===-1 && curW && curH && curFps){
    const custom = document.createElement("option");
    custom.value = `${curW}x${curH}@${curFps}`;
    custom.textContent = `Personalizada (${curW}×${curH} @ ${curFps} fps)`;
    sel.insertBefore(custom, sel.firstChild);
    matchIdx = 0;
    $("resHint").textContent = "Calidad no estándar; se respetará si el dispositivo la soporta.";
  }else{
    $("resHint").textContent = "";
  }

  sel.selectedIndex = Math.max(0, matchIdx);
}

function parseQuality(){
  const [wh,fpsStr] = $("quality").value.split("@");
  const [w,h] = wh.split("x").map(n=>parseInt(n,10));
  return { w, h, fps: parseInt(fpsStr,10) };
}

function syncBitrateUI(v){
  const val = Math.min(20000, Math.max(300, parseInt(v||0,10)));
  $("bitrateRange").value = val;
  $("bitrateKbps").value = val;
}

// ===== Carga/guardado =====
async function loadConfig(updateForm=true){
  if(isSaving) return;
  const res = await fetch("/api/config",{cache:"no-store"});
  const cfg = await res.json();
  lastCfg = cfg;

  // Estados de conexión siempre
  $("stAndroid").innerHTML = cfg.androidConnected ? '<span class="ok">conectado</span>' : '<span class="bad">desconectado</span>';
  $("stBrowser").innerHTML = cfg.browserConnected ? '<span class="ok">conectado</span>' : '<span class="bad">desconectado</span>';

  // Si hay cambios sin guardar, no tocamos el formulario (solo estados arriba)
  if(!updateForm) return;

  $("micEnabled").checked = !!cfg.micEnabled;

  // Cámaras y aspectos desde CAPS
  fillCameraSelectFromCaps(cfg);
  const asp = cfg.aspect || aspectFromWH(cfg.width, cfg.height);
  fillAspectSelect(asp);

  // Calidades en función de cámara seleccionada + aspecto
  fillQualitySelect(asp, cfg.width ?? 1280, cfg.height ?? 720, cfg.fps ?? 30);

  // Bitrate
  syncBitrateUI(cfg.bitrateKbps ?? 6000);
}

async function saveConfig(){
  isSaving = true;
  try{
    const { w,h,fps } = parseQuality();

    // Cámara seleccionada:
    const camSel = $("camera");
    const cameraName = camSel.value; // deviceName o back/front
    const cameraFacing = camSel.selectedOptions[0]?.dataset?.facing || (cameraName==="front"?"front":"back");

    const payload = {
      micEnabled: $("micEnabled").checked,
      aspect: $("aspect").value,
      width:w, height:h, fps,
      bitrateKbps: parseInt($("bitrateKbps").value,10),
      camera: cameraFacing,      // compatibilidad con app
      cameraName: cameraName     // deviceName exacto (si existe)
    };

    const r = await fetch("/api/config",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const out = await r.json();
    if(out.ok){
      clearDirty();
      await loadConfig(true);
      alert("Cambios enviados. El teléfono aplicará la configuración.");
    }else{
      alert("No se pudo aplicar la configuración.");
    }
  }finally{ isSaving=false; }
}

// ===== Listeners (no aplican nada hasta “Aplicar cambios”) =====
$("micEnabled").addEventListener("change", markDirty);

$("camera").addEventListener("change", ()=>{
  markDirty();
  // Al cambiar de cámara, regeneramos calidades tomando como referencia lo último recibido
  const base = lastCfg
    ? { w:lastCfg.width, h:lastCfg.height, fps:lastCfg.fps }
    : { w:1280, h:720, fps:30 };
  fillQualitySelect($("aspect").value, base.w, base.h, base.fps);
});

$("aspect").addEventListener("change", ()=>{
  markDirty();
  const cur = parseQuality();
  fillQualitySelect($("aspect").value, cur.w, cur.h, cur.fps);
});

$("quality").addEventListener("change", markDirty);
$("bitrateRange").addEventListener("input", e=>{ syncBitrateUI(e.target.value); markDirty(); });
$("bitrateKbps").addEventListener("input", e=>{ syncBitrateUI(e.target.value); markDirty(); });

$("btnSave").addEventListener("click", saveConfig);
$("btnRefresh").addEventListener("click", ()=>loadConfig(!formDirty));

// ===== Init =====
(async()=>{
  await tryLoadCaps();       // si no existe, se usa fallback
  await loadConfig(true);    // carga inicial
  if(refreshTimer) clearInterval(refreshTimer);
  // Autorefresco: solo pisa el form si NO hay cambios pendientes
  refreshTimer = setInterval(()=>loadConfig(!formDirty), 3000);
})();
