const video = document.getElementById("inputVideo");
const canvas = document.getElementById("overlay");
const gate = document.getElementById("gate");
const volSlider = document.getElementById("volSlider");
const muteBtn = document.getElementById("muteBtn");
const specEl = document.getElementById("spectrogram");
const topbar = document.querySelector(".topbar");

const artistIDEl = document.getElementById("artistID");
const debugBoca = document.getElementById("debugBoca");
const debugPan = document.getElementById("debugPan");
const debugFiltro = document.getElementById("debugFiltro");
const debugEmocion = document.getElementById("debugEmocion");
const debugBPM = document.getElementById("debugBPM");

const uiHintBoxEl = document.getElementById("uiHintBox");

const MODEL_URL = "./models";
const FPS_INTERVAL_MS = 400; 
const MOUTH_MIN = 0.15;
const MOUTH_MAX = 0.65;

const SCALE_POOLS = {
  happy: ["C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5"], // pent mayor
  sad: ["C4", "Eb4", "F4", "G4", "Bb4", "C5", "Eb5"], // pent menor
  angry: ["C4", "D4", "Eb4", "F4", "G4", "Ab4", "B4", "C5"], // menor armónica
  surprised: ["C4", "D4", "E4", "F#4", "G4", "A4", "B4", "C5"], // lidia
  fearful: ["C4", "Db4", "Eb4", "F4", "G4", "Ab4", "Bb4", "C5"], // frigia
  neutral: null,
};
const SEED_POOLS = [
  ["C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5", "G5", "A5"],
  ["D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5"],
  ["F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5"],
  ["G4", "A4", "B4", "C5", "D5", "E5", "F5", "G5"],
];

//1 id

const BPM_POOLS = {
  happy: 140,
  sad: 30,
  angry: 190, 
  surprised: 100,
  fearful: 140,
  neutral: 80, 
};

let uiStarted = false,
  modelsReady = false,
  masterStarted = false;
let reverb;
const MAX_TRACKS = 1;
const tracks = Array.from({ length: MAX_TRACKS }, () => ({
  synth: null,
  panner: null,
  filter: null,
  waveType: "triangle",
  seedScale: [],
  currentScale: [],
  lastMO: 0.0,
  present: false,
  seenOnce: false,
}));
let currentEmotion = "neutral";
let fx = {
  delay: null,
  dist: null,
  chorus: null,
  phaser: null,
  vibrato: null,
  tremolo: null,
  fxReady: false,
};

function dominantEmotion(expressions) {
  if (!expressions) return "neutral";
  let best = "neutral",
    val = 0;
  for (const k in expressions) {
    if (expressions[k] > val) {
      val = expressions[k];
      best = k;
    }
  }
  return best || "neutral";
}

function applyEmotionFX(name) {
  if (!fx.fxReady) return;
  switch (name) {
    case "happy":
      fx.chorus.wet.rampTo(0.7, 0.2);
      fx.delay.wet.rampTo(0.4, 0.2);
      fx.dist.wet.rampTo(0.0, 0.2);
      fx.phaser.wet.rampTo(0.4, 0.2);
      break;
    case "sad":
      fx.chorus.wet.rampTo(0.2, 0.2);
      fx.delay.wet.rampTo(0.3, 0.2);
      fx.dist.wet.rampTo(0.0, 0.2);
      if (reverb) reverb.wet.rampTo(0.6, 0.4);
      break;
    case "angry":
      fx.chorus.wet.rampTo(0.0, 0.2);
      fx.dist.wet.rampTo(0.8, 0.2);
      fx.tremolo.wet.rampTo(0.5, 0.2);
      break;
    case "surprised":
      fx.delay.wet.rampTo(0.5, 0.2);
      fx.vibrato.wet.rampTo(0.6, 0.2);
      break;
    default:
      fx.chorus.wet.rampTo(0.0, 0.2);
      fx.delay.wet.rampTo(0.0, 0.2);
      fx.dist.wet.rampTo(0.0, 0.2);
      fx.phaser.wet.rampTo(0.0, 0.2);
      fx.vibrato.wet.rampTo(0.0, 0.2);
      fx.tremolo.wet.rampTo(0.0, 0.2);
      if (reverb) reverb.wet.rampTo(0.25, 0.4);
      break;
  }
}

function dist(a, b) {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
function norm(x, min, max) {
  return (x - min) / (max - min);
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
function mouthOpenness(landmarks) {
  const m = landmarks.getMouth();
  const upper = m[13],
    lower = m[19],
    left = m[0],
    right = m[6];
  const v = dist(upper, lower),
    h = dist(left, right) + 1e-6;
  return v / h;
}

function createBiometricSeed(landmarks) {
  try {
    const leftEye = landmarks.getLeftEye()[0],
      rightEye = landmarks.getRightEye()[3],
      noseTip = landmarks.getNose()[6];
    const eyeDist = dist(leftEye, rightEye),
      noseBridge = dist(leftEye, noseTip);
    if (eyeDist === 0 || noseBridge === 0) return Math.random();
    return (eyeDist * noseBridge) % 1;
  } catch (e) {
    return Math.random();
  }
}
function syncCanvasToVideo() {
  const w = video.clientWidth,
    h = video.clientHeight;
  if (!w || !h || (canvas.width === w && canvas.height === h)) return;
  canvas.width = w;
  canvas.height = h;
}

async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    video.srcObject = stream;
  } catch (e) {
    alert("No se pudo iniciar la webcam.");
    console.error(e);
    return;
  }
  video.addEventListener("loadedmetadata", () => {
    syncCanvasToVideo();
    window.addEventListener("resize", syncCanvasToVideo);
  });

  debugEmocion.textContent = "[Cargando: Detector...]";
  await faceapi.loadTinyFaceDetectorModel(MODEL_URL);
  debugEmocion.textContent = "[Cargando: Landmarks...]";
  await faceapi.loadFaceLandmarkModel(MODEL_URL);
  debugEmocion.textContent = "[Cargando: Expresiones...]";
  await faceapi.loadFaceExpressionModel(MODEL_URL);


  modelsReady = true;
  debugEmocion.textContent = "[Listo. Presioná ESPACIO]";
}

async function detectLoop() {
  if (!uiStarted || video.paused || video.ended) {
    requestAnimationFrame(detectLoop);
    return;
  }
  syncCanvasToVideo();
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: 416,
    scoreThreshold: 0.45,
  });


  const dets = await faceapi
    .detectAllFaces(video, detectorOptions)
    .withFaceLandmarks()
    .withFaceExpressions();

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const displaySize = { width: canvas.width, height: canvas.height };
  const resized = faceapi.resizeResults(dets, displaySize);
  const faces = resized
    .map((r) => ({
      raw: r,
      area: r.detection.box.width * r.detection.box.height,
      cx: r.detection.box.x + r.detection.box.width / 2,
      cy: r.detection.box.y + r.detection.box.height / 2,
      cxNorm: (r.detection.box.x + r.detection.box.width / 2) / canvas.width,
      cyNorm: (r.detection.box.y + r.detection.box.height / 2) / canvas.height,
    }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 1);

  tracks.forEach((t) => (t.present = false));

  if (faces.length > 0) {
    const f = faces[0];
    const t = tracks[0];
    t.present = true;
    faceapi.draw.drawDetections(canvas, f.raw);
    // faceapi.draw.drawFaceLandmarks(canvas, f.raw,
    // { drawLines: true, color: 'rgba(255, 255, 255, 0.7)' });
    const lm = f.raw.landmarks;

    if (!t.seenOnce && lm) {
      const seed = createBiometricSeed(lm);

      if (artistIDEl) {
        artistIDEl.textContent = `[ID_ARTISTA: ${seed.toFixed(8)}]`;
        artistIDEl.classList.add("visible");
      }
      t.seedScale = SEED_POOLS[Math.floor(seed * SEED_POOLS.length)];
      t.waveType =
        seed < 0.33 ? "triangle" : seed < 0.66 ? "sawtooth" : "square";
      t.currentScale = t.seedScale.slice();
      t.seenOnce = true;
    }
    const mo = mouthOpenness(lm);
    t.lastMO = mo;
    const moClamped = clamp(norm(mo, MOUTH_MIN, MOUTH_MAX), 0, 1);
    const panVal = (f.cxNorm * 2 - 1) * 0.8;
    const cutoffDyn = 250 + (1 - f.cyNorm) * 7000;
    if (masterStarted && t.panner && t.filter) {
      t.panner.pan.rampTo(panVal, 0.05);
      t.filter.frequency.rampTo(cutoffDyn, 0.05);
    }
    const expr = f.raw.expressions;
    const emo = dominantEmotion(expr);
    currentEmotion = emo;

    debugBoca.textContent = `[Boca: ${moClamped.toFixed(2)}]`;
    debugPan.textContent = `[Pan: ${panVal.toFixed(2)}]`;
    debugFiltro.textContent = `[Filtro: ${cutoffDyn.toFixed(0)} Hz]`;
    debugEmocion.textContent = `[Emoción: ${currentEmotion.toUpperCase()}]`;
  } else {
  
    debugBoca.textContent = `[Boca: ---]`;
    debugPan.textContent = `[Pan: ---]`;
    debugFiltro.textContent = `[Filtro: ---]`;
    debugEmocion.textContent = `[Buscando Artista...]`;
  }

  setTimeout(() => requestAnimationFrame(detectLoop),
  FPS_INTERVAL_MS);
}

function makePolySynth(wave) {
  return new Tone.PolySynth(Tone.FMSynth, {
    envelope: { attack: 0.3, decay: 0.1, sustain: 0.8, release: 0.8 },
    harmonicity: 3.01,
    modulationIndex: 12,
    modulationEnvelope: { attack: 0.2, decay: 0.01, sustain: 1, release: 0.5 },
  });
}

function setupAudio() {
  reverb = new Tone.Reverb({ decay: 2.2, wet: 0.25 }).toDestination();
  tracks.forEach((t) => {
    t.panner = new Tone.Panner(0).connect(reverb);
    t.filter = new Tone.Filter({ frequency: 1200, type: "lowpass" }).connect(
      t.panner
    );
    t.synth = makePolySynth("triangle").connect(t.filter);
  });
  if (volSlider) Tone.Destination.volume.value = Number(volSlider.value);
  Tone.Transport.bpm.value = 90;
  Tone.Transport.scheduleRepeat((time) => tick(time), "8n");
  Tone.Transport.start();
  masterStarted = true;
  fx.delay = new Tone.FeedbackDelay({
    delayTime: 0.28,
    feedback: 0.35,
    wet: 0.0,
  }).toDestination();
  fx.dist = new Tone.Distortion({
    distortion: 0.6,
    oversample: "4x",
    wet: 0.0,
  }).toDestination();
  fx.chorus = new Tone.Chorus({
    frequency: 1.6,
    delayTime: 3.5,
    depth: 0.6,
    wet: 0.0,
  })
    .start()
    .toDestination();
  fx.phaser = new Tone.Phaser({
    frequency: 0.8,
    octaves: 2,
    baseFrequency: 350,
    wet: 0.0,
  }).toDestination();
  fx.vibrato = new Tone.Vibrato({
    frequency: 6,
    depth: 0.25,
    wet: 0.0,
  }).toDestination();
  fx.tremolo = new Tone.Tremolo({
    frequency: 7,
    depth: 0.45,
    spread: 180,
    wet: 0.0,
  })
    .start()
    .toDestination();
  tracks.forEach((t) => {
    if (t && t.panner) {
      t.panner.connect(fx.delay);
      t.panner.connect(fx.dist);
      t.panner.connect(fx.chorus);
      t.panner.connect(fx.phaser);
      t.panner.connect(fx.vibrato);
      t.panner.connect(fx.tremolo);
    }
  });
  fx.fxReady = true;


  let lastApplied = "";
  setInterval(() => {

    const newBPM = BPM_POOLS[currentEmotion] || 90;
    
    Tone.Transport.bpm.value = newBPM;
    if (debugBPM) debugBPM.textContent = `[BPM: ${newBPM}]`;

    if (currentEmotion !== lastApplied) {
      applyEmotionFX(currentEmotion);

      const newScale = SCALE_POOLS[currentEmotion];
      tracks.forEach((t) => {
        if (newScale) t.currentScale = newScale.slice();
        else t.currentScale = t.seedScale.slice();
      });

      lastApplied = currentEmotion;
    }
  }, 150);

  initSpectrogram();
}

function downloadSpectrogram() {
  if (!specEl || !uiStarted) return;
  const dataURL = specEl.toDataURL("image/png");
  const link = document.createElement("a");
  link.href = dataURL;
  link.download = `mi-obra-biosynth.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function tick(time) {
  if (!masterStarted) return;
  tracks.forEach((t) => {
    if (!t.present) return;
    const scale = t.currentScale;
    if (!t.synth || !scale || !scale.length) return;
    const moClamped = clamp(norm(t.lastMO, MOUTH_MIN, MOUTH_MAX), 0, 1);
    const idx = Math.floor(moClamped * (scale.length - 1));
    const note = scale[idx];
    const restProb = 1 - moClamped;
    if (Math.random() < restProb * 0.5) return;
    t.synth.triggerAttackRelease(note, 0.25, time, 0.9);
  });
}

function setupUI() {
  window.addEventListener("keydown", async (e) => {
    if (e.code === "Space" && !uiStarted && modelsReady) {
      await Tone.start();
      setupAudio();
      if (volSlider) {
        volSlider.addEventListener("input", (e) => {
          Tone.Destination.volume.value = Number(e.target.value);
          if (Tone.Destination.mute && muteBtn) {
            Tone.Destination.mute = false;
            muteBtn.textContent = "Mute";
            muteBtn.classList.remove("active");
          }
        });
      }
      if (muteBtn) {
        muteBtn.addEventListener("click", () => {
          const next = !Tone.Destination.mute;
          Tone.Destination.mute = next;
          muteBtn.textContent = next ? "Unmute" : "Mute";
          muteBtn.classList.toggle("active", next);
        });
      }
      video.classList.add("running");
      gate.classList.add("hidden");
      canvas.classList.add("running");
      specEl.classList.add("running");
      uiStarted = true;
      if (modelsReady) detectLoop();
    }
  });


  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;


    if (e.key === "c" || e.key === "C") {
      if (topbar) {
        topbar.classList.toggle("visible");
      }
    }

    if (e.key === "i" || e.key === "I") {
      if (gate) {
        gate.classList.toggle("hidden");
      }
    }

    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      downloadSpectrogram();
    }
  });
}

function initSpectrogram() {
  const specCanvas = document.getElementById("spectrogram");
  if (!specCanvas) return;
  specCanvas.width = window.innerWidth;
  specCanvas.height = window.innerHeight;
  window.addEventListener("resize", () => {
    specCanvas.width = window.innerWidth;
    specCanvas.height = window.innerHeight;
  });

  const CTX2D = specCanvas.getContext("2d", { willReadFrequently: true });
  const AC = Tone.getContext().rawContext;
  const ANALYSER = AC.createAnalyser();
  ANALYSER.fftSize = 512;
  ANALYSER.smoothingTimeConstant = 0.8;
  if (reverb) reverb.connect(ANALYSER);
  else Tone.Destination.connect(ANALYSER);
  const DATA = new Uint8Array(ANALYSER.frequencyBinCount);

  // CTX2D.fillStyle = '#1b0029';
  CTX2D.fillStyle = "#000000ff";
  CTX2D.fillRect(0, 0, specCanvas.width, specCanvas.height);
  const BINS_TO_DRAW = 300;


  setInterval(() => {
    if (!uiStarted) return;
    const currentW = specCanvas.width,
      currentH = specCanvas.height;

    const imgData = CTX2D.getImageData(1, 0, currentW - 1, currentH);
    CTX2D.putImageData(imgData, 0, 0);

    const x = currentW - 1;
    CTX2D.fillStyle = "#000";
    CTX2D.fillRect(x, 0, 1, currentH);

    ANALYSER.getByteFrequencyData(DATA);
    const hStep = currentH / BINS_TO_DRAW;
    for (let i = 0; i < BINS_TO_DRAW; i++) {
      const rat = Math.min((DATA[i] / 255) * 1.5, 1.0);
      const hue = (280 + Math.round(rat * 220)) % 360;
      const lit = 10 + 80 * rat;
      CTX2D.beginPath();
      CTX2D.strokeStyle = `hsl(${hue}, 100%, ${lit}%)`;
      const y = currentH - i * hStep;
      CTX2D.moveTo(x, y);
      CTX2D.lineTo(x, y + hStep * 1.5);
      CTX2D.stroke();
    }
  }, 100);
}


function makeDraggable(el) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;

  if (el) {
    el.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    if (e.target.id === "volSlider" || e.target.id === "muteBtn") {
      return;
    }

    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
    el.classList.add("dragging");
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    el.style.top = el.offsetTop - pos2 + "px";
    el.style.left = el.offsetLeft - pos1 + "px";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    el.classList.remove("dragging");
  }
}

// inicio
document.addEventListener("DOMContentLoaded", async () => {
  setupUI();
  await initWebcam();


  makeDraggable(artistIDEl);
  makeDraggable(debugBoca);
  makeDraggable(debugPan);
  makeDraggable(debugFiltro);
  makeDraggable(debugEmocion);
  makeDraggable(topbar);
  makeDraggable(uiHintBoxEl);
  makeDraggable(debugBPM);
});
