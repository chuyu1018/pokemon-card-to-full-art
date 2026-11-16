import { cardOutputSize } from './ark.mjs';
import { prepareCardLayers, finishCardLayers } from './card-layers.mjs';

export const PUBLIC_MODEL = 'FLUX.1 Fill [dev]';
const origin = 'https://black-forest-labs-flux-1-fill-dev.hf.space';
const base = origin + '/gradio_api';
const fetchOptions = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' };
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const templateURL = new URL('./skills/pokemon-card-to-full-art/references/prompt.md', import.meta.url);

async function readSceneTemplate(signal) {
  if (templateURL.protocol === 'file:' && typeof window === 'undefined') {
    const { readFile } = await import('node:fs/promises');
    return readFile(templateURL, 'utf8');
  }
  const response = await fetch(templateURL, { credentials: 'omit', signal });
  if (!response.ok) throw new Error('未能读取卡片续画模板，请刷新后再试。');
  return response.text();
}

function scenePrompt(template, brief) {
  const artRule = template.split(/\r?\n/).find(line => line.startsWith('原插画保护区与视觉锚点'));
  if (!artRule) throw new Error('卡片模板缺少原插画保护与续画要求。');
  return [
    brief ? 'Apply any relevant scenery notes while preserving the original subject and drawing a text-free continuous background: ' + brief : '',
    'A single uninterrupted edge-to-edge illustration, continuing the scene in the preserved artwork into the entire surrounding masked area. The completed scene fills every edge. Extend the ground or foreground all the way to the bottom and the sky or upper background all the way to the top. Continue the same scenery, contours, brush strokes, colors, lighting and perspective seamlessly on both sides.',
    'Keep the original subject exactly once, at its original position and scale inside the protected area. Draw only the surrounding environment. No new characters, text, logos, frames, margins, solid-color panels, smears or repeated textures. All white mask pixels require original painted scenery.',
    artRule,
  ].filter(Boolean).join('\n\n');
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
export async function generatePublicCard({ source, border = 'gray', brief = '', rect, signal, skill, onStatus = () => {} }) {
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
    onStatus('正在提取原插画并准备续画区域…');
    const notes = String(brief || '').trim();
    if (notes.length > 2000) throw new Error('补充要求请控制在 2000 字以内。');
    const [layers, template] = await Promise.all([
      prepareCardLayers(source, { rect, border, brief: notes }),
      skill?.template || readSceneTemplate(controller.signal)
    ]);
    controller.signal.throwIfAborted();
    cardOutputSize(layers.width, layers.height);
    const ratio = layers.width / layers.height;
    if (ratio < 9 / 16 || ratio > 16 / 9)
      throw new Error('公开扩图模型支持 9:16 至 16:9，请先裁出正面卡片。');
    // This Space recomputes both dimensions from the uploaded guide in multiples of eight.
    const scale = 1024 / Math.max(layers.width, layers.height);
    const width = Math.floor(Math.round(layers.width * scale) / 8) * 8;
    const height = Math.floor(Math.round(layers.height * scale) / 8) * 8;
    const prompt = scenePrompt(template, notes);
    const files = [[layers.guide, 'scene.png'], [layers.mask, 'mask.png']];
    const form = new FormData();
    for (const [blob, name] of files) form.append('files', blob, name);
    onStatus('正在上传构图底图和扩图蒙版…');
    const paths = await (await checked(base + '/upload', { ...network, method: 'POST', body: form })).json();
    if (!Array.isArray(paths) || paths.length !== files.length || paths.some(path => typeof path !== 'string' || !path))
      throw new Error('公开体验服务没有收齐续画所需的图片。');
    const [background, mask] = files.map(([blob, name], i) => ({
      path: paths[i], orig_name: name, mime_type: blob.type, meta: { _type: 'gradio.FileData' }
    }));
    const editor = { background, layers: [mask], composite: null };
    onStatus('已上传，正在进入生成队列…');
    const call = await (await checked(base + '/call/infer', {
      ...network, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [editor, prompt, 0, true, width, height, 30, 24] })
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
    onStatus('正在还原原画、原卡文字与外框…');
    const blob = await finishCardLayers(layers, new Blob([bytes], { type: mimeType }));
    controller.signal.throwIfAborted();
    return { blob, mimeType: blob.type, label: '全景卡效果预览' };
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
