const els = {
  videoInput: document.getElementById("videoInput"),
  dropzone: document.getElementById("dropzone"),
  sourceVideo: document.getElementById("sourceVideo"),
  outputPreview: document.getElementById("outputPreview"),
  motionArt: document.getElementById("motionArt"),
  sizeValue: document.getElementById("sizeValue"),
  durationValue: document.getElementById("durationValue"),
  qualityPill: document.getElementById("qualityPill"),
  fpsSelect: document.getElementById("fpsSelect"),
  convertButton: document.getElementById("convertButton"),
  tiktokButton: document.getElementById("tiktokButton"),
  resetButton: document.getElementById("resetButton"),
  downloadButton: document.getElementById("downloadButton"),
  videoDownloadButton: document.getElementById("videoDownloadButton"),
  videoDownloadLabel: document.getElementById("videoDownloadLabel"),
  statusText: document.getElementById("statusText"),
  progressValue: document.getElementById("progressValue"),
  progressBar: document.getElementById("progressBar"),
  segments: Array.from(document.querySelectorAll("[data-loop]")),
};

let videoUrl = "";
let outputUrl = "";
let videoExportUrl = "";
let selectedLoops = 1;
let currentFileName = "live-motion";
let isBusy = false;

const textEncoder = new TextEncoder();
const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = makeCrcTable();

drawAmbientPreview();
bindUi();
setProgress("Listo", 0);

function bindUi() {
  els.videoInput.addEventListener("change", () => {
    const file = els.videoInput.files?.[0];
    if (file) loadVideo(file);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("is-dragging");
    });
  });

  els.dropzone.addEventListener("drop", (event) => {
    const file = Array.from(event.dataTransfer?.files || []).find((item) => item.type.startsWith("video/"));
    if (file) loadVideo(file);
  });

  els.segments.forEach((button) => {
    button.addEventListener("click", () => {
      selectedLoops = Number(button.dataset.loop);
      els.segments.forEach((segment) => {
        const isActive = segment === button;
        segment.classList.toggle("is-active", isActive);
        segment.setAttribute("aria-checked", String(isActive));
      });
    });
  });

  els.convertButton.addEventListener("click", () => {
    if (!els.sourceVideo.src) {
      els.videoInput.click();
      return;
    }
    convertToApng();
  });

  els.tiktokButton.addEventListener("click", () => {
    if (!els.sourceVideo.src) {
      els.videoInput.click();
      return;
    }
    convertToVideo();
  });

  els.resetButton.addEventListener("click", resetApp);
}

async function loadVideo(file) {
  cleanupOutputs();
  if (videoUrl) URL.revokeObjectURL(videoUrl);

  currentFileName = cleanFileName(file.name.replace(/\.[^.]+$/, "")) || "live-motion";
  videoUrl = URL.createObjectURL(file);
  els.sourceVideo.src = videoUrl;
  els.sourceVideo.classList.add("is-visible");
  els.outputPreview.classList.remove("is-visible");
  els.sourceVideo.load();

  try {
    await once(els.sourceVideo, "loadedmetadata");
    const width = els.sourceVideo.videoWidth;
    const height = els.sourceVideo.videoHeight;
    const duration = els.sourceVideo.duration;
    els.sizeValue.textContent = `${width} x ${height}`;
    els.durationValue.textContent = `${duration.toFixed(1)} s`;
    els.qualityPill.textContent = `Original ${width} x ${height}`;
    setProgress("Video cargado", 0);
  } catch (error) {
    setProgress("No se pudo leer el video", 0);
  }
}

async function convertToApng() {
  if (isBusy) return;
  isBusy = true;
  cleanupApngOutput();
  setControlsDisabled(true);

  const video = els.sourceVideo;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration;
  const fps = Number(els.fpsSelect.value);

  if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
    setProgress("Video no valido", 0);
    setControlsDisabled(false);
    isBusy = false;
    return;
  }

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const delayMs = Math.max(1, Math.round(1000 / fps));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const chunks = [pngSignature, chunk("IHDR", makeIhdr(width, height)), chunk("acTL", makeActl(totalFrames, selectedLoops))];
  let sequence = 0;

  try {
    video.pause();
    for (let index = 0; index < totalFrames; index += 1) {
      const frameTime = Math.min(index / fps, Math.max(0, duration - 0.001));
      setProgress(`Frame ${index + 1} de ${totalFrames}`, (index / totalFrames) * 92);
      await seekVideo(video, frameTime);
      ctx.drawImage(video, 0, 0, width, height);

      const rgba = ctx.getImageData(0, 0, width, height).data;
      const scanlines = rgbaToScanlines(rgba, width, height);
      const imageData = await deflate(scanlines);
      const frameControl = makeFctl(sequence, width, height, delayMs);
      sequence += 1;
      chunks.push(chunk("fcTL", frameControl));

      if (index === 0) {
        chunks.push(chunk("IDAT", imageData));
      } else {
        const frameData = new Uint8Array(4 + imageData.length);
        writeUint32(frameData, 0, sequence);
        frameData.set(imageData, 4);
        sequence += 1;
        chunks.push(chunk("fdAT", frameData));
      }

      await pause();
    }

    chunks.push(chunk("IEND", new Uint8Array()));
    setProgress("Armando APNG", 96);

    const blob = new Blob(chunks, { type: "image/png" });
    outputUrl = URL.createObjectURL(blob);
    els.outputPreview.src = outputUrl;
    els.outputPreview.classList.add("is-visible");
    els.sourceVideo.classList.remove("is-visible");
    els.downloadButton.href = outputUrl;
    els.downloadButton.download = `${currentFileName}-live-${selectedLoops}x.png`;
    els.downloadButton.classList.remove("is-disabled");

    const megabytes = blob.size / (1024 * 1024);
    setProgress(`APNG listo (${megabytes.toFixed(1)} MB)`, 100);
  } catch (error) {
    console.error(error);
    setProgress("Conversion interrumpida", 0);
  } finally {
    setControlsDisabled(false);
    isBusy = false;
  }
}

async function convertToVideo() {
  if (isBusy) return;
  isBusy = true;
  cleanupVideoOutput();
  setControlsDisabled(true);

  const video = els.sourceVideo;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration;
  const fps = Number(els.fpsSelect.value);

  if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
    setProgress("Video no valido", 0);
    setControlsDisabled(false);
    isBusy = false;
    return;
  }

  if (!("MediaRecorder" in window) || !HTMLCanvasElement.prototype.captureStream) {
    setProgress("Tu navegador no puede exportar video", 0);
    setControlsDisabled(false);
    isBusy = false;
    return;
  }

  const format = pickVideoFormat();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(fps);
  const chunks = [];
  const options = format.mimeType
    ? { mimeType: format.mimeType, videoBitsPerSecond: estimateVideoBitrate(width, height, fps) }
    : { videoBitsPerSecond: estimateVideoBitrate(width, height, fps) };

  let recorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (error) {
    recorder = new MediaRecorder(stream);
  }

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const recorderDone = new Promise((resolve, reject) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(new Error("Recorder failed")), { once: true });
  });

  let activeLoop = 0;
  let drawing = true;
  const totalDuration = duration * selectedLoops;
  const drawFrame = () => {
    if (!drawing) return;
    ctx.drawImage(video, 0, 0, width, height);
    const encodedSeconds = activeLoop * duration + Math.min(video.currentTime, duration);
    setProgress(`Grabando video ${activeLoop + 1} de ${selectedLoops}`, (encodedSeconds / totalDuration) * 96);
    requestAnimationFrame(drawFrame);
  };

  try {
    els.outputPreview.classList.remove("is-visible");
    els.sourceVideo.classList.add("is-visible");
    video.pause();
    video.muted = true;
    video.playsInline = true;

    recorder.start(1000);
    requestAnimationFrame(drawFrame);

    for (activeLoop = 0; activeLoop < selectedLoops; activeLoop += 1) {
      await seekVideo(video, 0);
      const ended = waitForEnded(video);
      await playVideo(video);
      await ended;
    }

    drawing = false;
    video.pause();
    recorder.stop();
    await recorderDone;
    stream.getTracks().forEach((track) => track.stop());

    const blobType = recorder.mimeType || format.blobType;
    const blob = new Blob(chunks, { type: blobType });
    videoExportUrl = URL.createObjectURL(blob);
    const extension = extensionFromMime(blobType);
    els.videoDownloadButton.href = videoExportUrl;
    els.videoDownloadButton.download = `${currentFileName}-tiktok-${selectedLoops}x.${extension}`;
    els.videoDownloadLabel.textContent = `Descargar ${extension.toUpperCase()}`;
    els.videoDownloadButton.classList.remove("is-disabled");

    const megabytes = blob.size / (1024 * 1024);
    setProgress(`Video listo (${megabytes.toFixed(1)} MB)`, 100);
  } catch (error) {
    console.error(error);
    drawing = false;
    stream.getTracks().forEach((track) => track.stop());
    setProgress("No se pudo crear el video", 0);
  } finally {
    setControlsDisabled(false);
    isBusy = false;
  }
}

function resetApp() {
  if (isBusy) return;
  cleanupOutputs();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = "";
  currentFileName = "live-motion";
  els.videoInput.value = "";
  els.sourceVideo.removeAttribute("src");
  els.sourceVideo.load();
  els.sourceVideo.classList.remove("is-visible");
  els.outputPreview.classList.remove("is-visible");
  els.sizeValue.textContent = "Sin archivo";
  els.durationValue.textContent = "0.0 s";
  els.qualityPill.textContent = "Resolucion original";
  setProgress("Listo", 0);
}

function cleanupOutputs() {
  cleanupApngOutput();
  cleanupVideoOutput();
}

function cleanupApngOutput() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = "";
  els.outputPreview.removeAttribute("src");
  els.downloadButton.removeAttribute("href");
  els.downloadButton.classList.add("is-disabled");
}

function cleanupVideoOutput() {
  if (videoExportUrl) URL.revokeObjectURL(videoExportUrl);
  videoExportUrl = "";
  els.videoDownloadButton.removeAttribute("href");
  els.videoDownloadButton.classList.add("is-disabled");
  els.videoDownloadLabel.textContent = "Descargar video";
}

function setControlsDisabled(disabled) {
  els.convertButton.disabled = disabled;
  els.tiktokButton.disabled = disabled;
  els.resetButton.disabled = disabled;
  els.fpsSelect.disabled = disabled;
  els.segments.forEach((button) => {
    button.disabled = disabled;
  });
}

function setProgress(text, percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  els.statusText.textContent = text;
  els.progressValue.textContent = `${value}%`;
  els.progressBar.style.width = `${value}%`;
}

function once(target, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed waiting for ${eventName}`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.002) {
      requestAnimationFrame(() => resolve());
      return;
    }

    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Video seek failed"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

function playVideo(video) {
  return new Promise((resolve, reject) => {
    const playResult = video.play();
    if (playResult?.then) {
      playResult.then(resolve).catch(reject);
      return;
    }
    resolve();
  });
}

function waitForEnded(video) {
  return new Promise((resolve, reject) => {
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Video playback failed"));
    };
    const cleanup = () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("ended", onEnded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function pause() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function pickVideoFormat() {
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", blobType: "video/mp4", extension: "mp4" },
    { mimeType: "video/mp4", blobType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", blobType: "video/webm", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", blobType: "video/webm", extension: "webm" },
    { mimeType: "video/webm", blobType: "video/webm", extension: "webm" },
  ];

  const supportsType = typeof MediaRecorder.isTypeSupported === "function"
    ? (mimeType) => MediaRecorder.isTypeSupported(mimeType)
    : () => false;

  return candidates.find((candidate) => supportsType(candidate.mimeType)) || {
    mimeType: "",
    blobType: "video/webm",
    extension: "webm",
  };
}

function estimateVideoBitrate(width, height, fps) {
  const target = width * height * fps * 0.14;
  return Math.round(Math.max(6_000_000, Math.min(80_000_000, target)));
}

function extensionFromMime(mimeType) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function rgbaToScanlines(rgba, width, height) {
  const stride = width * 4;
  const scanlineStride = stride + 1;
  const raw = new Uint8Array(scanlineStride * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * scanlineStride;
    const rgbaOffset = y * stride;
    raw[rawOffset] = 0;
    raw.set(rgba.subarray(rgbaOffset, rgbaOffset + stride), rawOffset + 1);
  }
  return raw;
}

async function deflate(bytes) {
  if ("CompressionStream" in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return zlibStore(bytes);
}

function makeIhdr(width, height) {
  const data = new Uint8Array(13);
  writeUint32(data, 0, width);
  writeUint32(data, 4, height);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function makeActl(frameCount, plays) {
  const data = new Uint8Array(8);
  writeUint32(data, 0, frameCount);
  writeUint32(data, 4, plays);
  return data;
}

function makeFctl(sequence, width, height, delayMs) {
  const data = new Uint8Array(26);
  writeUint32(data, 0, sequence);
  writeUint32(data, 4, width);
  writeUint32(data, 8, height);
  writeUint32(data, 12, 0);
  writeUint32(data, 16, 0);
  writeUint16(data, 20, delayMs);
  writeUint16(data, 22, 1000);
  data[24] = 0;
  data[25] = 0;
  return data;
}

function chunk(type, data) {
  const typeBytes = textEncoder.encode(type);
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeUint32(out, 8 + data.length, crc32(typeBytes, data));
  return out;
}

function writeUint32(target, offset, value) {
  target[offset] = (value >>> 24) & 255;
  target[offset + 1] = (value >>> 16) & 255;
  target[offset + 2] = (value >>> 8) & 255;
  target[offset + 3] = value & 255;
}

function writeUint16(target, offset, value) {
  target[offset] = (value >>> 8) & 255;
  target[offset + 1] = value & 255;
}

function crc32(typeBytes, data) {
  let crc = 0xffffffff;
  for (const byte of typeBytes) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function zlibStore(data) {
  const blockCount = Math.ceil(data.length / 65535);
  const out = new Uint8Array(2 + blockCount * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;

  let inputOffset = 0;
  let outputOffset = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const blockLength = Math.min(65535, data.length - inputOffset);
    const isFinal = block === blockCount - 1;
    out[outputOffset] = isFinal ? 1 : 0;
    outputOffset += 1;
    out[outputOffset] = blockLength & 255;
    out[outputOffset + 1] = (blockLength >>> 8) & 255;
    const onesComplement = (~blockLength) & 0xffff;
    out[outputOffset + 2] = onesComplement & 255;
    out[outputOffset + 3] = (onesComplement >>> 8) & 255;
    outputOffset += 4;
    out.set(data.subarray(inputOffset, inputOffset + blockLength), outputOffset);
    inputOffset += blockLength;
    outputOffset += blockLength;
  }

  writeUint32(out, outputOffset, adler32(data));
  return out;
}

function adler32(data) {
  const mod = 65521;
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % mod;
    b = (b + a) % mod;
  }
  return ((b << 16) | a) >>> 0;
}

function cleanFileName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function drawAmbientPreview() {
  const canvas = els.motionArt;
  const ctx = canvas.getContext("2d");

  const render = (time) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const t = time * 0.001;
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#17191f");
    gradient.addColorStop(0.45, "#231f26");
    gradient.addColorStop(1, "#10231f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const cx = width * 0.5;
    const cy = height * 0.46;
    const base = Math.min(width, height) * 0.28;

    for (let i = 0; i < 5; i += 1) {
      const angle = t * 0.75 + i * 1.256;
      const x = cx + Math.cos(angle) * base * 0.95;
      const y = cy + Math.sin(angle * 1.1) * base * 0.5;
      const radius = base * (0.16 + i * 0.025);
      const dot = ctx.createRadialGradient(x, y, 0, x, y, radius);
      dot.addColorStop(0, ["#ff6b57", "#ffc857", "#38e7b7", "#9d8cff", "#f7f4ec"][i]);
      dot.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.sin(t * 0.8) * 0.035);
    roundedRect(ctx, -base * 0.75, -base * 0.48, base * 1.5, base * 0.96, 18 * ratio);
    ctx.fillStyle = "rgba(247,244,236,0.92)";
    ctx.fill();
    roundedRect(ctx, -base * 0.64, -base * 0.36, base * 1.28, base * 0.72, 12 * ratio);
    const photo = ctx.createLinearGradient(-base * 0.64, -base * 0.36, base * 0.64, base * 0.36);
    photo.addColorStop(0, "#101114");
    photo.addColorStop(0.5, "#233a37");
    photo.addColorStop(1, "#ff6b57");
    ctx.fillStyle = photo;
    ctx.fill();
    ctx.fillStyle = "#ffc857";
    ctx.beginPath();
    ctx.arc(-base * 0.36, -base * 0.12, base * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(247,244,236,0.8)";
    ctx.lineWidth = 3 * ratio;
    ctx.beginPath();
    ctx.moveTo(-base * 0.54, base * 0.22);
    ctx.lineTo(-base * 0.08, -base * 0.08);
    ctx.lineTo(base * 0.16, base * 0.08);
    ctx.lineTo(base * 0.54, -base * 0.16);
    ctx.stroke();
    ctx.restore();

    requestAnimationFrame(render);
  };

  requestAnimationFrame(render);
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
