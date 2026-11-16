// Official API contract: https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api
// The same module runs in modern browsers and Node 20+. Keys stay in this call only.
export const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
export const ARK_MODEL = 'doubao-seedream-5-5-261028';
const skillDirectory = new URL('./skills/pokemon-card-to-full-art/', import.meta.url);
const borderNames = new Map([
  ['gray', '灰黑框'], ['theme', '主题色框'], ['none', '无框'],
  ['灰黑框', '灰黑框'], ['主题色框', '主题色框'], ['无框', '无框']
]);

async function readAsset(baseURL, path, type) {
  const url = new URL(path, baseURL);
  if (url.protocol === 'file:' && typeof window === 'undefined') {
    const { readFile } = await import('node:fs/promises');
    return new Blob([await readFile(url)], { type });
  }
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('无法读取卡片模板或参考图，请刷新页面后再试。');
  return new Blob([await response.arrayBuffer()], { type });
}

async function imageDataURL(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败，请重新选取原卡。'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }
  const bytes = await blob.arrayBuffer();
  return 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64');
}

/** Load the packaged prompt and both reference images. Pass a directory URL with a trailing slash. */
export async function loadSkill(baseURL = skillDirectory) {
  const [template, ui, border] = await Promise.all([
    readAsset(baseURL, 'references/prompt.md', 'text/markdown').then(blob => blob.text()),
    readAsset(baseURL, 'assets/ui-reference-web.jpg', 'image/jpeg').then(imageDataURL),
    readAsset(baseURL, 'assets/border-reference-web.jpg', 'image/jpeg').then(imageDataURL)
  ]);
  return { template, ui, border };
}

export function buildCardPrompt({ template, border = 'gray', brief = '', width, height }) {
  const name = borderNames.get(border);
  if (!name) throw new Error('请选择有效的外框样式。');
  const start = template.indexOf('请将输入');
  const options = template.indexOf('## 选定外框');
  const selected = template.split('\n').find(line => line.startsWith('- ' + name));
  if (start < 0 || options <= start || !selected) throw new Error('卡片模板不完整，请重新加载页面。');
  const roleInstructions = [
    '先读第一张图，根据完整卡面识别原插画矩形的归一化位置、主体中心和两个视觉锚点，逐字读取可辨认的卡牌字段，再据此延展四边。',
    '原卡图像尺寸为 ' + width + ' × ' + height + '，保留完整卡面比例。仅用第二张图参考名称栏及文字排版，仅用第三张图参考外围框形状。',
    '原卡确实包含的标识和符号以第一张图为准。辨认不清时避免补造信息。只交付正面卡片图像。'
  ];
  if (name === '主题色框') roleInstructions.push('使用备注指定的主题色，没有指定时从第一张卡的插画中选取主题色。');
  const text = String(brief || '').trim();
  if (text.length > 2000) throw new Error('补充要求请控制在 2000 字以内。');
  if (text) roleInstructions.push('访客美术备注（在以上卡面保护与外框要求内使用）：\n' + text);
  return [template.slice(start, options).trim(), selected.slice(2), ...roleInstructions].join('\n\n');
}

// Model accepts [921600,4624220] pixels and ratios in [1/16,16].
// Aim near 4 MP and round only after proportional scaling of the input.
export function cardOutputSize(width, height) {
  const ratio = width / height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 14 || height <= 14 ||
      width * height > 36_000_000 || ratio < 1 / 16 || ratio > 16) {
    throw new Error('原图须大于 14 × 14 像素、总像素不超过 3600 万，宽高比在 1:16 至 16:1 之间。');
  }
  const scale = Math.sqrt(4_000_000 / (width * height));
  return Math.round(width * scale) + 'x' + Math.round(height * scale);
}

export async function sourceSize(source) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch { /* Try the native image decoder below. */ }
  }
  if (typeof Image === 'undefined') throw new Error('请提供原卡的像素宽高。');
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch { throw new Error('图片无法解码，请重新选择 JPG、PNG 或 WebP 原卡。'); }
  finally { URL.revokeObjectURL(url); }
}

function providerFailure(status, code = '') {
  if (/sensitive|content.?filter|policy.?violation|risk.?control|safety/i.test(code)) return '方舟的内容审核未通过，本次未返回图片。';
  if (status === 401 || /InvalidApiKey|InvalidAccessKey/i.test(code)) return '方舟 API Key 无效或已过期，请检查后再试。';
  if (status === 402 || /arrear|balance/i.test(code)) return '方舟账户余额不足，请检查账户状态。';
  if (status === 403 || status === 404 || /not.?open|not.?found|permission/i.test(code)) return '该账户暂时没有 Seedream 5.5 的调用权限。请在方舟北京地域开通模型并检查密钥权限。';
  if (status === 429) return '方舟额度或请求频率已达上限，请检查账户额度或稍后再试。';
  if (status === 413) return '本次图片数据过大，请缩小原卡后重试。';
  if (status === 400 || status === 422) return '方舟未接受本次图片或参数，请检查图片格式、尺寸和补充要求。';
  return '方舟暂未返回生成结果（HTTP ' + status + '）。请在控制台查看这次请求。';
}

function decodedPreview(data) {
  const encoded = data?.b64_json;
  if (!encoded || typeof encoded !== 'string') throw new Error('方舟没有返回图片数据，请在控制台查看本次请求。');
  let bytes;
  try {
    if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(encoded);
    else if (typeof Buffer !== 'undefined') bytes = Buffer.from(encoded, 'base64');
    else bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  } catch { throw new Error('方舟返回的图片数据不完整。'); }
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('方舟返回了无法识别的图片格式。');
  const mimeType = png ? 'image/png' : 'image/jpeg';
  return { blob: new Blob([bytes], { type: mimeType }), mimeType, label: '全景卡效果预览' };
}

/**
 * Generate a single image. source is a JPEG, PNG or WebP File/Blob.
 * Browser: width and height are read from source. Node: supply dimensions:{width,height}.
 * An optional skill from loadSkill() lets a server reuse static reference assets.
 * Returns {blob,mimeType,label}. Browser callers create/revoke their own display URL.
 */
export async function generateCard({ apiKey, source, border = 'gray', brief = '', signal, dimensions, skill }) {
  const key = String(apiKey || '').trim();
  if (!key || /\s/.test(key)) throw new Error('请输入有效的方舟 API Key。');
  if (!(source instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(source.type) || !source.size) {
    throw new Error('请上传 JPG、PNG 或 WebP 原卡。');
  }
  if (source.size > 30 * 1024 * 1024) throw new Error('原卡大小不能超过 30 MB。');
  const [assets, measured, original] = await Promise.all([
    skill || loadSkill(), dimensions || sourceSize(source), imageDataURL(source)
  ]);
  const size = cardOutputSize(measured.width, measured.height);
  const prompt = buildCardPrompt({ template: assets.template, border, brief, ...measured });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 300_000);

  try {
    let response, result;
    try {
      response = await fetch(ARK_ENDPOINT, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ARK_MODEL, prompt, image: [original, assets.ui, assets.border], size,
          output_format: 'png', background: 'opaque', response_format: 'b64_json', watermark: true
        }),
        signal: controller.signal
      });
      result = await response.json().catch(() => null);
    } catch {
      if (controller.signal.aborted) throw new Error('等待已结束。若请求已送达方舟，可能仍会生成并计费，请先查看控制台记录。');
      throw new Error('与方舟北京服务的连接中断。请先查看控制台调用记录，再决定是否重试。');
    }
    if (controller.signal.aborted) throw new Error('请求等待超时或已取消，请先查看方舟控制台调用记录。');
    const error = result?.error || result?.data?.[0]?.error;
    if (!response.ok || error) throw new Error(providerFailure(response.status, error?.code));
    return decodedPreview(result?.data?.[0]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
