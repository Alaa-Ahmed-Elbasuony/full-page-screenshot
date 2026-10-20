// Chrome canvas limits: max side length and max total pixel area.
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_AREA = 268_000_000;

const $ = (id) => document.getElementById(id);

const id = new URLSearchParams(location.search).get('id');
const data = await chrome.runtime.sendMessage({ type: 'getCapture', id });

if (data) {
  await render(data);
} else {
  document.body.classList.remove('loading');
  $('title').textContent = 'Screenshot not available';
  $('meta').textContent = 'It may have expired. Take a new one from the toolbar icon.';
}

async function render(data) {
  const canvas = await stitch(data);
  const blob = await toBlob(canvas, 'image/png');
  const host = safeHost(data.url);
  const baseName = `screenshot-${host}-${timestamp()}`;

  $('preview').src = URL.createObjectURL(blob);
  $('title').textContent = data.title || host;
  $('meta').textContent = [
    host,
    `${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px`,
    formatBytes(blob.size),
  ].join('  ·  ');
  document.title = `Screenshot – ${data.title || host}`;

  const notices = [];
  if (data.truncated) {
    notices.push('This page is very long, so the screenshot stops after the first 30,000 pixels.');
  }
  if (canvas.downscaled) {
    notices.push('The page was too large for full resolution, so the image was scaled down to fit Chrome\'s image size limit.');
  }
  if (data.hdUnavailable) {
    notices.push('HD capture was unavailable on this tab (another debugger is attached), so screen quality was used.');
  }
  if (notices.length) {
    $('notice').textContent = notices.join(' ');
    $('notice').hidden = false;
  }

  $('download-png').addEventListener('click', () => saveBlob(blob, `${baseName}.png`));
  $('download-jpg').addEventListener('click', async () => {
    saveBlob(await toBlob(canvas, 'image/jpeg', 0.97), `${baseName}.jpg`);
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied to clipboard');
    } catch {
      toast('Could not copy. Try downloading instead.');
    }
  });

  const toggleZoom = () => {
    const fit = $('preview').classList.toggle('fit');
    $('zoom').querySelector('span').textContent = fit ? 'Actual size' : 'Fit to window';
  };
  $('zoom').addEventListener('click', toggleZoom);
  $('preview').addEventListener('click', toggleZoom);

  // Shown at 1:1 CSS pixels in "actual size" mode.
  $('preview').style.width = `${canvas.width / devicePixelRatio}px`;

  $('buttons').hidden = false;
  document.body.classList.remove('loading');
}

async function stitch({ frames, width, height, viewWidth }) {
  const images = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
  const first = images[0];

  // Captured pixels per CSS pixel (accounts for devicePixelRatio and zoom).
  const scale = viewWidth ? first.naturalWidth / viewWidth : 1;
  const fullWidth = width ? Math.round(width * scale) : first.naturalWidth;
  const fullHeight = height ? Math.round(height * scale) : first.naturalHeight;

  const fit = Math.min(
    1,
    MAX_CANVAS_SIDE / fullWidth,
    MAX_CANVAS_SIDE / fullHeight,
    Math.sqrt(MAX_CANVAS_AREA / (fullWidth * fullHeight))
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(fullWidth * fit);
  canvas.height = Math.floor(fullHeight * fit);
  canvas.downscaled = fit < 1;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Crops are in CSS px; source pixels are CSS px * scale, output pixels add the fit factor.
  // Edges are rounded independently so neighbouring slices meet without 1px gaps or blur.
  const k = scale * fit;
  frames.forEach((frame, i) => {
    const img = images[i];
    if (!frame.crops) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return;
    }
    for (const c of frame.crops) {
      if (c.sw <= 0 || c.sh <= 0) continue;
      const sx = Math.round(c.sx * scale);
      const sy = Math.round(c.sy * scale);
      const sw = Math.min(img.naturalWidth, Math.round((c.sx + c.sw) * scale)) - sx;
      const sh = Math.min(img.naturalHeight, Math.round((c.sy + c.sh) * scale)) - sy;
      const dx = Math.round(c.dx * k);
      const dy = Math.round(c.dy * k);
      const dw = Math.round((c.dx + c.sw) * k) - dx;
      const dh = Math.round((c.dy + c.sh) * k) - dy;
      if (sw > 0 && sh > 0) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  });

  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function safeHost(url) {
  try {
    return new URL(url).hostname || 'page';
  } catch {
    return 'page';
  }
}
