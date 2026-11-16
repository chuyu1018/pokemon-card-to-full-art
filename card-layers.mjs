// All preprocessing and final compositing use the visitor's browser.
// Only guide, detail and mask are needed by the image generator.
function canvas2d(width, height, readOften = false, alpha = true) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: readOften, alpha });
  if (!ctx) throw new Error('当前浏览器无法创建绘图画布。');
  return ctx;
}

function png(ctx) {
  return new Promise((resolve, reject) => ctx.canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('图片导出失败，请使用较小的原卡后重试。'));
  }, 'image/png'));
}

async function decode(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

function pixelBox(rect, width, height) {
  if (!rect || ![rect.x,rect.y,rect.w,rect.h].every(Number.isFinite) ||
      rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 ||
      rect.x + rect.w > 1.00001 || rect.y + rect.h > 1.00001) {
    throw new Error('请在原卡上框选完整的原插画。');
  }
  const x = Math.round(rect.x * width);
  const y = Math.round(rect.y * height);
  const w = Math.min(width, Math.round((rect.x + rect.w) * width)) - x;
  const h = Math.min(height, Math.round((rect.y + rect.h) * height)) - y;
  if (w < 4 || h < 4) throw new Error('选区太小，请重新框选完整的原插画。');
  return { x, y, w, h };
}

// Sample only the artwork. A low-resolution neutral matte tells the generator which
// areas need scenery, without giving it lettering or large original card panels.
function sceneColors(ctx) {
  const sample = canvas2d(32, 32, true);
  sample.drawImage(ctx.canvas, 0, 0, 32, 32);
  const data = sample.getImageData(0, 0, 32, 32).data;
  const bins = Array.from({ length: 64 }, () => [0, 0, 0, 0]);
  let lum = 0;
  for (let p = 0; p < data.length; p += 4) {
    const [r,g,b] = [data[p],data[p+1],data[p+2]];
    const high = Math.max(r,g,b), low = Math.min(r,g,b);
    lum += .299*r + .587*g + .114*b;
    const weight = 5 + (high - low) * (high < 235 && low > 12 ? 1 : .35);
    const bin = bins[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)];
    bin[0] += weight;
    bin[1] += r * weight;
    bin[2] += g * weight;
    bin[3] += b * weight;
  }
  const dominant = bins.reduce((a,b) => a[0] >= b[0] ? a : b);
  return {
    matte: Math.round(Math.min(172,Math.max(94,lum / 1024))),
    theme: dominant.slice(1).map(c => Math.round(25 + .66 * c / dominant[0]))
  };
}

// Integral images let each glyph be compared with its local paper color, including
// colored paper and gradients. Only contrasting ink gets composited over the new art.
function extractPrint(original, box) {
  const { width, height } = original.canvas;
  const out = canvas2d(width, height);
  const src = original.getImageData(0,0,width,height).data;
  const ink = out.createImageData(width,height), dst = ink.data;
  const stride = width + 1, count = stride * (height + 1);
  const red = new Uint32Array(count), green = new Uint32Array(count), blue = new Uint32Array(count);
  for (let y = 0; y < height; y++) {
    let rr = 0,gg = 0,bb = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4, j = (y + 1) * stride + x + 1;
      rr += src[p]; gg += src[p+1]; bb += src[p+2];
      red[j] = red[j-stride] + rr;
      green[j] = green[j-stride] + gg;
      blue[j] = blue[j-stride] + bb;
    }
  }
  const radius = Math.max(3,Math.round(width * .011));
  const startX = Math.max(1,Math.round(width * .043)), endX = width - startX;
  const titleTop = Math.round(height * .022), titleBottom = box.y - Math.max(1,Math.round(height * .003));
  // The narrow Pokédex / height / weight strip just below the art is removed.
  const attackTop = box.y + box.h + Math.round(height * .042), endY = Math.floor(height * .974);
  for (let y = titleTop; y < endY; y++) {
    const header = y < titleBottom;
    if (!header && y < attackTop) continue;
    const ya = Math.max(0,y-radius) * stride, yb = Math.min(height,y+radius+1) * stride;
    for (let x = startX; x < endX; x++) {
      const p = (y * width + x) * 4;
      const xa = Math.max(0,x-radius), xb = Math.min(width,x+radius+1);
      const a = ya+xa, b = ya+xb, c = yb+xa, d = yb+xb;
      const area = ((yb-ya)/stride)*(xb-xa);
      const r = src[p], g = src[p+1], bl = src[p+2];
      const dr = (red[d]-red[b]-red[c]+red[a])/area-r;
      const dg = (green[d]-green[b]-green[c]+green[a])/area-g;
      const db = (blue[d]-blue[b]-blue[c]+blue[a])/area-bl;
      const contrast = .299*dr + .587*dg + .114*db;
      const lum = .299*r + .587*g + .114*bl;
      // Dark letters, bright letters on dark cards and colorful type/energy symbols.
      let strength = Math.max(0,contrast - 15) * (lum < 145 ? 7 : 4);
      if (lum > 190) strength = Math.max(strength,(-contrast-25)*5);
      const symbolLane = header ? x > width*.73 : x < width*.24;
      if (symbolLane && Math.max(r,g,bl)-Math.min(r,g,bl) > 50) {
        const chromaContrast = Math.max(dr,dg,db)-Math.min(dr,dg,db);
        strength = Math.max(strength,(chromaContrast-35)*4);
      }
      if (strength <= 0) continue;
      dst[p]=r; dst[p+1]=g; dst[p+2]=bl; dst[p+3]=Math.min(255,strength);
    }
  }
  out.putImageData(ink,0,0);
  return out.canvas;
}

export async function prepareCardLayers(source, { rect, border = 'gray', brief = '' } = {}) {
  const img = await decode(source);
  const scale = Math.min(1,1536 / Math.max(img.width,img.height));
  const width = Math.round(img.width * scale), height = Math.round(img.height * scale);
  const original = canvas2d(width,height,true);
  try { original.drawImage(img,0,0,width,height); } finally { img.close?.(); }
  const box = pixelBox(rect,width,height);
  const detail = canvas2d(box.w,box.h);
  detail.drawImage(original.canvas, box.x,box.y,box.w,box.h, 0,0,box.w,box.h);
  const { matte,theme } = sceneColors(detail);
  const guide = canvas2d(width,height);
  guide.fillStyle = 'rgb(' + [matte,matte,matte].join(',') + ')';
  guide.fillRect(0,0,width,height);
  guide.drawImage(detail.canvas,box.x,box.y);
  const mask = canvas2d(width,height,false,false);
  mask.fillStyle = 'white'; mask.fillRect(0,0,width,height);
  const overlap = Math.min(2,Math.floor((Math.min(box.w,box.h)-1)/2));
  mask.fillStyle = 'black';
  mask.fillRect(box.x+overlap,box.y+overlap,box.w-2*overlap,box.h-2*overlap);
  const [guideBlob, detailBlob, maskBlob] = await Promise.all([png(guide),png(detail),png(mask)]);
  return {
    guide: guideBlob, detail: detailBlob, mask: maskBlob, width, height, rect:{...rect},
    box, border, brief, theme, art:detail.canvas, print:extractPrint(original,box)
  };
}

function roundedPath(ctx,x,y,w,h,r) {
  const radius = Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+radius,y); ctx.arcTo(x+w,y,x+w,y+h,radius);
  ctx.arcTo(x+w,y+h,x,y+h,radius); ctx.arcTo(x,y+h,x,y,radius);
  ctx.arcTo(x,y,x+w,y,radius); ctx.closePath();
}

export async function finishCardLayers(layers, scene) {
  const { width,height,box,art,print,border,theme } = layers;
  const image = await decode(scene), ctx = canvas2d(width,height,false,false);
  // Fill the target at its original aspect ratio. Models can round either side to
  // their pixel grid; a tiny scaling difference should not create empty bars.
  try { ctx.drawImage(image,0,0,width,height); } finally { image.close?.(); }
  const framed = border !== 'none' && border !== '无框';
  if (framed) {
    const margin = Math.min(box.x,box.y,width-box.x-box.w,height-box.y-box.h);
    const frameWidth = Math.min(Math.round(width*.033),Math.max(0,margin));
    if (frameWidth > 0) {
      const inset = frameWidth/2, radius = Math.max(2,width*.039);
      const themed = border === 'theme' || border === '主题色框';
      ctx.strokeStyle = themed ? 'rgb('+theme.join(',')+')' : '#343434';
      ctx.lineWidth = frameWidth;
      roundedPath(ctx,inset,inset,width-frameWidth,height-frameWidth,Math.max(1,radius-inset));
      ctx.stroke();
      ctx.save();
      // Keep the physical outer corners neat, including on a white preview background.
      ctx.globalCompositeOperation = 'destination-in';
      roundedPath(ctx,0,0,width,height,radius);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.save();
  ctx.shadowColor = 'rgba(255,252,235,.96)';
  ctx.shadowBlur = Math.max(1.3,width*.003);
  ctx.drawImage(print,0,0);
  ctx.restore();
  // The full source pixels win even in the two-pixel mask overlap.
  ctx.drawImage(art,box.x,box.y);
  return png(ctx);
}
