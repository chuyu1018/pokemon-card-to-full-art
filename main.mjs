import { generateCard } from './ark.mjs';

const $ = id => document.getElementById(id);
const form = $('studio');
const sourceInput = $('source');
const uploadArea = $('upload-area');
const keyInput = $('api-key');
const isArk = () => form.querySelector('[name=engine]:checked').value === 'ark';
const drop = uploadArea.querySelector('.drop');
const sampleUrl = new URL('./examples/ponyta-original.jpg', import.meta.url);
const inputTypes = ['image/jpeg', 'image/png', 'image/webp'];
let selected = null;
let sourceUrl = '';
let resultUrl = '';
let loadingSource = false;
let selectionVersion = 0;
let controller = null;

function tell(message = '', error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function clearResult() {
  $('output').hidden = true;
  $('result').removeAttribute('src');
  $('download').removeAttribute('href');
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = '';
}

function clearSelection() {
  selectionVersion++;
  loadingSource = false;
  selected = null;
  sourceInput.value = '';
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = '';
  $('input-preview').removeAttribute('src');
  $('attachment').hidden = true;
  drop.hidden = false;
  sourceInput.tabIndex = 0;
  clearResult();
  tell();
}

function syncControls() {
  const busy = Boolean(controller);
  form.setAttribute('aria-busy', String(busy));
  for (const id of ['source', 'try-sample', 'remove-source', 'borders', 'brief', 'engines']) $(id).disabled = busy;
  keyInput.disabled = busy || !isArk();
  $('public-info').hidden = isArk();
  $('key-field').hidden = !isArk();
  $('generate').disabled = busy || loadingSource;
  $('generate').firstChild.textContent = busy ? '正在生成 ' : '生成预览 ';
  $('cancel').hidden = !busy;
}

// Each new selection supersedes a pending file decode or sample fetch.
async function chooseFile(readFile, sample = false) {
  if (controller) return false;
  const version = ++selectionVersion;
  loadingSource = true;
  syncControls();
  tell(sample ? '正在读取小火马原卡…' : '正在检查原卡图…');
  let url = '';
  try {
    const file = await readFile();
    if (!inputTypes.includes(file.type) || !file.size) throw new Error('请选择有效的 JPG、PNG 或 WebP 图片。');
    if (file.size > 8 * 1024 * 1024) throw new Error('参考图超过 8 MB，请缩小后再试。');
    url = URL.createObjectURL(file);
    const decoded = new Image();
    decoded.src = url;
    try { await decoded.decode(); }
    catch { throw new Error('浏览器无法读取这张图片，请重新导出原图后再试。'); }
    if (decoded.naturalWidth * decoded.naturalHeight > 64_000_000) throw new Error('参考图像素过大，请缩小到 6400 万像素以内。');
    if (version !== selectionVersion) return false;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = url;
    url = '';
    selected = file;
    $('input-preview').src = sourceUrl;
    $('filename').textContent = sample ? '小火马 · Generations 14' : file.name;
    drop.hidden = true;
    $('attachment').hidden = false;
    sourceInput.tabIndex = -1;
    clearResult();
    tell();
    return true;
  } catch (err) {
    if (version === selectionVersion) tell(err.message || '读取原卡失败，请重试。', true);
    return false;
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (version === selectionVersion) {
      loadingSource = false;
      syncControls();
    }
  }
}

$('engines').addEventListener('change', () => {
  if (!isArk()) keyInput.value = '';
  tell();
  syncControls();
});
syncControls();

sourceInput.addEventListener('change', () => {
  const file = sourceInput.files[0];
  if (file) void chooseFile(() => file);
});
$('remove-source').addEventListener('click', () => {
  clearSelection();
  syncControls();
  sourceInput.focus();
});
for (const event of ['dragenter', 'dragover']) uploadArea.addEventListener(event, e => {
  e.preventDefault();
  if (!controller) uploadArea.classList.add('drag');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag');
  if (controller) return;
  const files = e.dataTransfer.files;
  if (files.length !== 1) return tell('一次请选择一张原卡图。', true);
  const file = files[0];
  void chooseFile(() => file);
});

$('try-sample').addEventListener('click', async () => {
  const ok = await chooseFile(async () => {
    const response = await fetch(sampleUrl);
    if (!response.ok) throw new Error('小火马原卡读取失败，请上传一张卡图。');
    return new File([await response.blob()], 'ponyta-original.jpg', { type: 'image/jpeg' });
  }, true);
  if (!ok) return;
  if (!isArk() || keyInput.value.trim()) form.requestSubmit();
  else {
    tell('已选好小火马原卡。输入你的方舟 API Key，即可生成这张牌。');
    keyInput.focus();
  }
});

async function displayResult(blob, signal) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('生成服务没有返回有效图片。');
  const url = URL.createObjectURL(blob);
  try {
    const decoded = new Image();
    decoded.src = url;
    await decoded.decode();
    signal.throwIfAborted();
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[blob.type] || 'png';
    clearResult();
    resultUrl = url;
    $('result').src = url;
    $('download').href = url;
    $('download').download = '宝可梦全景卡.' + ext;
    $('output').hidden = false;
    $('result-title').focus({ preventScroll: true });
    $('output').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

$('cancel').addEventListener('click', () => controller?.abort());
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (controller || loadingSource) return;
  if (!selected) {
    tell('请先上传一张原卡，或点「用小火马试做」。', true);
    sourceInput.focus();
    return;
  }
  const apiKey = keyInput.value.trim();
  const useArk = isArk();
  if (useArk && !apiKey) {
    tell('请输入你的火山方舟 API Key，再开始生成。', true);
    keyInput.focus();
    return;
  }
  const border = form.querySelector('[name=border]:checked').value;
  const brief = $('brief').value.trim();
  const current = new AbortController();
  controller = current;
  clearResult();
  syncControls();
  tell(useArk ? '正在用火山方舟扩展画面，请保持页面打开。' : '正在连接公开模型并生成预览，共享队列可能需要几分钟。');
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 5 * 60 * 1000);
  try {
    const job = { source: selected, border, brief, signal: current.signal,
      onStatus: text => { if (!current.signal.aborted) tell(String(text)); } };
    const { blob } = useArk ? await generateCard({ ...job, apiKey })
      : await (await import('./public-model.mjs')).generatePublicCard(job);
    current.signal.throwIfAborted();
    await displayResult(blob, current.signal);
    tell('预览已生成。保存前可对照原卡检查卡名、数值和小字。');
  } catch (err) {
    if (current.signal.aborted) {
      if (useArk) tell(timedOut ? '等待已超过 5 分钟。方舟可能仍在处理，请先查看调用记录，再决定是否重新生成。'
        : '已停止等待。已发出的请求可能继续消耗方舟额度。', timedOut);
      else tell(timedOut ? '等待超过 5 分钟，请稍后重试或切换生图服务。' : '已停止等待，本次预览不会显示。', timedOut);
    } else {
      const message = String(err?.message || '请检查网络连接后重试。');
      const detail = (apiKey ? message.replaceAll(apiKey, '••••') : message).slice(0, 480);
      tell('生成失败。' + detail, true);
    }
  } finally {
    clearTimeout(timeout);
    controller = null;
    syncControls();
  }
});

window.addEventListener('pagehide', () => {
  keyInput.value = '';
  controller?.abort();
});
