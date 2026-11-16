// Relative to the complete, correctly oriented source image.
const typical = { x: 0.09, y: 0.12, w: 0.82, h: 0.38 };
const sampleArea = { x: 64 / 734, y: 108 / 1024, w: 605 / 734, h: 398 / 1024 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function findEdge(pixels, width, height, axis, range, span, expected) {
  const horizontal = axis === 'y';
  const length = horizontal ? height : width;
  const crossLength = horizontal ? width : height;
  const start = Math.round(span[0] * crossLength);
  const end = Math.round(span[1] * crossLength);
  let best = expected, bestScore = 11;
  for (let i = Math.max(1, Math.round(length * range[0])); i < length * range[1]; i++) {
    const buckets = Array(6).fill(0);
    const counts = Array(6).fill(0);
    for (let j = start; j < end; j++) {
      const index = 4 * (horizontal ? i * width + j : j * width + i);
      const prev = index - (horizontal ? width * 4 : 4);
      const delta = (Math.abs(pixels[index] - pixels[prev])
        + Math.abs(pixels[index + 1] - pixels[prev + 1])
        + Math.abs(pixels[index + 2] - pixels[prev + 2])) / 3;
      const part = Math.floor((j - start) * 6 / (end - start));
      buckets[part] += Math.min(86, delta);
      counts[part]++;
    }
    const levels = buckets.map((sum, j) => sum / Math.max(1, counts[j])).sort((a, b) => a - b);
    // Real card edges tend to continue across most of the artwork, unlike text and subject contours.
    const straightness = (levels[1] + levels[2] + levels[3]) / 3;
    const score = straightness * (1 - .3 * Math.abs(i / length - expected) / (range[1] - range[0]));
    if (score > bestScore) { bestScore = score; best = i / length; }
  }
  return best;
}

export function estimateArtRegion(image) {
  const ratio = image.naturalWidth / image.naturalHeight;
  if (ratio < .44 || ratio > 1.03) return { ...typical };
  const canvas = document.createElement('canvas');
  canvas.height = Math.min(512, image.naturalHeight);
  canvas.width = Math.max(1, Math.round(canvas.height * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width < 40 || canvas.height < 50) return { ...typical };
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const edge = (...args) => findEdge(pixels, canvas.width, canvas.height, ...args);
  const top = edge('y', [.06, .23], [.20, .80], typical.y);
  const bottom = edge('y', [.39, .65], [.20, .80], typical.y + typical.h);
  const probe = [top + .035, bottom - .035];
  const left = edge('x', [.045, .205], probe, typical.x);
  const right = edge('x', [.795, .955], probe, typical.x + typical.w);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function makeRegionEditor(container, isBusy) {
  const stage = container.querySelector('.region-stage');
  const source = stage.querySelector('img');
  const box = stage.querySelector('.region-box');
  const handles = [...box.querySelectorAll('[data-corner]')];
  const reset = container.querySelector('.region-reset');
  let initial = { ...typical }, area = { ...typical };
  let gesture = null;
  function render() {
    Object.assign(box.style, {
      left: area.x * 100 + '%', top: area.y * 100 + '%',
      width: area.w * 100 + '%', height: area.h * 100 + '%'
    });
  }
  function locate(event) {
    const b = stage.getBoundingClientRect();
    return { x: clamp((event.clientX - b.left) / b.width, 0, 1), y: clamp((event.clientY - b.top) / b.height, 0, 1) };
  }
  function cornerPoint(corner) {
    return { x: area.x + (corner.includes('e') ? area.w : 0), y: area.y + (corner.includes('s') ? area.h : 0) };
  }
  const opposite = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };
  function updateArea(anchor, end) {
    const w = Math.abs(anchor.x - end.x), h = Math.abs(anchor.y - end.y);
    if (w < .04 || h < .035) return;
    area = { x: Math.min(anchor.x, end.x), y: Math.min(anchor.y, end.y), w, h };
    render();
  }
  stage.addEventListener('pointerdown', e => {
    if (isBusy() || !e.isPrimary || e.button !== 0 || gesture) return;
    const point = locate(e);
    const corner = e.target.closest('[data-corner]')?.dataset.corner;
    gesture = { id: e.pointerId, anchor: corner ? cornerPoint(opposite[corner]) : point, previous: { ...area } };
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', e => {
    if (gesture?.id === e.pointerId && !isBusy()) updateArea(gesture.anchor, locate(e));
  });
  function endGesture(e, canceled) {
    if (gesture?.id !== e.pointerId) return;
    if (canceled) { area = gesture.previous; render(); }
    else if (!isBusy()) updateArea(gesture.anchor, locate(e));
    gesture = null;
  }
  stage.addEventListener('pointerup', e => endGesture(e, false));
  stage.addEventListener('pointercancel', e => endGesture(e, true));
  stage.addEventListener('lostpointercapture', e => endGesture(e, true));
  const nudges = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  for (const handle of handles) handle.addEventListener('keydown', e => {
    const movement = nudges[e.key];
    if (!movement || isBusy()) return;
    e.preventDefault();
    const c = handle.dataset.corner, p = cornerPoint(c), step = e.shiftKey ? .02 : .003;
    const target = { x: clamp(p.x + movement[0] * step, 0, 1), y: clamp(p.y + movement[1] * step, 0, 1) };
    updateArea(cornerPoint(opposite[c]), target);
  });
  reset.addEventListener('click', () => {
    if (!isBusy()) { area = { ...initial }; render(); }
  });
  return {
    load(image, sample) {
      initial = sample ? { ...sampleArea } : estimateArtRegion(image);
      area = { ...initial };
      source.src = image.src;
      container.open = false;
      render();
    },
    clear() { container.open = false; source.removeAttribute('src'); },
    update(visible, disabled) {
      container.hidden = !visible;
      if (!visible) container.open = false;
      for (const control of [reset, ...handles]) control.disabled = disabled;
    },
    getRect() { return { ...area }; }
  };
}
