import { buildCardPrompt, cardOutputSize, loadSkill, sourceSize } from './ark.mjs';

export const PUBLIC_MODEL = 'FLUX.2 [klein] 4B';
const origin = 'https://black-forest-labs-flux-2-klein-4b.hf.space';
const base = origin + '/gradio_api';
const fetchOptions = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' };
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function referenceBlob(dataURL) {
  const header = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(dataURL);
  if (!header) throw new Error('卡片参考图没有加载完整。');
  const raw = atob(dataURL.slice(header[0].length));
  return new Blob([Uint8Array.from(raw, char => char.charCodeAt(0))], { type: header[1] });
}

function serviceFailure(status, detail) {
  if (status === 429 || /quota|zerogpu|rate.limit/i.test(detail))
    return new Error('公开体验的 GPU 额度或请求次数已达上限，请稍后再试。');
  if (status === 503 || /queue.*full/i.test(detail))
    return new Error('公开体验服务正在排队或暂未就绪，请稍后再试。');
  if (status === 413) return new Error('公开体验服务未接受该文件大小，请缩小原卡后重试。');
  if (status === 401 || status === 403) return new Error('公开体验服务暂时不接受当前网络的请求。');
  return new Error('公开体验服务未能完成本次生成。' + (status ? '（HTTP ' + status + '）' : ''));
}

async function checked(url, options) {
  const response = await fetch(url, { ...fetchOptions, ...options });
  if (!response.ok) throw serviceFailure(response.status, (await response.text()).slice(0, 1800));
  return response;
}

async function receiveResult(response, onStatus) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const lines = buffer.slice(0, separator.index).split(/\r?\n/);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (event === 'error') throw serviceFailure(0, data);
        if (event === 'generating') onStatus('模型正在绘制全景卡…');
        if (event === 'complete') {
          const url = JSON.parse(data)?.[0]?.url;
          if (!url || !url.startsWith(base + '/file=')) throw new Error('服务未返回可下载的预览图。');
          return url;
        }
      }
      if (done) throw new Error('公开体验服务的连接已结束，暂时没有收到结果。');
      if (buffer.length > 2_000_000) throw new Error('公开体验服务返回了异常数据。');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

// Gradio uses the event ID as the session hash when none is sent by the caller.
async function cancelJob(eventID) {
  const signal = AbortSignal.timeout(4500);
  const config = await (await checked(origin + '/config', { signal })).json();
  const fn = config.dependencies?.find(entry => entry.api_name === 'infer');
  if (fn) await checked(base + '/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ event_id: eventID, session_hash: eventID, fn_index: fn.id })
  });
}

/** Uses the published Gradio API. No credentials are accepted or forwarded. */
export async function generatePublicCard({ source, border = 'gray', brief = '', signal, dimensions, skill, onStatus = () => {} }) {
  if (!(source instanceof Blob) || !extensions[source.type] || !source.size || source.size > 30 * 1024 * 1024)
    throw new Error('请上传 30 MB 以内的 JPG、PNG 或 WebP 原卡。');
  const controller = new AbortController();
  let timedOut = false, eventID = null, finished = false;
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(() => { timedOut = true; stop(); }, 300_000);
  const network = { signal: controller.signal };
  try {
    controller.signal.throwIfAborted();
    onStatus('正在读取原卡和两张参考图…');
    const [assets, size] = await Promise.all([skill || loadSkill(), dimensions || sourceSize(source)]);
    cardOutputSize(size.width, size.height);
    const scale = 1024 / Math.max(size.width, size.height);
    const rounded = length => Math.min(1024, Math.max(256, Math.round(length * scale / 16) * 16));
    const width = rounded(size.width), height = rounded(size.height);
    if (Math.abs(Math.log((width / height) / (size.width / size.height))) > 0.05)
      throw new Error('原卡比例过宽或过高，公开模型无法保留其比例。请先裁出正面卡片。');
    const names = { gray: 'a visible rounded charcoal gray outer border', theme: 'a rounded border in the requested or card theme color', none: 'no outer border at all' };
    const prompt = [
      'Edit image 1 into one complete, front-facing full-art Pokémon trading card. Extend the illustration into the surrounding areas, replacing the old solid panels. Keep the original illustration anchored at the same position, scale and framing. Preserve EVERY original card word in its original language, HP, moves, energy symbols, card number and artist. Text sits directly on the extended artwork. For the outside edge use ' + names[border] + '.',
      'Image 2 is a UI-layout reference only. Image 3 is an outer-border shape reference only. The only Pokémon, data and scene in the result are those from image 1. Keep all four card edges in frame.',
      brief ? 'Requested visual detail: ' + String(brief).trim() : '',
      buildCardPrompt({ template: assets.template, border, brief, ...size })
    ].filter(Boolean).join('\n\n');
    const ui = referenceBlob(assets.ui), edge = referenceBlob(assets.border);
    const files = [
      [source, 'source.' + extensions[source.type]], [ui, 'ui.' + extensions[ui.type]], [edge, 'border.' + extensions[edge.type]]
    ];
    const form = new FormData();
    for (const [blob, name] of files) form.append('files', blob, name);
    onStatus('正在上传原卡和两张参考图…');
    const paths = await (await checked(base + '/upload', { ...network, method: 'POST', body: form })).json();
    if (!Array.isArray(paths) || paths.length !== 3 || paths.some(path => typeof path !== 'string' || !path))
      throw new Error('公开体验服务没有收齐三张图片。');
    const gallery = files.map(([blob, name], i) => ({
      image: { path: paths[i], orig_name: name, mime_type: blob.type, meta: { _type: 'gradio.FileData' } }, caption: null
    }));
    onStatus('已上传，正在进入生成队列…');
    const call = await (await checked(base + '/call/infer', {
      ...network, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [prompt, gallery, 'Distilled (4 steps)', 0, true, width, height, 4, 1, false] })
    })).json();
    if (!call.event_id || typeof call.event_id !== 'string') throw new Error('公开体验服务未接收任务。');
    eventID = call.event_id;
    onStatus('任务已提交，正在等待模型生成…');
    const stream = await checked(base + '/call/infer/' + encodeURIComponent(eventID), network);
    const url = await receiveResult(stream, onStatus);
    finished = true;
    onStatus('正在接收图片…');
    const bytes = new Uint8Array(await (await checked(url, network)).arrayBuffer());
    const tag = offset => String.fromCharCode(...bytes.slice(offset, offset + 4));
    const mimeType = tag(0) === 'RIFF' && tag(8) === 'WEBP' ? 'image/webp' :
      bytes[0] === 137 && tag(1).startsWith('PNG') ? 'image/png' :
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
    if (!mimeType) throw new Error('公开体验服务返回的图片数据不完整。');
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, label: '全景卡效果预览' };
  } catch (error) {
    if (controller.signal.aborted) {
      if (eventID && !finished) void cancelJob(eventID).catch(() => {});
      throw new Error(timedOut ? '公开体验等待超过 5 分钟，请稍后再试。' : '本次等待已取消。');
    }
    if (error instanceof TypeError) throw new Error('无法连接公开模型服务，请检查网络后再试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
  }
}
