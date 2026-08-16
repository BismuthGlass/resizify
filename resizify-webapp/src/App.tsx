import { Component, Show, createSignal, onCleanup, onMount } from 'solid-js';

type ImageInfo = { id: string; name: string; width: number; height: number; url: string };
type Frame = { x: number; y: number; w: number; h: number };
type Drag = { kind: 'frame' | 'pan' | 'resize'; handle?: string; sx: number; sy: number; frame: Frame; panX: number; panY: number };
type OutputInfo = { name: string; url: string; created: string };

const ratios = [{ label: '1 : 1', value: 1 }, { label: '4 : 3', value: 4 / 3 }, { label: '3 : 2', value: 3 / 2 }, { label: '16 : 9', value: 16 / 9 }];

const App: Component = () => {
  let editor!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [image, setImage] = createSignal<ImageInfo>();
  const [frame, setFrame] = createSignal<Frame>({ x: 0, y: 0, w: 1, h: 1 });
  const [ratioIndex, setRatioIndex] = createSignal(1);
  const [vertical, setVertical] = createSignal(false);
  const [clamp, setClamp] = createSignal(true);
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [viewport, setViewport] = createSignal({ w: 900, h: 600 });
  const [drag, setDrag] = createSignal<Drag>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [dropActive, setDropActive] = createSignal(false);
  const [outputs, setOutputs] = createSignal<OutputInfo[]>([]);
  const [preview, setPreview] = createSignal<OutputInfo>();
  let spaceDown = false;
  let observer: ResizeObserver | undefined;

  const editorRef = (element: HTMLDivElement) => {
    editor = element;
    observer?.disconnect();
    observer = new ResizeObserver(([entry]) => setViewport({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(element);
  };

  const activeRatio = () => {
    const r = ratios[ratioIndex()].value;
    return vertical() ? 1 / r : r;
  };
  const baseScale = () => {
    const img = image();
    if (!img) return 1;
    return Math.min((viewport().w - 80) / img.width, (viewport().h - 80) / img.height);
  };
  const scale = () => baseScale() * zoom();
  const origin = () => {
    const img = image();
    if (!img) return { x: 0, y: 0 };
    return { x: (viewport().w - img.width * scale()) / 2 + pan().x, y: (viewport().h - img.height * scale()) / 2 + pan().y };
  };
  const screenFrame = () => {
    const f = frame(), o = origin(), s = scale();
    return { x: o.x + f.x * s, y: o.y + f.y * s, w: f.w * s, h: f.h * s };
  };

  const fittedFrame = (img: ImageInfo, r: number, mode: 'cover' | 'contain'): Frame => {
    let w: number, h: number;
    if ((mode === 'cover' && img.width / img.height > r) || (mode === 'contain' && img.width / img.height < r)) {
      h = img.height; w = h * r;
    } else { w = img.width; h = w / r; }
    return { x: (img.width - w) / 2, y: (img.height - h) / 2, w, h };
  };
  const fitFrame = (mode: 'cover' | 'contain', ratio = activeRatio()) => {
    const img = image(); if (!img) return;
    const next = fittedFrame(img, ratio, mode);
    setFrame(next);
    if (mode === 'contain' && (next.w > img.width || next.h > img.height)) setClamp(false);
  };
  const bestRatioIndex = (img: ImageInfo, isVertical: boolean) => {
    let bestIndex = 0;
    let largestArea = -1;
    ratios.forEach((candidate, index) => {
      const r = isVertical ? 1 / candidate.value : candidate.value;
      const fitted = fittedFrame(img, r, 'cover');
      const area = fitted.w * fitted.h;
      if (area > largestArea) { bestIndex = index; largestArea = area; }
    });
    return bestIndex;
  };

  const chooseRatio = (index: number) => {
    setRatioIndex(index);
    const r = ratios[index].value;
    fitFrame('cover', vertical() ? 1 / r : r);
  };
  const flip = () => {
    const nextVertical = !vertical();
    setVertical(nextVertical);
    const r = ratios[ratioIndex()].value;
    fitFrame('cover', nextVertical ? 1 / r : r);
  };
  const center = () => { const img = image(); if (!img) return; const f = frame(); setFrame({ ...f, x: (img.width - f.w) / 2, y: (img.height - f.h) / 2 }); };
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const upload = async (file?: File) => {
    if (!file || !file.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    setBusy(true); setError(''); setMessage('');
    const data = new FormData(); data.append('image', file);
    try {
      const response = await fetch('/api/upload', { method: 'POST', body: data });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Upload failed');
      if (image()) fetch(`/api/images/${image()!.id}`, { method: 'DELETE' });
      const uploaded = body as ImageInfo;
      const startsVertical = uploaded.height > uploaded.width;
      const initialRatioIndex = bestRatioIndex(uploaded, startsVertical);
      const r = ratios[initialRatioIndex].value;
      setImage(uploaded);
      setRatioIndex(initialRatioIndex);
      setVertical(startsVertical);
      setFrame(fittedFrame(uploaded, startsVertical ? 1 / r : r, 'cover'));
      setClamp(true);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed'); }
    finally { setBusy(false); if (input) input.value = ''; }
  };

  const close = () => {
    const img = image(); if (img) fetch(`/api/images/${img.id}`, { method: 'DELETE' });
    setImage(undefined); setMessage(''); setError('');
  };

  const loadOutputs = async () => {
    try {
      const response = await fetch('/api/outputs');
      if (response.ok) setOutputs(await response.json());
    } catch {}
  };

  const openOutput = async () => {
    setError('');
    try {
      const response = await fetch('/api/open-output', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not open output directory');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open output directory'); }
  };

  const save = async () => {
    const img = image(); if (!img) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const f = frame();
      const response = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: img.id, x: f.x, y: f.y, width: f.w, height: f.h }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Save failed');
      setMessage(`Saved ${body.name}`);
      await loadOutputs();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  };

  const localPoint = (e: PointerEvent) => { const box = editor.getBoundingClientRect(); return { x: e.clientX - box.left, y: e.clientY - box.top }; };
  const startDrag = (e: PointerEvent, kind: Drag['kind'], handle?: string) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault(); editor.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    setDrag({ kind: e.button === 1 || spaceDown ? 'pan' : kind, handle, sx: p.x, sy: p.y, frame: { ...frame() }, panX: pan().x, panY: pan().y });
  };
  const moveDrag = (e: PointerEvent) => {
    const d = drag(), img = image(); if (!d || !img) return;
    const p = localPoint(e), dx = (p.x - d.sx) / scale(), dy = (p.y - d.sy) / scale();
    if (d.kind === 'pan') { setPan({ x: d.panX + p.x - d.sx, y: d.panY + p.y - d.sy }); return; }
    if (d.kind === 'frame') {
      let x = d.frame.x + dx, y = d.frame.y + dy;
      if (clamp()) { x = Math.max(0, Math.min(img.width - d.frame.w, x)); y = Math.max(0, Math.min(img.height - d.frame.h, y)); }
      setFrame({ ...d.frame, x, y }); return;
    }
    const h = d.handle!, r = activeRatio();
    const left = d.frame.x, right = d.frame.x + d.frame.w, top = d.frame.y, bottom = d.frame.y + d.frame.h;
    const anchorX = h.includes('w') ? right : left, anchorY = h.includes('n') ? bottom : top;
    let pointerX = h.includes('w') ? left + dx : right + dx;
    let pointerY = h.includes('n') ? top + dy : bottom + dy;
    let w = Math.max(16 / scale(), Math.abs(pointerX - anchorX));
    let hgt = Math.max(16 / scale(), Math.abs(pointerY - anchorY));
    if (w / hgt > r) hgt = w / r; else w = hgt * r;
    if (clamp()) { w = Math.min(w, h.includes('w') ? anchorX : img.width - anchorX); hgt = w / r; hgt = Math.min(hgt, h.includes('n') ? anchorY : img.height - anchorY); w = hgt * r; }
    setFrame({ x: h.includes('w') ? anchorX - w : anchorX, y: h.includes('n') ? anchorY - hgt : anchorY, w, h: hgt });
  };
  const endDrag = () => setDrag(undefined);
  const wheel = (e: WheelEvent) => {
    if (!image()) return; e.preventDefault();
    const p = localPoint(e), o = origin(), oldScale = scale();
    const world = { x: (p.x - o.x) / oldScale, y: (p.y - o.y) / oldScale };
    const next = Math.max(.2, Math.min(5, zoom() * Math.exp(-e.deltaY * .001)));
    const img = image()!, newScale = baseScale() * next;
    const centered = { x: (viewport().w - img.width * newScale) / 2, y: (viewport().h - img.height * newScale) / 2 };
    setZoom(next); setPan({ x: p.x - world.x * newScale - centered.x, y: p.y - world.y * newScale - centered.y });
  };

  onMount(() => {
    loadOutputs();
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(undefined);
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { spaceDown = true; e.preventDefault(); }
      if (e.key.toLowerCase() === 'f' && !(e.target instanceof HTMLInputElement) && image()) flip();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    onCleanup(() => { observer?.disconnect(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); });
  });

  return <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark"><i></i><i></i></span><span>RESIZIFY</span></div>
      <Show when={image()}>
        <div class="file-title"><span class="status-dot"></span><span>{image()!.name}</span><small>{image()!.width} × {image()!.height}px</small></div>
        <button class="close-button" onClick={close} aria-label="Close image">×</button>
      </Show>
    </header>

    <Show when={image()} fallback={
      <main class="empty-page">
        <section class={`drop-card ${dropActive() ? 'active' : ''}`} onDragOver={e => { e.preventDefault(); setDropActive(true); }} onDragLeave={() => setDropActive(false)} onDrop={e => { e.preventDefault(); setDropActive(false); upload(e.dataTransfer?.files[0]); }}>
          <div class="upload-icon"><span></span></div>
          <div class="eyebrow">IMAGE RESIZING UTILITY</div>
          <h1>Frame it <em>your way.</em></h1>
          <p>Crop, extend, and resize images to exact aspect ratios.<br />No guesswork. Just the frame you need.</p>
          <button class="primary upload-button" disabled={busy()} onClick={() => input.click()}>{busy() ? 'UPLOADING…' : 'CHOOSE AN IMAGE'} <b>↗</b></button>
          <span class="drop-hint">or drop an image anywhere here · max 100 MB</span>
          <Show when={error()}><div class="alert error">{error()}</div></Show>
          <div class="formats"><span>1 : 1</span><i></i><span>4 : 3</span><i></i><span>3 : 2</span><i></i><span>16 : 9</span></div>
        </section>
      </main>
    }>
      <main class="workspace">
        <aside class="sidebar">
          <section><label class="section-label">ASPECT RATIO</label><div class="ratio-list">
            {ratios.map((r, i) => <button class={ratioIndex() === i ? 'selected' : ''} onClick={() => chooseRatio(i)}><span class="ratio-shape" style={{ 'aspect-ratio': `${r.value}` }}></span><b>{r.label}</b><small>{ratioIndex() === i ? 'SELECTED' : ''}</small></button>)}
          </div></section>
          <section><label class="section-label">ORIENTATION</label><button class="tool-row" onClick={flip}><span class="tool-icon">↔</span><span><b>Flip frame</b><small>{vertical() ? 'Portrait' : 'Landscape'}</small></span><kbd>F</kbd></button></section>
          <section><label class="section-label">FIT</label><div class="two-buttons"><button onClick={() => fitFrame('cover')}><span>◩</span><b>Cover</b></button><button onClick={() => fitFrame('contain')}><span>□</span><b>Contain</b></button></div><button class="tool-row compact" onClick={center}><span class="tool-icon">⌖</span><b>Center frame</b></button></section>
          <section><label class="section-label">BOUNDARIES</label><label class="switch-row"><span><b>Clamp to image</b><small>Keep frame inside edges</small></span><input type="checkbox" checked={clamp()} onInput={e => { setClamp(e.currentTarget.checked); if (e.currentTarget.checked) fitFrame('cover'); }} /><i></i></label></section>
          <div class="sidebar-spacer"></div>
          <div class="save-area"><div class="output-size"><span>OUTPUT FRAME</span><b>{Math.round(frame().w)} × {Math.round(frame().h)} px</b></div><button class="primary save-button" disabled={busy()} onClick={save}>{busy() ? 'SAVING…' : 'SAVE IMAGE'} <b>↗</b></button><button class="open-output-button" onClick={openOutput}><span>▰</span> OPEN OUTPUT FOLDER</button><Show when={message()}><div class="alert success">✓ {message()}</div></Show><Show when={error()}><div class="alert error">{error()}</div></Show></div>
        </aside>

        <section class="canvas-area">
          <div class={`editor ${drag()?.kind === 'pan' ? 'panning' : ''}`} ref={editorRef} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onWheel={wheel} onPointerDown={e => { if (e.target === editor) startDrag(e, 'pan'); }}>
            <div class="image-wrap" style={{ left: `${origin().x}px`, top: `${origin().y}px`, width: `${image()!.width * scale()}px`, height: `${image()!.height * scale()}px` }}><img src={image()!.url} draggable={false} /></div>
            <div class="shade top" style={{ height: `${Math.max(0, screenFrame().y)}px` }}></div>
            <div class="crop-frame" style={{ left: `${screenFrame().x}px`, top: `${screenFrame().y}px`, width: `${screenFrame().w}px`, height: `${screenFrame().h}px` }} onPointerDown={e => startDrag(e, 'frame')}>
              <div class="grid-lines"><i></i><i></i><b></b><b></b></div>
              {['nw','ne','sw','se'].map(h => <span class={`handle ${h}`} onPointerDown={e => { e.stopPropagation(); startDrag(e, 'resize', h); }}></span>)}
              <span class="frame-badge">{vertical() ? ratios[ratioIndex()].label.split(' : ').reverse().join(' : ') : ratios[ratioIndex()].label}</span>
            </div>
          </div>
          <div class="canvas-footer"><div class="tip"><span>✦</span> Drag frame to position · Drag corners to resize · Scroll to zoom · Space + drag to pan</div><div class="zoom-control"><button onClick={() => setZoom(z => Math.max(.2, z - .1))}>−</button><input type="range" min=".2" max="5" step=".01" value={zoom()} onInput={e => setZoom(+e.currentTarget.value)} /><span>{Math.round(zoom() * 100)}%</span><button onClick={resetView}>FIT</button></div></div>
        </section>

        <aside class="recent-panel">
          <div class="recent-heading"><span>LATEST OUTPUTS</span><small>{outputs().length}</small></div>
          <Show when={outputs().length} fallback={<div class="recent-empty"><span>□</span><p>Saved images will appear here.</p></div>}>
            <div class="recent-grid">{outputs().map(output => <button class="recent-image" title={output.name} onClick={() => setPreview(output)}><img src={output.url} loading="lazy" /><span>{output.name}</span></button>)}</div>
          </Show>
        </aside>
      </main>
    </Show>
    <Show when={preview()}>{output => <div class="preview-backdrop" onClick={() => setPreview(undefined)}><div class="preview-modal" onClick={e => e.stopPropagation()}><div class="preview-header"><span>{output().name}</span><button onClick={() => setPreview(undefined)} aria-label="Close preview">×</button></div><div class="preview-image-wrap"><img src={output().url} /></div></div></div>}</Show>
    <input ref={input} type="file" accept="image/*" hidden onChange={e => upload(e.currentTarget.files?.[0])} />
  </div>;
};

export default App;
