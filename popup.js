const buttons = document.querySelectorAll('.action');
const expand = document.getElementById('expand');
const progress = document.getElementById('progress');
const fill = document.getElementById('fill');
const progressText = document.getElementById('progress-text');
const error = document.getElementById('error');

const qualityInputs = document.querySelectorAll('input[name="quality"]');
const qualityHint = document.getElementById('quality-hint');
const QUALITY_HINTS = {
  1: 'Same as your screen, fastest',
  2: 'Sharp, Retina-like detail',
  3: 'Maximum detail, larger files',
};

chrome.storage.local.get({ expand: true, quality: 2 }).then((prefs) => {
  expand.checked = prefs.expand;
  selectQuality(prefs.quality);
});
expand.addEventListener('change', () => chrome.storage.local.set({ expand: expand.checked }));
qualityInputs.forEach((input) =>
  input.addEventListener('change', () => {
    selectQuality(Number(input.value));
    chrome.storage.local.set({ quality: Number(input.value) });
  })
);

function selectQuality(value) {
  qualityInputs.forEach((input) => (input.checked = Number(input.value) === value));
  qualityHint.textContent = QUALITY_HINTS[value];
}

function selectedQuality() {
  return Number(document.querySelector('input[name="quality"]:checked')?.value ?? 2);
}

document.getElementById('full').addEventListener('click', () => capture('full'));
document.getElementById('visible').addEventListener('click', () => capture('visible'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'progress') return;
  progress.classList.remove('indeterminate');
  fill.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
  progressText.textContent = `Capturing section ${msg.done} of ${msg.total}…`;
});

async function capture(mode) {
  buttons.forEach((b) => (b.disabled = true));
  error.hidden = true;
  progress.hidden = false;
  progress.classList.add('indeterminate');
  progressText.textContent =
    mode === 'full' ? 'Preparing page… keep this tab in front.' : 'Capturing…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({
    type: 'capture',
    mode,
    tabId: tab.id,
    expand: expand.checked,
    quality: selectedQuality(),
  });

  // On success the result tab opens and this popup closes on its own.
  if (!res?.ok) {
    progress.hidden = true;
    error.textContent = friendlyError(res?.error);
    error.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

function friendlyError(message = 'Capture failed.') {
  if (/cannot access|cannot be scripted|chrome:\/\/|extensions gallery/i.test(message)) {
    return "Chrome doesn't allow screenshots of this page (browser or Web Store pages). Try a regular website.";
  }
  return message;
}
