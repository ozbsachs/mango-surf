/* =====================================================================================
   MangoFX — GSAP effects library for Mango Surf (5 reels x 4 rows, hand-drawn beach slot)
   Plain browser JS. Needs gsap 3.13 + CustomEase + MotionPathPlugin + Physics2DPlugin loaded first.
   One global: window.MangoFX

   HOW TO USE
   Every effect is   MangoFX.<category>.<ID>(M, opts)  ->  gsap.core.Timeline
   (sequences are timelines too, so you can `await` them: a GSAP timeline is thenable).

   M is the "machine refs" object: plain DOM references, built once.
     M = { root, bg, day, sunset, cam, back, panel, tint, grid, reels[], rigs[], svg, winbox, winval, vig, fx,
           rows, cols, cell(r,row), sym(r,row), cells() }
       root    the machine element (position:relative, overflow:hidden)       class .mfx-machine
       bg      background layer with two children: day + sunset images         .mfx-bg
       cam     "camera" wrapper around panel + win box (shake / push-in target) .mfx-cam
       back    layer behind the panel inside cam (light rays live here)         .mfx-back
       panel   the reel frame                                                   .mfx-panel
       tint    bonus colour overlay inside the panel                            .mfx-tint
       grid    5-column grid of reels; positioning parent for svg + overlays    .mfx-grid
       reels   the 5 reel columns                                               .mfx-reel
       rigs    one strip controller per reel (see "REEL RIG")
       svg     win-line overlay, viewBox = grid pixels                          .mfx-lines
       winbox / winval   the win amount pill and its value span
       vig     edge vignette layer;  fx  top overlay for particles and titles
   MangoFX.build(host, {symbols, bg}) creates exactly this DOM (the gallery uses it); the game can
   adopt the same class names or hand in its own object with the same keys.

   Every variant also carries metadata: fn.id, fn.cat, fn.title, fn.desc, fn.dur, fn.scene.
   MangoFX.list() returns all of them. Spin starts expose fn.ramp(rig, ctx); stops expose fn.land(rig, ctx)
   so the real game can mix any start with any stop (see MangoFX.spin and MangoFX.live).
   ===================================================================================== */
(function (root) {
  'use strict';
  const gsap = root.gsap;
  if (!gsap) { console.error('[MangoFX] load GSAP before fx-lib.js'); return; }
  gsap.registerPlugin(...[root.CustomEase, root.MotionPathPlugin, root.Physics2DPlugin].filter(Boolean));
  const CE = root.CustomEase;
  if (CE) {
    CE.create('mfx.slam', 'M0,0 C0.3,0 0.55,0.25 0.7,0.6 0.8,0.85 0.9,1 1,1');
    CE.create('mfx.pop', 'M0,0 C0.14,0.6 0.26,1.28 0.46,1.16 C0.62,1.06 0.76,0.98 1,1');
  }

  const RMQ = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(RMQ && RMQ.matches);
  if (RMQ && RMQ.addEventListener) RMQ.addEventListener('change', e => { reduced = e.matches; });

  const FX = root.MangoFX = { version: '1.0.0', cfg: { path: 'img/', speed: 17, rows: 4, cols: 5 } };
  FX.isReduced = () => reduced;
  /** setReduced(bool): force the simplified prefers-reduced-motion path on or off (the gallery has a toggle). */
  FX.setReduced = v => { reduced = !!v; };
  const COL = FX.colors = { ink: '#2a0e12', gold: '#ffd23f', pink: '#ff4f8b', cyan: '#3be3ff', cream: '#fff7d6', lime: '#7dffb0', sea: '#1a9bea' };

  /* ===================================================================================
     SHARED HELPERS
     =================================================================================== */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const src = k => FX.cfg.path + k + '.webp';
  const money = v => '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function el(tag, cls, parent, style) {
    const e = document.createElement(tag); if (cls) e.className = cls;
    if (style) Object.assign(e.style, style); if (parent) parent.appendChild(e); return e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e;
  }
  /* a set() that waits for its place in the timeline instead of firing at build time */
  const S = (tl, t, vars, at) => tl.set(t, Object.assign({ immediateRender: false }, vars), at);
  /* remove nodes when the timeline reaches `at` */
  const removeAt = (tl, nodes, at) => tl.call(() => nodes.forEach(n => n && n.remove()), null, at);
  const symOf = c => c && (c.classList.contains('mfx-sym') ? c : c.querySelector('.mfx-sym')) || c;
  /** pt(node, layer): centre + size of node in layer's own (unscaled) pixels. */
  function pt(node, layer) {
    const a = node.getBoundingClientRect(), b = layer.getBoundingClientRect(), s = (b.width / (layer.offsetWidth || 1)) || 1;
    return { x: (a.left + a.width / 2 - b.left) / s, y: (a.top + a.height / 2 - b.top) / s, w: a.width / s, h: a.height / s };
  }
  /* initial slope of an ease = how much faster than average it starts (or ends, for .in); keeps reel speed continuous */
  function slope(e) {
    e = String(e || 'none'); let m;
    if ((m = e.match(/^power(\d)\.(in|out)/))) return +m[1] + 1;
    if (/^sine/.test(e)) return 1.571; if (/^expo/.test(e)) return 6.93; if (/^circ/.test(e)) return 3;
    if ((m = e.match(/^back\.(in|out)\(?([\d.]*)/))) return (parseFloat(m[2]) || 1.7) + 3;
    if (e === 'none' || e === 'linear') return 1; return 2;
  }

  /** makeParticles(layer, n, cls, init?) -> elements (hidden until a tween shows them). */
  function makeParticles(layer, n, cls, init) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = cls === 'img' ? el('img', 'mfx-p', layer) : el('i', 'mfx-p ' + (cls || ''), layer);
      p.style.opacity = 0; if (init) init(p, i); out.push(p);
    }
    return out;
  }
  function sizeP(p, s) { p.style.width = p.style.height = s + 'px'; p.style.marginLeft = p.style.marginTop = (-s / 2) + 'px'; }

  /** burst(layer, x, y, o) -> tl. Physics2D particles out of a point.
      o: {n, kind:'star'|'spark'|'drop'|'coin'|'conf'|'dust'|'img', img, speed:[a,b], angle:[a,b], gravity, dur, size:[a,b], spin, colors} */
  function burst(layer, x, y, o) {
    o = Object.assign({ n: 14, kind: 'star', speed: [160, 380], angle: [0, 360], gravity: 520, dur: 0.9, size: [8, 16], spin: 200, colors: null, grow: true }, o);
    const tl = gsap.timeline(); if (reduced || !o.n) return tl;
    const ps = makeParticles(layer, o.n, o.kind === 'img' ? 'img' : 'mfx-' + o.kind, p => {
      sizeP(p, rnd(o.size[0], o.size[1])); if (o.kind === 'img') p.src = src(o.img || 'H3');
      if (o.colors) p.style.setProperty('--c', pick(o.colors));
    });
    ps.forEach(p => {
      const d = o.dur * rnd(0.75, 1.15);
      S(tl, p, { x, y, opacity: 1, scale: o.grow ? 0.2 : 1, rotation: rnd(0, 360) }, 0);
      tl.to(p, { duration: d, ease: 'none', physics2D: { velocity: rnd(o.speed[0], o.speed[1]), angle: rnd(o.angle[0], o.angle[1]), gravity: o.gravity } }, 0);
      if (o.grow) tl.to(p, { scale: 1, duration: 0.18, ease: 'back.out(3)' }, 0);
      tl.to(p, { rotation: '+=' + rnd(-o.spin, o.spin), duration: d, ease: 'none' }, 0);
      tl.to(p, { opacity: 0, scale: 0.3, duration: d * 0.45, ease: 'power1.in' }, d * 0.55);
    });
    removeAt(tl, ps, o.dur * 1.2);
    return tl;
  }
  /** ring(layer, x, y, o) -> tl. A shockwave ring. o: {size, color, dur, width, sy (vertical squash for water ripples), from} */
  function ring(layer, x, y, o) {
    o = Object.assign({ size: 160, color: '#fff', dur: 0.6, width: 4, sy: 1, from: 0.15, peak: 1 }, o);
    const tl = gsap.timeline(); if (reduced) return tl;
    const r = el('i', 'mfx-p mfx-ring', layer); sizeP(r, o.size); r.style.opacity = 0;
    r.style.borderWidth = o.width + 'px'; r.style.setProperty('--c', o.color);
    S(tl, r, { x, y, scaleX: o.from, scaleY: o.from * o.sy, opacity: o.peak }, 0);
    tl.to(r, { scaleX: 1, scaleY: o.sy, duration: o.dur, ease: 'power2.out' }, 0)
      .to(r, { opacity: 0, duration: o.dur * 0.6, ease: 'power1.in' }, o.dur * 0.4);
    removeAt(tl, [r], o.dur + 0.02);
    return tl;
  }
  /** splash(layer, x, y, o) -> tl. Water droplets thrown up + a flat ripple. o: {n, power, ripple:bool, size} */
  function splash(layer, x, y, o) {
    o = Object.assign({ n: 12, power: 1, ripple: true, size: [6, 13] }, o);
    const tl = gsap.timeline(); if (reduced) return tl;
    tl.add(burst(layer, x, y, { n: o.n, kind: 'drop', speed: [160 * o.power, 360 * o.power], angle: [-160, -20], gravity: 1100, dur: 0.75, size: o.size, spin: 0, grow: true }), 0);
    if (o.ripple) {
      tl.add(ring(layer, x, y + 4, { size: 110 * o.power, color: 'rgba(220,250,255,.95)', sy: 0.32, dur: 0.6, width: 3 }), 0);
      tl.add(ring(layer, x, y + 4, { size: 160 * o.power, color: 'rgba(160,235,255,.7)', sy: 0.32, dur: 0.8, width: 2 }), 0.12);
    }
    return tl;
  }
  /** dust(layer, x, y, o) -> tl. Soft sand puffs rolling out sideways. o: {n, spread, size} */
  function dust(layer, x, y, o) {
    o = Object.assign({ n: 7, spread: 46, size: 26, dur: 0.7 }, o);
    const tl = gsap.timeline(); if (reduced) return tl;
    const ps = makeParticles(layer, o.n, 'mfx-dust', p => sizeP(p, o.size * rnd(0.7, 1.2)));
    ps.forEach((p, i) => {
      const dir = i % 2 ? 1 : -1, dx = dir * o.spread * rnd(0.4, 1.1);
      S(tl, p, { x: x + dir * 4, y, scale: 0.3, opacity: 0.95 }, 0);
      tl.to(p, { x: x + dx, y: y - rnd(4, 16), scale: rnd(1, 1.6), duration: o.dur, ease: 'power2.out' }, 0)
        .to(p, { opacity: 0, duration: o.dur * 0.6, ease: 'power1.in' }, o.dur * 0.4);
    });
    removeAt(tl, ps, o.dur + 0.05);
    return tl;
  }
  /** shake(target, o) -> tl. Decaying random shake. o: {amp px, dur, freq, rot deg} */
  function shake(target, o) {
    o = Object.assign({ amp: 8, dur: 0.45, freq: 30, rot: 0, y: 1 }, o);
    const tl = gsap.timeline(); if (reduced) return tl;
    const n = Math.max(3, Math.round(o.dur * o.freq));
    for (let i = 0; i < n; i++) {
      const k = 1 - i / n;
      tl.to(target, { x: rnd(-1, 1) * o.amp * k, y: rnd(-1, 1) * o.amp * k * o.y, rotation: o.rot ? rnd(-1, 1) * o.rot * k : 0, duration: o.dur / n, ease: 'sine.inOut' });
    }
    tl.to(target, { x: 0, y: 0, rotation: 0, duration: 0.06 });
    return tl;
  }
  /** flash(layer, o) -> tl. Full-layer colour flash. o: {color, peak, dur} */
  function flash(layer, o) {
    o = Object.assign({ color: '#fff', peak: 0.85, dur: 0.35 }, o);
    const tl = gsap.timeline(); const f = el('i', 'mfx-flash', layer); f.style.background = o.color; f.style.opacity = 0;
    const peak = reduced ? Math.min(o.peak, 0.25) : o.peak;
    S(tl, f, { opacity: peak }, 0);
    tl.to(f, { opacity: 0, duration: o.dur, ease: 'power2.out' }, 0.02);
    removeAt(tl, [f], o.dur + 0.05);
    return tl;
  }
  /** count(el, from, to, dur, o) -> tween. Writes money (or o.fmt) into el.textContent. */
  function count(node, from, to, dur, o) {
    o = o || {}; const fmt = o.fmt || money, p = { v: from };
    return gsap.fromTo(p, { v: from }, { v: to, duration: dur, ease: o.ease || 'power1.out', immediateRender: false, onUpdate: () => { node.textContent = fmt(p.v); } });
  }
  /** rays(layer, x, y, size, o) -> element: a soft rotating sunburst (rotate it with a tween). */
  function rays(layer, x, y, size, o) {
    o = Object.assign({ cls: '' }, o);
    const r = el('i', 'mfx-p mfx-rays ' + o.cls, layer); sizeP(r, size); r.style.opacity = 0;
    gsap.set(r, { x, y }); return r;
  }
  /** dim(M, hits) -> tween. Fades and desaturates every visible symbol that is not in hits ([[reel,row],...]). */
  function dim(M, hits, o) {
    o = o || {}; const keep = new Set(hits.map(h => M.cell(h[0], h[1])));
    const others = M.cells().filter(c => !keep.has(c)).map(symOf);
    return gsap.fromTo(others, { opacity: 1, filter: 'saturate(1) brightness(1)' },
      { opacity: o.opacity || 0.36, filter: 'saturate(0.35) brightness(0.78)', duration: 0.3, immediateRender: false });
  }
  /* lift the winning reels above their neighbours so scaled symbols are not clipped by later reels */
  function raise(M, hits) { hits.forEach(h => { const r = M.reels[h[0]]; if (r) r.style.zIndex = 3; }); }
  /* a box of a reel or a cell in grid pixels (also the svg coordinate space) */
  function reelBox(M, i) { const r = M.reels[i]; return { x: r.offsetLeft, y: r.offsetTop, w: r.offsetWidth, h: r.offsetHeight }; }
  function cellBox(M, i, row) { const b = reelBox(M, i), h = b.h / M.rows; return { x: b.x, y: b.y + row * h, w: b.w, h, cx: b.x + b.w / 2, cy: b.y + row * h + h / 2 }; }
  /* an absolutely placed element over reel i inside the grid (percent based, survives resizes) */
  function overReel(M, i, cls) {
    const b = reelBox(M, i), gw = M.grid.clientWidth, gh = M.grid.clientHeight;
    return el('div', cls, M.grid, { left: (b.x / gw * 100) + '%', top: (b.y / gh * 100) + '%', width: (b.w / gw * 100) + '%', height: (b.h / gh * 100) + '%' });
  }
  function svgFit(M) { const w = M.grid.clientWidth, h = M.grid.clientHeight; M.svg.setAttribute('viewBox', `0 0 ${w} ${h}`); return { w, h }; }

  FX.util = { rnd, pick, clamp, money, el, sv, pt, makeParticles, burst, ring, splash, dust, shake, flash, count, rays, dim, raise, symOf, overReel, cellBox, reelBox, svgFit };
  /** undim(M) -> tween: bring every symbol back after a win presentation. */
  FX.util.undim = M => gsap.to(M.cells().map(symOf), { opacity: 1, filter: 'saturate(1) brightness(1)', duration: 0.25 });
  /** clear(M): drop every particle, title and line the effects left behind and reset symbol transforms. */
  FX.clear = function (M) {
    gsap.killTweensOf(M.fx.querySelectorAll('*')); M.fx.textContent = ''; M.svg.textContent = '';
    M.root.querySelectorAll('.mfx-over,.mfx-add').forEach(n => n.remove()); M.back.textContent = '';
    gsap.set([M.sunset, M.tint, M.vig], { opacity: 0 }); gsap.set(M.cam, { clearProps: 'transform' });
    gsap.set(M.cells().map(symOf), { clearProps: 'all' }); M.reels.forEach(r => { r.style.zIndex = ''; });
  };

  /* ===================================================================================
     CSS (injected once; everything is prefixed mfx- so it can live inside the real game)
     =================================================================================== */
  const CSS = `
.mfx-machine{position:relative;overflow:hidden;border-radius:18px;isolation:isolate;container-type:inline-size;font-family:"Lilita One",system-ui,sans-serif;user-select:none;-webkit-user-select:none;background:#7fd6ff;line-height:1}
.mfx-bg{position:absolute;inset:0;z-index:0;overflow:hidden}
.mfx-bgi{position:absolute;inset:-2%;background:center 72%/cover no-repeat}
.mfx-sunset{opacity:0}
.mfx-cam{position:relative;z-index:1;padding:5% 4.5% 4%;transform-origin:50% 45%}
.mfx-back{position:absolute;inset:0;pointer-events:none;z-index:0}
.mfx-panel{position:relative;z-index:1;padding:2.2%;border:.85cqw solid #2a0e12;border-radius:4cqw;background:linear-gradient(rgba(10,70,120,.62),rgba(6,40,80,.72));box-shadow:0 1.6cqw 0 rgba(42,14,18,.45),inset 0 0 0 .6cqw rgba(255,255,255,.18)}
.mfx-tint{position:absolute;inset:0;border-radius:3.2cqw;background:linear-gradient(rgba(150,40,100,.6),rgba(70,20,80,.72));opacity:0;pointer-events:none}
.mfx-grid{position:relative;display:grid;grid-template-columns:repeat(5,1fr);gap:1.4%}
.mfx-reel{position:relative;border-radius:2.4cqw;background:rgba(255,255,255,.07)}
.mfx-reel.spin{overflow:hidden}
.mfx-strip{position:absolute;left:0;top:0;width:100%;will-change:transform}
.mfx-cell{position:relative;width:100%}
.mfx-reel:not(.spin) .mfx-cell:not(.vis),.mfx-reel.solo .mfx-cell:not(.vis){visibility:hidden}
.mfx-sym{position:absolute;inset:3%;transform-origin:50% 50%}
.mfx-sym>img{position:relative;width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;transform:scaleY(var(--sy,1));-webkit-user-drag:none}
.mfx-reel:not(.spin) .mfx-cell.vis .mfx-sym>img{filter:drop-shadow(0 .5cqw .35cqw rgba(0,0,0,.28))}
.mfx-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:6}
.mfx-over{position:absolute;pointer-events:none;z-index:5}
.mfx-winbox{position:relative;z-index:1;margin:3.2% auto 0;width:max-content;min-width:46%;display:flex;align-items:center;justify-content:center;gap:2.4cqw;padding:1.5cqw 4cqw 1.7cqw;background:rgba(6,34,62,.86);border:.7cqw solid #2a0e12;border-radius:999px;box-shadow:0 1cqw 0 rgba(42,14,18,.5),inset 0 0 0 .4cqw rgba(255,255,255,.12)}
.mfx-wink{color:#ffd23f;font-size:3.6cqw;letter-spacing:.04em}
.mfx-winval{color:#fff7d6;font-size:5.6cqw;display:inline-flex;white-space:nowrap;text-shadow:0 .4cqw 0 #2a0e12}
.mfx-vig{position:absolute;inset:0;z-index:15;pointer-events:none;opacity:0;--vx:50%;--vy:45%;background:radial-gradient(circle at var(--vx) var(--vy),rgba(8,0,20,0) 14%,rgba(8,0,20,.55) 34%,rgba(8,0,20,.9) 70%)}
.mfx-fx{position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden}
.mfx-p{position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;display:block}
img.mfx-p{object-fit:contain}
.mfx-star{background:var(--c,#fff6c8);clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)}
.mfx-spark{border-radius:50%;background:radial-gradient(circle,#fff 0 28%,var(--c,#ffd23f) 42%,rgba(255,210,63,0) 70%)}
.mfx-drop{border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff,#8fe8ff 45%,#1a9bea);border:2px solid #0b4f86;box-sizing:border-box}
.mfx-dust{border-radius:50%;background:radial-gradient(circle,rgba(255,240,210,.95),rgba(240,205,150,.55) 50%,rgba(240,205,150,0) 70%)}
.mfx-mote{border-radius:50%;background:radial-gradient(circle,rgba(255,255,235,.95),rgba(255,240,180,.35) 40%,rgba(255,240,180,0) 70%)}
.mfx-coin{border-radius:50%;background:radial-gradient(circle at 35% 30%,#fffbd0,#ffd23f 38%,#f2a400 72%,#c97a00);border:2px solid #2a0e12;box-sizing:border-box;box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)}
.mfx-coin::after{content:"";position:absolute;inset:24%;border-radius:50%;border:2px solid rgba(150,80,0,.55)}
.mfx-conf{background:var(--c,#ff4f8b);border-radius:2px}
.mfx-ring{border-radius:50%;border:4px solid var(--c,#fff);box-sizing:border-box}
.mfx-flash{position:absolute;inset:0;pointer-events:none;z-index:30}
.mfx-rays{border-radius:50%;background:repeating-conic-gradient(from 0deg,var(--rc,rgba(255,236,150,.6)) 0deg 8deg,rgba(255,255,255,0) 8deg 22.5deg);-webkit-mask:radial-gradient(circle,#000 12%,rgba(0,0,0,.6) 40%,transparent 70%);mask:radial-gradient(circle,#000 12%,rgba(0,0,0,.6) 40%,transparent 70%)}
.mfx-rays.white{--rc:rgba(255,255,255,.5)}
.mfx-rays.cyan{--rc:rgba(120,240,255,.55)}
.mfx-rays.pink{--rc:rgba(255,120,180,.55)}
.mfx-halo{position:absolute;inset:-42%;border-radius:50%;background:radial-gradient(closest-side,#fff8d0 0,var(--c,#ffe04a) 46%,var(--c2,rgba(255,176,40,.9)) 66%,rgba(255,150,40,0) 100%);opacity:0;pointer-events:none}
.mfx-shine{position:absolute;inset:0;overflow:hidden;pointer-events:none;-webkit-mask:var(--m) center/contain no-repeat;mask:var(--m) center/contain no-repeat}
.mfx-shine>i{position:absolute;top:-10%;bottom:-10%;left:-50%;width:45%;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.95) 50%,rgba(255,255,255,0))}
.mfx-shadow{position:absolute;left:18%;right:18%;bottom:2%;height:12%;border-radius:50%;background:radial-gradient(rgba(10,20,40,.5),rgba(10,20,40,0) 70%);opacity:0}
.mfx-rglow{border-radius:2.4cqw;border:.8cqw solid var(--c,#3be3ff);box-shadow:0 0 3.4cqw 1.4cqw var(--c,#3be3ff),0 0 1cqw .3cqw #fff,inset 0 0 3cqw .8cqw var(--c,#3be3ff);opacity:0}
.mfx-rshade{border-radius:2.4cqw;background:linear-gradient(rgba(255,255,255,.0),rgba(120,240,255,.22),rgba(255,255,255,0));opacity:0}
.mfx-glint{position:absolute;inset:0;overflow:hidden;border-radius:3.2cqw;pointer-events:none;z-index:7}
.mfx-glint>i{position:absolute;top:-20%;bottom:-20%;left:-35%;width:30%;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.4),rgba(255,255,255,0))}
.mfx-title{position:absolute;left:50%;top:40%;white-space:nowrap;font-size:13cqw;line-height:1.05;letter-spacing:.02em;color:#ffd23f;background:linear-gradient(#fff6b0,#ffc21f 48%,#ff7a1f);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;-webkit-text-stroke:.6cqw #2a0e12;filter:drop-shadow(0 .9cqw 0 #2a0e12) drop-shadow(0 0 2.6cqw rgba(255,200,80,.6));opacity:0;z-index:5;padding:0 1cqw}
.mfx-title.t-mega{background-image:linear-gradient(#ffe6f2,#ff7ab3 48%,#e8326b);filter:drop-shadow(0 .9cqw 0 #2a0e12) drop-shadow(0 0 2.6cqw rgba(255,90,160,.65))}
.mfx-title.t-epic{background-image:linear-gradient(#e8fcff,#3be3ff 45%,#7b5cff);filter:drop-shadow(0 .9cqw 0 #2a0e12) drop-shadow(0 0 2.6cqw rgba(80,220,255,.7))}
.mfx-title.t-max{background-image:linear-gradient(100deg,#ff4f8b,#ffd23f 30%,#7dffb0 55%,#3be3ff 75%,#c77dff);filter:drop-shadow(0 .9cqw 0 #2a0e12) drop-shadow(0 0 3.4cqw rgba(255,255,255,.75))}
.mfx-title.sm{font-size:9.5cqw}
.mfx-title>span{display:inline-block;background:inherit;-webkit-background-clip:text;background-clip:text}
.mfx-bignum{position:absolute;left:50%;top:60%;font-size:8.5cqw;color:#fff7d6;-webkit-text-stroke:.35cqw #2a0e12;text-shadow:0 .7cqw 0 #2a0e12,0 0 2cqw rgba(0,0,0,.4);opacity:0;white-space:nowrap;z-index:6}
.mfx-sub{position:absolute;left:50%;top:72%;font-size:4.4cqw;color:#ffd23f;-webkit-text-stroke:.25cqw #2a0e12;text-shadow:0 .4cqw 0 #2a0e12;opacity:0;white-space:nowrap;z-index:6;letter-spacing:.05em}
.mfx-dark{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,rgba(40,10,50,.5),rgba(18,4,28,.86));opacity:0;z-index:1}
.mfx-ribbon{position:absolute;left:50%;top:46%;width:64%;height:15cqw;opacity:0;z-index:4}
.mfx-ribbon>.band{position:absolute;inset:0;background:linear-gradient(#ff9cc2,#ff4f8b 55%,#c8245e);border:.7cqw solid #2a0e12;border-radius:1.4cqw;display:flex;align-items:center;justify-content:center;z-index:2;font-size:8.6cqw;color:#fff7d6;-webkit-text-stroke:.3cqw #2a0e12;text-shadow:0 .5cqw 0 #2a0e12;box-shadow:inset 0 .8cqw 0 rgba(255,255,255,.3)}
.mfx-ribbon>.tail{position:absolute;top:26%;width:22%;height:100%;background:linear-gradient(#e8326b,#a3164a);border:.7cqw solid #2a0e12;z-index:1;box-sizing:border-box}
.mfx-ribbon>.tail.l{left:-13%;clip-path:polygon(0 0,100% 0,100% 100%,0 100%,26% 50%)}
.mfx-ribbon>.tail.r{right:-13%;clip-path:polygon(0 0,100% 0,74% 50%,100% 100%,0 100%)}
.mfx-mx{position:absolute;z-index:8;font-size:5cqw;color:#fff;background:linear-gradient(#ff8ab8,#ff4f5e);border:.6cqw solid #2a0e12;border-radius:999px;padding:.6cqw 1.8cqw 1cqw;box-shadow:0 .7cqw 0 #2a0e12;white-space:nowrap;-webkit-text-stroke:.15cqw #2a0e12;opacity:0}
.mfx-mx.t2{background:linear-gradient(#ffe27a,#ff9a1f)}.mfx-mx.t3{background:linear-gradient(#ff8fc0,#e8326b)}.mfx-mx.t4{background:linear-gradient(#e5b8ff,#8a3cf0)}.mfx-mx.t5{background:linear-gradient(100deg,#ff4f8b,#ffd23f,#3be3ff)}
.mfx-stack{border-radius:2.4cqw;overflow:hidden;z-index:4}
.mfx-stack>.w{position:absolute;inset:0;border-radius:2.4cqw;border:.7cqw solid #2a0e12;background:radial-gradient(circle at 50% 0,#fff 40%,rgba(255,255,255,0) 43%) 0 86%/5.4cqw 3.6cqw repeat-x,linear-gradient(rgba(255,255,255,0) 84%,rgba(255,255,255,.55)),linear-gradient(#c8f6ff,#4cc9ff 30%,#1676d6 70%,#0b3f8f);box-shadow:inset 0 0 0 .5cqw rgba(255,255,255,.35)}
.mfx-stack>.sw{position:absolute;inset:-30% -40%;background:repeating-linear-gradient(170deg,rgba(255,255,255,0) 0px,rgba(255,255,255,0) 24px,rgba(255,255,255,.16) 24px,rgba(255,255,255,.16) 29px)}
.mfx-stack>.fm{display:none}
.mfx-stack>img{position:absolute;left:-4%;width:108%;top:50%;margin-top:-54%;filter:drop-shadow(0 1.2cqw .8cqw rgba(0,0,0,.3))}
.mfx-crest{position:absolute;left:-50%;width:200%;height:5cqw;margin-top:-3cqw;z-index:3;background:radial-gradient(circle at 50% 100%,#fff 52%,transparent 54%) 0 0/4.4cqw 3.2cqw repeat-x;opacity:.95}
.mfx-iris{position:absolute;inset:0;z-index:25;--r:150%;--x:50%;--y:50%;background:radial-gradient(circle at var(--x) var(--y),rgba(20,6,30,0) calc(var(--r) - 1px),#1a0820 var(--r))}
.mfx-wave{position:absolute;top:-10%;bottom:-10%;width:140%;z-index:24}
.mfx-pill{position:absolute;left:0;top:0;z-index:9;display:flex;align-items:center;gap:1cqw;white-space:nowrap;font-size:3.2cqw;color:#2a0e12;background:linear-gradient(#fffaf0,#ffe8b0);border:.6cqw solid #2a0e12;box-shadow:0 0 0 .6cqw #ffd23f,0 1cqw 0 .6cqw #2a0e12;border-radius:999px;padding:1cqw 2.4cqw 1cqw 1.2cqw;opacity:0}
.mfx-pill .tot{color:#c4301c}
.mfx-pill .ln{font-size:.75em;color:#fff;background:#2a0e12;border-radius:999px;padding:.6cqw 1.4cqw}
.mfx-pill img{width:6cqw;height:6cqw;object-fit:contain;margin:-1cqw -.4cqw}
.mfx-float{position:absolute;z-index:9;font-size:6.4cqw;color:#fff7d6;-webkit-text-stroke:.3cqw #2a0e12;text-shadow:0 .5cqw 0 #2a0e12;white-space:nowrap;opacity:0}
.mfx-odo{display:inline-block;width:.58em;height:1.1em;overflow:hidden;vertical-align:top;position:relative}
.mfx-odo>span{display:block;position:absolute;left:0;top:0;width:100%}
.mfx-odo>span>span{font-weight:400;height:1.1em;line-height:1.1em;display:block;text-align:center;width:100%}
.mfx-ch{display:inline-block;white-space:pre}
.mfx-freecount{position:absolute;left:50%;top:62%;font-size:16cqw;color:#fff7d6;-webkit-text-stroke:.6cqw #2a0e12;text-shadow:0 1cqw 0 #2a0e12;opacity:0;z-index:6}
.mfx-chip{position:absolute;left:50%;top:3%;font-size:3.8cqw;color:#2a0e12;background:linear-gradient(#fff0b8,#ffc24a);border:.55cqw solid #2a0e12;border-radius:999px;padding:1cqw 3cqw;box-shadow:0 .7cqw 0 #2a0e12;white-space:nowrap;opacity:0;z-index:7}
.mfx-bolt{fill:none;stroke:#e9fdff;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.mfx-bolt.g{stroke:#3be3ff;stroke-width:7;opacity:.45}
.mfx-sun{position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(circle at 62% 30%,rgba(255,200,120,.75),rgba(255,140,80,.25) 25%,rgba(255,120,80,0) 50%);opacity:0;mix-blend-mode:screen}
`;
  function injectCSS() {
    if (document.getElementById('mfx-css')) return;
    const s = document.createElement('style'); s.id = 'mfx-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  injectCSS();

  /* ===================================================================================
     PRE-BLURRED ART: each symbol drawn once onto a canvas with a vertical smear. While a reel
     is fast the strip shows these instead of the sharp art, which reads as real motion blur at
     zero per-frame cost. Falls back to CSS blur when the canvas is tainted (file://).
     =================================================================================== */
  const BLUR = { ready: false, src: {} };
  const KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'H1', 'H2', 'H3', 'H4', 'W', 'S1'];
  /** prepBlur() -> Promise. Call once at startup (the gallery does); safe to skip. */
  FX.prepBlur = function () {
    if (FX._blurP) return FX._blurP;
    FX._blurP = Promise.all(KEYS.map(k => new Promise(res => {
      const im = new Image(); im.onload = () => res([k, im]); im.onerror = () => res([k, null]); im.src = src(k);
    }))).then(list => {
      try {
        list.forEach(([k, im]) => {
          if (!im) return;
          const S2 = 128, c = document.createElement('canvas'); c.width = S2; c.height = S2;
          const g = c.getContext('2d'), N = 11, span = S2 * 0.26;
          g.globalCompositeOperation = 'lighter'; g.globalAlpha = 1 / N;
          for (let j = 0; j < N; j++) g.drawImage(im, 0, (j / (N - 1) - 0.5) * span, S2, S2);
          BLUR.src[k] = c.toDataURL('image/png');
        });
        BLUR.ready = KEYS.every(k => BLUR.src[k]);
      } catch (e) { BLUR.ready = false; }
      return BLUR.ready;
    });
    return FX._blurP;
  };

  /* ===================================================================================
     REEL RIG: one per reel. A strip of LEN filler cells plus a copy of the 4 window cells, so the
     scroll wraps seamlessly. `pos` is in cells (grows = symbols move down). At rest pos = 0 and
     the window shows cells LEN..LEN+3; M.cell(r,row) always returns those after a spin lands.
     =================================================================================== */
  const LEN = 30;
  const POOL = ['L1', 'L1', 'L2', 'L2', 'L3', 'L3', 'L4', 'L4', 'L5', 'L5', 'H1', 'H1', 'H2', 'H2', 'H3', 'H4', 'H4', 'W', 'S1'];
  class Rig {
    constructor(reel, col, rows) {
      this.reel = reel; this.rows = rows; this.L = LEN; this.n = LEN + rows;
      reel.classList.add('mfx-reel'); reel.textContent = ''; reel.style.aspectRatio = '1 / ' + rows;
      this.strip = el('div', 'mfx-strip', reel); this.strip.style.height = (this.n / rows * 100) + '%';
      this.cells = [];
      for (let i = 0; i < this.n; i++) {
        const c = el('div', 'mfx-cell', this.strip); c.style.height = (100 / this.n) + '%';
        const s = el('div', 'mfx-sym', c), im = el('img', null, s);
        im.alt = ''; im.draggable = false; c._img = im; c._k = ''; this.cells.push(c);
      }
      this.pos = 0; this.blur = 0; this.stretch = 0; this.cssBlur = 0; this._art = false; this._q = -1; this._sy = -1;
      for (let i = 0; i < this.n; i++) this.set(i, pick(POOL));
      this.setY = gsap.quickSetter(this.strip, 'yPercent');
      this.r = () => this.render();
      this.settle(col || []);
    }
    set(i, k) { const c = this.cells[i]; if (!c) return; c._k = k; c.dataset.s = k; c._img.src = (this._art && BLUR.src[k]) || src(k); }
    /* write a cell and its wrap copy */
    put(i, k) { this.set(i, k); if (i < this.rows) this.set(i + this.L, k); else if (i >= this.L) this.set(i - this.L, k); }
    /* first strip index visible in the window when pos = P (P whole) */
    winIndex(P) { const m = ((Math.round(P) % this.L) + this.L) % this.L; return this.L - m; }
    /* place the result symbols where the window will be at pos = P */
    write(P, col) { const k = this.winIndex(P); for (let r = 0; r < this.rows; r++) if (col[r]) this.put(k + r, col[r]); }
    /* canonical rest state on col: pos 0, window = LEN..LEN+rows-1 */
    settle(col) {
      for (let r = 0; r < this.rows; r++) if (col[r]) this.put(this.L + r, col[r]);
      this.pos = 0; this.blur = 0; this.stretch = 0; this.cssBlur = 0;
      this.cells.forEach((c, i) => c.classList.toggle('vis', i >= this.L));
      this.reel.classList.remove('spin', 'solo'); this.strip.style.opacity = ''; this.render();
    }
    window() { return this.cells.slice(this.L, this.L + this.rows); }
    /* the window cells plus their wrap copies (for effects that must survive a small negative pos) */
    winBoth() { return this.window().concat(this.cells.slice(0, this.rows)); }
    keys() { return this.window().map(c => c._k); }
    render() {
      const L = this.L, m = ((this.pos % L) + L) % L; this.setY((m - L) / this.n * 100);
      const b = this.blur, art = b > 0.5 && BLUR.ready;
      if (art !== this._art) { this._art = art; this.cells.forEach(c => { c._img.src = (art && BLUR.src[c._k]) || src(c._k); }); }
      const q = Math.round((this.cssBlur || (BLUR.ready ? 0 : 2.2)) * b * 4) / 4;
      if (q !== this._q) { this._q = q; this.strip.style.filter = q > 0 ? 'blur(' + q + 'px)' : ''; }
      const sy = Math.round((1 + this.stretch * b) * 50) / 50;
      if (sy !== this._sy) { this._sy = sy; this.reel.style.setProperty('--sy', sy); }
    }
  }
  FX.Rig = Rig;

  /** build(host, o) -> M. Creates a full demo machine inside host.
      o: {symbols: 5 columns x 4 keys, bg: 'day'|'sunset', rows, cols} */
  FX.build = function (host, o) {
    o = o || {}; const rows = o.rows || FX.cfg.rows, cols = o.cols || FX.cfg.cols, grid = o.symbols || FX.DEMO.start;
    host.textContent = '';
    const rootEl = el('div', 'mfx-machine', host);
    const bg = el('div', 'mfx-bg', rootEl);
    const day = el('div', 'mfx-bgi mfx-day', bg); day.style.backgroundImage = `url(${FX.cfg.path}bg-day.webp)`;
    const sunset = el('div', 'mfx-bgi mfx-sunset', bg); sunset.style.backgroundImage = `url(${FX.cfg.path}bg-sunset.webp)`;
    if (o.bg === 'sunset') sunset.style.opacity = 1;
    const cam = el('div', 'mfx-cam', rootEl), back = el('div', 'mfx-back', cam);
    const panel = el('div', 'mfx-panel', cam), tint = el('div', 'mfx-tint', panel);
    const gridEl = el('div', 'mfx-grid', panel); gridEl.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    const reels = [], rigs = [];
    for (let c = 0; c < cols; c++) { const r = el('div', null, gridEl); reels.push(r); rigs.push(new Rig(r, grid[c] || [], rows)); }
    const svg = sv('svg', { class: 'mfx-lines' }, gridEl);
    const winbox = el('div', 'mfx-winbox', cam); el('span', 'mfx-wink', winbox).textContent = 'WIN';
    const winval = el('span', 'mfx-winval', winbox); winval.textContent = money(0);
    const vig = el('div', 'mfx-vig', rootEl), fx = el('div', 'mfx-fx', rootEl);
    const M = { host, root: rootEl, bg, day, sunset, cam, back, panel, tint, grid: gridEl, reels, rigs, svg, winbox, winval, vig, fx, rows, cols };
    M.cell = (r, row) => rigs[r] ? rigs[r].cells[rigs[r].L + row] : null;
    M.sym = (r, row) => symOf(M.cell(r, row));
    M.cells = () => rigs.flatMap(g => g.window());
    M.find = key => { const out = []; rigs.forEach((g, r) => g.keys().forEach((k, row) => { if (k === key) out.push([r, row]); })); return out; };
    rootEl._mfx = M;
    return M;
  };
  /** destroy(M): kill every tween on the machine and remove it. */
  FX.destroy = function (M) {
    if (!M || !M.root) return;
    gsap.killTweensOf([M.root, ...M.root.querySelectorAll('*'), ...M.rigs]);
    M.root.remove();
  };

  /* ===================================================================================
     DEMO DATA (grids are 5 columns, each listed top to bottom)
     =================================================================================== */
  FX.DEMO = {
    start: [['L2', 'H2', 'L5', 'H1'], ['L4', 'L1', 'H4', 'L3'], ['H2', 'L5', 'L1', 'H3'], ['L3', 'H1', 'L2', 'L4'], ['L1', 'L5', 'H4', 'L2']],
    line: [['H3', 'H1', 'H4', 'L5'], ['H1', 'H3', 'H4', 'L2'], ['H1', 'L3', 'W', 'L1'], ['H1', 'H3', 'H4', 'S1'], ['H3', 'L4', 'L2', 'H2']],
    bonus: [['L1', 'S1', 'H2', 'L4'], ['H3', 'L2', 'L5', 'H1'], ['L3', 'H4', 'S1', 'L2'], ['S1', 'L1', 'H3', 'L5'], ['H2', 'L3', 'L1', 'H4']],
    wild2: [['L2', 'H3', 'L5', 'H1'], ['L4', 'W', 'H3', 'L3'], ['H3', 'L5', 'H4', 'H2'], ['L3', 'H1', 'W', 'L4'], ['H3', 'L5', 'H4', 'L2']],
    lines: { A: [0, 1, 2, 1, 0], B: [1, 0, 0, 0, 1], C: [2, 2, 2, 2, 2] },
    lineNo: { A: 7, B: 4, C: 3 },
  };
  FX.DEMO.hits = FX.DEMO.lines.A.map((row, r) => [r, row]);
  const lineHits = line => line.map((row, r) => [r, row]);

  /* ===================================================================================
     REGISTRY
     =================================================================================== */
  const CATS = [
    ['start', 'Spin start', 'G'], ['stop', 'Reel stop & landing', 'S'], ['tease', 'Anticipation / slow roll', 'T'],
    ['win', 'Symbol win', 'P'], ['line', 'Win line', 'L'], ['count', 'Win amount / counter', 'C'],
    ['big', 'Big / Mega / Max win', 'B'], ['wild', 'Wild', 'W'], ['bonus', 'Bonus trigger', 'F'], ['idle', 'Idle / ambient', 'I']];
  FX.categories = CATS.map(([key, label, prefix]) => ({ key, label, prefix }));
  CATS.forEach(c => { FX[c[0]] = {}; });
  const REG = []; const REDUCED = {};
  FX.list = () => REG.slice();
  /* def(cat, id, meta, fn): meta = {title, desc, dur, scene, loop?, reduced?, ...}.  fn(M, opts) -> timeline */
  function def(cat, id, meta, fn) {
    const f = function (M, opts) {
      opts = Object.assign({}, opts);
      if (reduced && !opts.full) return (meta.reduced || REDUCED[cat])(M, opts, f);
      return fn(M, opts);
    };
    Object.assign(f, meta, { id, cat }); FX[cat][id] = f; REG.push(f); return f;
  }
  const getV = (cat, v) => typeof v === 'string' ? FX[cat][v] || INTERNAL[cat][v] : v;
  const INTERNAL = { start: {}, stop: {} };

  /* ===================================================================================
     SPIN COMPOSER
     =================================================================================== */
  /** spin(M, o) -> timeline. A full spin: start variant on every reel, cruise, stop variant per reel.
      o: {start:'G1', stop:'S1', symbols, cruise:0.55 s, stopStagger, stopTimes:[abs s per reel], speed} */
  FX.spin = function (M, o) {
    o = o || {};
    const st = getV('start', o.start || 'G1'), sp = getV('stop', o.stop || 'S1');
    const n = M.rigs.length, syms = o.symbols || FX.DEMO.line, v = o.speed || FX.cfg.speed, tl = gsap.timeline();
    const ends = M.rigs.map((rig, i) => { const r = st.ramp(rig, { i, n, M, v, opts: o }); tl.add(r.tl, 0); return r; });
    const base = Math.max(...ends.map(e => e.end)) + (o.cruise != null ? o.cruise : 0.55);
    const gap = o.stopStagger != null ? o.stopStagger : (sp.stagger != null ? sp.stagger : 0.16);
    M.rigs.forEach((rig, i) => {
      const e = ends[i], tS = o.stopTimes ? o.stopTimes[i] : base + i * gap, p0 = e.pos + e.v * (tS - e.end);
      tl.fromTo(rig, { pos: e.pos }, { pos: p0, duration: Math.max(0, tS - e.end), ease: 'none', immediateRender: false, onUpdate: rig.r }, e.end);
      tl.add(sp.land(rig, { i, n, M, p0, v: e.v, syms: syms[i], last: i === n - 1, opts: o }), tS);
    });
    return tl;
  };
  /** live(M, o) -> {tl, stop(symbols, stopId, so) -> Promise}. For the real game: start now, spin until the
      server answers, then land. o: {start, speed} */
  FX.live = function (M, o) {
    o = o || {};
    const st = getV('start', o.start || 'G1'), n = M.rigs.length, v = o.speed || FX.cfg.speed, tl = gsap.timeline(), lane = [];
    M.rigs.forEach((rig, i) => {
      const r = st.ramp(rig, { i, n, M, v, opts: o }); tl.add(r.tl, 0);
      const p = { t: 0 }, cruise = gsap.to(p, { t: 3600, duration: 3600, ease: 'none', paused: true, onUpdate: () => { rig.pos = r.pos + v * p.t; rig.render(); } });
      tl.call(() => cruise.play(0), null, r.end); lane[i] = { r, cruise };
    });
    return {
      tl,
      stop(symbols, stopId, so) {
        so = so || {}; const sp = getV('stop', stopId || 'S1'), gap = so.stagger != null ? so.stagger : (sp.stagger != null ? sp.stagger : 0.16);
        return new Promise(res => {
          let done = 0; const seq = gsap.timeline();
          M.rigs.forEach((rig, i) => seq.call(() => {
            lane[i].cruise.kill(); lane[i].r.tl.kill(); rig.blur = 1;
            const l = sp.land(rig, { i, n, M, p0: rig.pos, v, syms: symbols[i], last: i === n - 1, opts: so });
            l.eventCallback('onComplete', () => { if (++done === n) res(); });
          }, null, i * gap));
        });
      }
    };
  };

  /* ---------- ramp / land building blocks ---------- */
  const spinOn = (tl, rig, at) => tl.call(() => { rig.reel.classList.add('spin'); }, null, at || 0);
  /* accelerate from pos a so the reel ends at speed v; returns the end pos */
  function launch(tl, rig, a, v, T, at, ease) {
    ease = ease || 'power1.in'; const b = a + v * T / slope(ease);
    tl.fromTo(rig, { pos: a }, { pos: b, duration: T, ease, immediateRender: false, onUpdate: rig.r }, at); return b;
  }
  function blurIn(tl, rig, at, T, ease) { tl.fromTo(rig, { blur: 0 }, { blur: 1, duration: T, ease: ease || 'power1.in', immediateRender: false, onUpdate: rig.r }, at); }
  /* landSeq: segments [{to: offset from target in cells, d: s, ease}]; the first starts at the cruise pos.
     Writes the result into the strip out of sight, settles at the end. tl.landAt = settle time. */
  function landSeq(rig, c, segs, o) {
    o = o || {}; const tl = gsap.timeline(), s0 = segs[0];
    let T0 = s0.d; const k = slope(s0.ease);
    const D = Math.max(c.v * T0 / k, rig.rows + 0.3 + Math.max(0, s0.to));
    const P = Math.ceil(c.p0 + D - s0.to);
    if (o.matchV) T0 = clamp(k * (P + s0.to - c.p0) / c.v, 0.12, 2);
    tl.call(() => rig.write(P, c.syms), null, 0);
    let t = 0, from = c.p0;
    segs.forEach((s, j) => {
      const d = j ? s.d : T0;
      tl.fromTo(rig, { pos: from }, { pos: P + s.to, duration: d, ease: s.ease, immediateRender: false, onUpdate: rig.r }, t);
      from = P + s.to; t += d;
    });
    tl.fromTo(rig, { blur: 1 }, { blur: 0, duration: T0 * (o.blurF || 0.7), ease: 'power1.in', immediateRender: false, onUpdate: rig.r }, 0);
    tl.call(() => rig.settle(c.syms), null, t);
    tl.landAt = t;
    return tl;
  }
  const winSyms = rig => rig.window().map(symOf);

  /* hidden plain variants used by the reduced-motion path */
  INTERNAL.start.G0 = { ramp(rig, c) { const tl = gsap.timeline(); spinOn(tl, rig, 0); const e = launch(tl, rig, 0, c.v * 0.6, 0.3, 0, 'power1.in'); return { tl, end: 0.3, pos: e, v: c.v * 0.6 }; } };
  INTERNAL.stop.S0 = { stagger: 0.1, land(rig, c) { return landSeq(rig, c, [{ to: 0, d: 0.35, ease: 'power2.out' }]); } };
  REDUCED.start = REDUCED.stop = (M, o) => FX.spin(M, Object.assign({}, o, { start: 'G0', stop: 'S0', cruise: 0.3 }));

  /* ===================================================================================
     1. SPIN START  (G)
     Each variant: MangoFX.start.Gx(M, {stop:'S1', symbols, cruise}) -> full demo spin timeline.
     Integration hook: MangoFX.start.Gx.ramp(rig, {i, n, M, v}) -> {tl, end, pos, v}
       tl  = the reel's launch; end = time it reaches cruise speed v (cells/s); pos = strip pos then.
     =================================================================================== */
  function startDef(id, meta, ramp) {
    const f = def('start', id, Object.assign({ scene: 'start' }, meta), (M, o) => FX.spin(M, Object.assign({ stop: 'S1' }, o, { start: f })));
    f.ramp = ramp; return f;
  }

  startDef('G1', { title: 'Wind-up Launch', desc: 'Each reel pulls back a third of a symbol, then whips down. Light left-to-right stagger.', dur: '0.6s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.07; spinOn(tl, rig, d);
    tl.fromTo(rig, { pos: 0 }, { pos: -0.32, duration: 0.22, ease: 'power2.out', immediateRender: false, onUpdate: rig.r }, d);
    const e = launch(tl, rig, -0.32, c.v, 0.3, d + 0.22, 'power1.in'); blurIn(tl, rig, d + 0.22, 0.3);
    return { tl, end: d + 0.52, pos: e, v: c.v };
  });

  startDef('G2', { title: 'Elastic Kick', desc: 'Symbols squash like a spring loading, the strip kicks off and the symbols wobble back as they fly.', dur: '0.6s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.05, syms = rig.winBoth().map(symOf); spinOn(tl, rig, d);
    tl.fromTo(syms, { scaleX: 1, scaleY: 1, yPercent: 0 }, { scaleX: 1.14, scaleY: 0.8, yPercent: 7, transformOrigin: '50% 100%', duration: 0.13, ease: 'power2.out', immediateRender: false }, d);
    tl.fromTo(rig, { pos: 0 }, { pos: -0.16, duration: 0.13, ease: 'power2.out', immediateRender: false, onUpdate: rig.r }, d);
    tl.to(syms, { scaleX: 1, scaleY: 1, yPercent: 0, duration: 0.7, ease: 'elastic.out(1.2,0.35)' }, d + 0.13);
    const e = launch(tl, rig, -0.16, c.v, 0.26, d + 0.13, 'power2.in'); blurIn(tl, rig, d + 0.2, 0.25);
    return { tl, end: d + 0.39, pos: e, v: c.v };
  });

  startDef('G3', { title: 'Domino Cascade', desc: 'Reels go one after another, left to right, each column bobbing up as it releases. Clear, readable rhythm.', dur: '1.0s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.13; spinOn(tl, rig, d);
    tl.fromTo(rig.reel, { y: 0 }, { y: -6, duration: 0.14, ease: 'power2.out', immediateRender: false }, d)
      .to(rig.reel, { y: 0, duration: 0.22, ease: 'back.out(3)' }, d + 0.14);
    tl.fromTo(rig, { pos: 0 }, { pos: -0.22, duration: 0.14, ease: 'power2.out', immediateRender: false, onUpdate: rig.r }, d);
    const e = launch(tl, rig, -0.22, c.v, 0.3, d + 0.14, 'power1.in'); blurIn(tl, rig, d + 0.14, 0.3);
    return { tl, end: d + 0.44, pos: e, v: c.v };
  });

  startDef('G4', { title: 'Motion-Blur Ramp', desc: 'A slower, heavier acceleration: symbols stretch tall and blur progressively as the reels pick up speed.', dur: '0.75s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.04; spinOn(tl, rig, d);
    tl.call(() => { rig.cssBlur = 3.2; rig.stretch = 0.34; }, null, d);
    const e = launch(tl, rig, 0, c.v, 0.6, d, 'power2.in');
    tl.fromTo(rig, { blur: 0 }, { blur: 1, duration: 0.6, ease: 'power2.in', immediateRender: false, onUpdate: rig.r }, d);
    return { tl, end: d + 0.6, pos: e, v: c.v };
  });

  startDef('G5', { title: 'Drop Out', desc: 'The old symbols fall out of the bottom one by one, then a fresh strip pours in from the top.', dur: '1.2s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.06, rows = rig.rows, syms = winSyms(rig); spinOn(tl, rig, d);
    syms.forEach((s, r) => tl.fromTo(s, { yPercent: 0, rotation: 0 }, { yPercent: (rows - r) * 100 + 40, rotation: rnd(-28, 28), duration: 0.46, ease: 'power2.in', immediateRender: false }, d + (rows - 1 - r) * 0.04));
    const go = d + 0.46 + (rows - 1) * 0.04 - 0.08;
    const e = launch(tl, rig, 0, c.v, 0.62, go, 'power1.in'); blurIn(tl, rig, go, 0.5);
    S(tl, syms, { yPercent: 0, rotation: 0 }, go + 0.62);
    return { tl, end: go + 0.62, pos: e, v: c.v };
  });

  startDef('G6', { title: 'Hop & Go', desc: 'Every reel column hops up and lands back down, launching the spin on the way down. Bouncy, toy-like.', dur: '0.7s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.06; spinOn(tl, rig, d);
    tl.fromTo(rig.reel, { yPercent: 0 }, { yPercent: -4, duration: 0.16, ease: 'power2.out', immediateRender: false }, d)
      .to(rig.reel, { yPercent: 0, duration: 0.14, ease: 'power2.in' }, d + 0.16)
      .fromTo(rig.reel, { scaleY: 1 }, { scaleY: 0.975, transformOrigin: '50% 100%', duration: 0.07, yoyo: true, repeat: 1, ease: 'power1.out', immediateRender: false }, d + 0.3);
    const e = launch(tl, rig, 0, c.v, 0.32, d + 0.12, 'power1.in'); blurIn(tl, rig, d + 0.12, 0.3);
    return { tl, end: d + 0.44, pos: e, v: c.v };
  });

  startDef('G7', { title: 'Centre Burst', desc: 'The middle reel fires first and the start ripples outwards, with a glass glint sweeping over the panel.', dur: '0.7s' }, (rig, c) => {
    const tl = gsap.timeline(), mid = (c.n - 1) / 2, d = Math.abs(c.i - mid) * 0.09; spinOn(tl, rig, d);
    if (c.i === Math.round(mid)) {
      const g = el('div', 'mfx-glint', c.M.panel), bar = el('i', null, g);
      tl.fromTo(c.M.panel, { scale: 1 }, { scale: 1.018, duration: 0.12, yoyo: true, repeat: 1, ease: 'power1.out', immediateRender: false }, 0);
      tl.fromTo(bar, { xPercent: 0, skewX: -12 }, { xPercent: 480, skewX: -12, duration: 0.6, ease: 'power2.inOut', immediateRender: false }, 0.02);
      removeAt(tl, [g], 0.65);
    }
    tl.fromTo(rig, { pos: 0 }, { pos: -0.2, duration: 0.14, ease: 'power2.out', immediateRender: false, onUpdate: rig.r }, d);
    const e = launch(tl, rig, -0.2, c.v, 0.28, d + 0.14, 'power1.in'); blurIn(tl, rig, d + 0.14, 0.28);
    return { tl, end: d + 0.42, pos: e, v: c.v };
  });

  startDef('G8', { title: 'Rope Tug', desc: 'A quick tug down, a long draw back up, then the reels snap away with an exponential launch. Most dramatic start.', dur: '0.75s' }, (rig, c) => {
    const tl = gsap.timeline(), d = c.i * 0.05; spinOn(tl, rig, d);
    tl.fromTo(rig, { pos: 0 }, { pos: 0.12, duration: 0.07, ease: 'power1.out', immediateRender: false, onUpdate: rig.r }, d)
      .fromTo(rig, { pos: 0.12 }, { pos: -0.4, duration: 0.26, ease: 'power2.inOut', immediateRender: false, onUpdate: rig.r }, d + 0.07);
    const e = launch(tl, rig, -0.4, c.v, 0.34, d + 0.33, 'expo.in'); blurIn(tl, rig, d + 0.42, 0.25);
    return { tl, end: d + 0.67, pos: e, v: c.v };
  });

  /* ===================================================================================
     2. REEL STOP / LANDING  (S)
     Each variant: MangoFX.stop.Sx(M, {start:'G1', symbols, cruise}) -> full demo spin (5 staggered stops).
     Integration hook: MangoFX.stop.Sx.land(rig, {i, n, M, p0, v, syms, last}) -> timeline (tl.landAt = settled)
       p0 = strip pos when the stop begins, v = current speed, syms = the 4 result keys for this reel.
     =================================================================================== */
  function stopDef(id, meta, land) {
    const f = def('stop', id, Object.assign({ scene: 'start' }, meta), (M, o) => FX.spin(M, Object.assign({ start: 'G1' }, o, { stop: f })));
    f.land = land; f.stagger = meta.stagger; return f;
  }
  const reelFoot = (c) => pt(c.M.reels[c.i], c.M.fx);

  stopDef('S1', { title: 'Overshoot Bounce', desc: 'Hard, fast stop that overshoots a quarter symbol and bounces back. The classic premium video-slot stop.', dur: '1.4s', stagger: 0.16 }, (rig, c) =>
    landSeq(rig, c, [{ to: 0.28, d: 0.3, ease: 'power2.out' }, { to: 0, d: 0.34, ease: 'back.out(2.6)' }]));

  stopDef('S2', { title: 'Elastic Settle', desc: 'The strip runs a little long and springs back with a few soft elastic wobbles.', dur: '1.9s', stagger: 0.17 }, (rig, c) =>
    landSeq(rig, c, [{ to: 0.24, d: 0.3, ease: 'power2.out' }, { to: 0, d: 0.9, ease: 'elastic.out(1.15,0.3)' }]));

  stopDef('S3', { title: 'Squash & Stretch', desc: 'Symbols stretch tall while fast, slam into place and squash flat, then pop back up. Cartoon weight.', dur: '1.6s', stagger: 0.15 }, (rig, c) => {
    rig.stretch = 0.3;
    const tl = landSeq(rig, c, [{ to: 0, d: 0.3, ease: 'power1.out' }], { blurF: 0.9 });
    const syms = winSyms(rig);
    tl.fromTo(syms, { scaleX: 1, scaleY: 1 }, {
      keyframes: { scaleX: [1, 1.22, 0.9, 1.04, 1], scaleY: [1, 0.72, 1.14, 0.96, 1], ease: 'none' },
      transformOrigin: '50% 100%', duration: 0.55, ease: 'power1.out', stagger: { each: 0.035, from: 'end' }, immediateRender: false
    }, tl.landAt - 0.02);
    return tl;
  });

  stopDef('S4', { title: 'Heavy Thud', desc: 'Reels arrive at full speed and stop dead with a thump: column dips, micro screen shake, bigger on the last reel.', dur: '1.3s', stagger: 0.17 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.1, d: 0.3, ease: 'none' }, { to: 0, d: 0.14, ease: 'power2.out' }], { matchV: true, blurF: 0.9 });
    const t = tl.landAt - 0.14;
    tl.fromTo(rig.reel, { yPercent: 0 }, { yPercent: 0.9, duration: 0.07, yoyo: true, repeat: 1, ease: 'power2.out', immediateRender: false }, t);
    tl.add(shake(c.M.cam, { amp: c.last ? 7 : 2.6, dur: c.last ? 0.4 : 0.18, freq: 34 }), t);
    if (c.last) { const f = reelFoot(c); tl.add(dust(c.M.fx, f.x - f.w * 2, f.y + f.h / 2, { n: 6, spread: 60, size: 30 }), t); tl.add(dust(c.M.fx, f.x, f.y + f.h / 2, { n: 6, spread: 60, size: 30 }), t); }
    return tl;
  });

  stopDef('S5', { title: 'Soft Glide', desc: 'Long, smooth sine deceleration with no overshoot. Calm and classy; good for a relaxed beach mood.', dur: '2.0s', stagger: 0.22 }, (rig, c) =>
    landSeq(rig, c, [{ to: 0, d: 0.95, ease: 'sine.out' }], { blurF: 0.6 }));

  stopDef('S6', { title: 'Click Stop', desc: 'Crisp mechanical stop: a tiny overrun, a quick recoil, a white tick of light on the reel frame.', dur: '1.2s', stagger: 0.12 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.1, d: 0.26, ease: 'power2.out' }, { to: -0.04, d: 0.06, ease: 'power1.inOut' }, { to: 0, d: 0.08, ease: 'power1.out' }]);
    const g = overReel(c.M, c.i, 'mfx-over mfx-rglow'); g.style.setProperty('--c', 'rgba(255,255,255,.9)');
    tl.fromTo(g, { opacity: 0 }, { opacity: 0.85, duration: 0.04, immediateRender: false }, tl.landAt - 0.14)
      .to(g, { opacity: 0, duration: 0.3, ease: 'power2.out' }, tl.landAt - 0.1);
    tl.fromTo(winSyms(rig), { scale: 1.05 }, { scale: 1, duration: 0.2, ease: 'power2.out', immediateRender: false }, tl.landAt);
    removeAt(tl, [g], tl.landAt + 0.3);
    return tl;
  });

  stopDef('S7', { title: 'Tumble Drop-in', desc: 'Cascade style: the spinning strip clears and each new symbol drops in from above, bottom row first, landing with a bounce.', dur: '1.6s', stagger: 0.12 }, (rig, c) => {
    const tl = gsap.timeline(), rows = rig.rows, syms = winSyms(rig);
    tl.fromTo(rig.strip, { opacity: 1 }, { opacity: 0, duration: 0.1, immediateRender: false }, 0);
    tl.call(() => { rig.settle(c.syms); rig.reel.classList.add('spin', 'solo'); }, null, 0.1);
    syms.forEach((s, r) => {
      const at = 0.1 + (rows - 1 - r) * 0.06;
      S(tl, s, { yPercent: -(r + 1.2) * 100 - 30 }, 0.1);
      tl.fromTo(s, { yPercent: -(r + 1.2) * 100 - 30, scaleX: 1, scaleY: 1 }, { yPercent: 0, duration: 0.34, ease: 'power2.in', immediateRender: false }, at)
        .to(s, { keyframes: { scaleX: [1, 1.16, 0.95, 1], scaleY: [1, 0.82, 1.06, 1] }, transformOrigin: '50% 100%', duration: 0.32, ease: 'none' }, at + 0.34);
    });
    S(tl, rig.strip, { opacity: 1 }, 0.1);
    tl.call(() => rig.reel.classList.remove('spin', 'solo'), null, 0.1 + (rows - 1) * 0.06 + 0.7);
    tl.landAt = 0.1;
    return tl;
  });

  stopDef('S8', { title: 'Splash Landing', desc: 'Bounce stop plus a burst of sea spray and a flat ripple at the foot of every reel as it lands.', dur: '1.5s', stagger: 0.16 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.26, d: 0.3, ease: 'power2.out' }, { to: 0, d: 0.32, ease: 'back.out(2.4)' }]);
    const f = reelFoot(c);
    tl.add(splash(c.M.fx, f.x, f.y + f.h / 2 - 4, { n: 10, power: 0.8 }), 0.28);
    return tl;
  });

  stopDef('S9', { title: 'Sand Puff', desc: 'Each landing symbol kicks up a small puff of beach sand under it as the reel settles.', dur: '1.5s', stagger: 0.16 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.2, d: 0.28, ease: 'power2.out' }, { to: 0, d: 0.26, ease: 'back.out(2)' }]);
    const f = reelFoot(c), h = f.h / rig.rows;
    for (let r = 0; r < rig.rows; r++) tl.add(dust(c.M.fx, f.x, f.y - f.h / 2 + (r + 1) * h - h * 0.12, { n: 3, spread: h * 0.45, size: h * 0.3, dur: 0.55 }), 0.24 + r * 0.02);
    return tl;
  });

  stopDef('S10', { title: 'Turbo Slam', desc: 'All five reels slam down together with one hard shake and a white flash. Built for turbo or quick-stop.', dur: '0.9s', stagger: 0 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.2, d: 0.2, ease: 'none' }, { to: 0, d: 0.22, ease: 'back.out(3)' }], { matchV: true, blurF: 1 });
    if (c.last) { const t = tl.landAt - 0.22; tl.add(shake(c.M.cam, { amp: 9, dur: 0.38 }), t); tl.add(flash(c.M.fx, { peak: 0.45, dur: 0.3 }), t); }
    return tl;
  });

  stopDef('S11', { title: 'Domino Ripple', desc: 'Smooth stop, then a settling ripple runs down each column, symbol by symbol, top to bottom.', dur: '1.6s', stagger: 0.15 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0, d: 0.42, ease: 'power3.out' }]);
    tl.fromTo(winSyms(rig), { scale: 1, yPercent: 0 }, { keyframes: { scale: [1, 1.13, 1], yPercent: [0, -6, 0] }, duration: 0.3, ease: 'none', stagger: 0.06, immediateRender: false }, tl.landAt - 0.12);
    return tl;
  });

  stopDef('S12', { title: 'Jelly Land', desc: 'Soft overshoot stop and the landed symbols wobble like jelly for a beat. Squishy and friendly.', dur: '1.7s', stagger: 0.15 }, (rig, c) => {
    const tl = landSeq(rig, c, [{ to: 0.16, d: 0.3, ease: 'power2.out' }, { to: 0, d: 0.2, ease: 'power1.inOut' }]);
    tl.fromTo(winSyms(rig), { scaleX: 1, scaleY: 1 }, {
      keyframes: { scaleX: [1, 1.14, 0.9, 1.07, 0.97, 1], scaleY: [1, 0.88, 1.1, 0.95, 1.02, 1] },
      duration: 0.75, ease: 'none', stagger: 0.03, immediateRender: false
    }, tl.landAt - 0.05);
    return tl;
  });

  /* ===================================================================================
     3. ANTICIPATION / SLOW ROLL  (T)
     Scenario in the demos: two SURF badges land on reels 1 and 3, reels 4 and 5 tease one at a time,
     the third SURF lands on reel 4.
     MangoFX.tease.Tx(M, {symbols, tease:[3,4], mode:'slow'|'fast'|'long', hold}) -> timeline
     Building blocks (for the game): MangoFX.tease.slowLand(rig, ctx, o), .glow/.rays/.heartbeat/.vignette/
     .push/.lightning(M, reelIndex, fromTime, toTime) -> timeline (absolute times; add at 0).
     =================================================================================== */
  /* move a reel while its speed changes linearly from v0 to v1 */
  function velTween(tl, rig, p0, v0, v1, dur, at) {
    const pr = { t: 0 };
    tl.fromTo(pr, { t: 0 }, { t: dur, duration: dur, ease: 'none', immediateRender: false, onUpdate: () => { const t = pr.t; rig.pos = p0 + v0 * t + (v1 - v0) * t * t / (2 * dur); rig.render(); } }, at);
    return p0 + (v0 + v1) / 2 * dur;
  }
  /** slowLand(rig, ctx, o) -> tl: brake to a readable crawl, crawl, then a soft overshoot landing. o: {v2, Td, Tc, Tl} */
  function slowLand(rig, c, o) {
    o = Object.assign({ v2: 3.4, Td: 0.6, Tc: 0.85, Tl: 0.5 }, o); const tl = gsap.timeline();
    const dist = (c.v + o.v2) / 2 * o.Td + o.v2 * o.Tc + o.v2 * o.Tl / 3;
    const P = Math.ceil(c.p0 + dist), Tc = o.Tc + (P - (c.p0 + dist)) / o.v2;
    tl.call(() => rig.write(P, c.syms), null, 0);
    let p = velTween(tl, rig, c.p0, c.v, o.v2, o.Td, 0);
    tl.fromTo(rig, { blur: 1 }, { blur: 0, duration: o.Td * 0.8, ease: 'power1.out', immediateRender: false, onUpdate: rig.r }, 0);
    tl.fromTo(rig, { pos: p }, { pos: p + o.v2 * Tc, duration: Tc, ease: 'none', immediateRender: false, onUpdate: rig.r }, o.Td);
    p += o.v2 * Tc;
    tl.fromTo(rig, { pos: p }, { pos: P + 0.18, duration: o.Tl, ease: 'power2.out', immediateRender: false, onUpdate: rig.r }, o.Td + Tc);
    tl.fromTo(rig, { pos: P + 0.18 }, { pos: P, duration: 0.32, ease: 'back.out(2.5)', immediateRender: false, onUpdate: rig.r }, o.Td + Tc + o.Tl);
    const end = o.Td + Tc + o.Tl + 0.32;
    tl.call(() => rig.settle(c.syms), null, end); tl.landAt = end;
    return tl;
  }
  /* speed up hard, hold, then a normal bounce stop */
  function fastLand(rig, c, o) {
    o = Object.assign({ boost: 1.6, hold: 1.2 }, o); const tl = gsap.timeline(), v2 = c.v * o.boost;
    tl.call(() => { rig.cssBlur = 1.6; }, null, 0);
    let p = velTween(tl, rig, c.p0, c.v, v2, 0.35, 0);
    tl.fromTo(rig, { pos: p }, { pos: p + v2 * o.hold, duration: o.hold, ease: 'none', immediateRender: false, onUpdate: rig.r }, 0.35);
    p += v2 * o.hold;
    const l = landSeq(rig, Object.assign({}, c, { p0: p, v: v2 }), [{ to: 0.3, d: 0.32, ease: 'power2.out' }, { to: 0, d: 0.36, ease: 'back.out(2.6)' }]);
    tl.add(l, 0.35 + o.hold); tl.landAt = 0.35 + o.hold + l.landAt;
    return tl;
  }

  /* deco helpers: absolute times, return a timeline to add at 0 */
  function pulseBetween(tl, node, from, to, o) {
    o = Object.assign({ peak: 1, low: 0.5, period: 0.22, inDur: 0.2 }, o);
    const span = to - from - o.inDur - 0.05, N = Math.max(1, Math.floor(span / o.period) - 1);
    tl.fromTo(node, { opacity: 0 }, { opacity: o.peak, duration: o.inDur, immediateRender: false }, from);
    if (span > o.period * 2) tl.to(node, { opacity: o.low, duration: o.period, yoyo: true, repeat: N % 2 ? N : N - 1, ease: 'sine.inOut' }, from + o.inDur);
    tl.to(node, { opacity: 0, duration: 0.25 }, to);
  }
  const deco = {
    glow(M, i, from, to, o) {
      o = Object.assign({ color: '#3be3ff', shade: true }, o); const tl = gsap.timeline();
      const g = overReel(M, i, 'mfx-over mfx-rglow'); g.style.setProperty('--c', o.color);
      pulseBetween(tl, g, from, to, { low: 0.45 });
      tl.fromTo(g, { scale: 1 }, { scale: 1.025, duration: 0.22, yoyo: true, repeat: Math.max(1, Math.floor((to - from) / 0.22)), ease: 'sine.inOut', immediateRender: false }, from);
      if (o.shade) {
        const s = overReel(M, i, 'mfx-over mfx-rshade');
        tl.fromTo(s, { opacity: 0, yPercent: -60 }, { opacity: 1, yPercent: 60, duration: 0.5, repeat: Math.max(0, Math.floor((to - from) / 0.5) - 1), ease: 'none', immediateRender: false }, from);
        tl.to(s, { opacity: 0, duration: 0.2 }, to); removeAt(tl, [s], to + 0.3);
      }
      removeAt(tl, [g], to + 0.3);
      return tl;
    },
    rays(M, i, from, to, o) {
      o = Object.assign({ cls: '' }, o); const tl = gsap.timeline(), p = pt(M.reels[i], M.back);
      const r = rays(M.back, p.x, p.y, p.h * 1.5, { cls: o.cls }), r2 = rays(M.back, p.x, p.y, p.h * 1.1, { cls: 'white' });
      tl.fromTo([r, r2], { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(1.6)', immediateRender: false }, from);
      tl.fromTo(r, { rotation: 0 }, { rotation: 90 * (to - from + 0.5) / 2, duration: to - from + 0.5, ease: 'none', immediateRender: false }, from);
      tl.fromTo(r2, { rotation: 0 }, { rotation: -60 * (to - from + 0.5) / 2, duration: to - from + 0.5, ease: 'none', immediateRender: false }, from);
      tl.to([r, r2], { scale: 1.12, duration: 0.4, yoyo: true, repeat: Math.max(1, Math.floor((to - from - 0.5) / 0.4)), ease: 'sine.inOut' }, from + 0.5);
      tl.to([r, r2], { opacity: 0, scale: 1.3, duration: 0.4, overwrite: false }, to);
      removeAt(tl, [r, r2], to + 0.45);
      return tl;
    },
    heartbeat(M, i, from, to) {
      const tl = gsap.timeline(), beats = Math.max(1, Math.floor((to - from) / 0.75));
      tl.fromTo(M.cam, { scale: 1 }, { keyframes: { scale: [1, 1.035, 1, 1.024, 1] }, duration: 0.75, ease: 'none', repeat: beats - 1, immediateRender: false }, from);
      return tl;
    },
    vignette(M, i, from, to, o) {
      o = Object.assign({ peak: 0.9 }, o); const tl = gsap.timeline(), p = pt(M.reels[i], M.root);
      S(tl, M.vig, { '--vx': (p.x / M.root.offsetWidth * 100) + '%', '--vy': (p.y / M.root.offsetHeight * 100) + '%' }, from);
      tl.fromTo(M.vig, { opacity: 0 }, { opacity: o.peak, duration: 0.7, ease: 'power2.out', immediateRender: false }, from)
        .to(M.vig, { opacity: 0, duration: 0.45 }, to);
      return tl;
    },
    push(M, i, from, to) {
      const tl = gsap.timeline(), p = pt(M.reels[i], M.cam), cx = M.cam.offsetWidth / 2;
      S(tl, M.cam, { transformOrigin: `${p.x}px ${p.y}px` }, from);
      tl.fromTo(M.cam, { scale: 1, x: 0 }, { scale: 1.16, x: (cx - p.x) * 0.3, duration: Math.max(0.6, (to - from) * 0.85), ease: 'power2.inOut', immediateRender: false }, from)
        .to(M.cam, { scale: 1, x: 0, duration: 0.55, ease: 'back.out(1.4)' }, to);
      S(tl, M.cam, { transformOrigin: '50% 45%' }, to + 0.6);
      return tl;
    },
    lightning(M, i, from, to) {
      const tl = gsap.timeline(); svgFit(M);
      const b = reelBox(M, i), pad = 3, x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad;
      const per = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      const bolt = () => {
        let d = '';
        per.forEach((q, k) => {
          if (!k) { d += `M${q[0]} ${q[1]}`; return; }
          const a = per[k - 1], steps = Math.max(3, Math.round(Math.hypot(q[0] - a[0], q[1] - a[1]) / 14));
          for (let s = 1; s <= steps; s++) {
            const t = s / steps, j = s === steps ? 0 : rnd(-5, 5), nx = a[1] === q[1] ? 0 : 1, ny = a[1] === q[1] ? 1 : 0;
            d += ` L${(a[0] + (q[0] - a[0]) * t + nx * j).toFixed(1)} ${(a[1] + (q[1] - a[1]) * t + ny * j).toFixed(1)}`;
          }
        });
        return d;
      };
      const g = sv('g', { opacity: 0 }, M.svg), glow = sv('path', { class: 'mfx-bolt g', d: bolt() }, g), core = sv('path', { class: 'mfx-bolt', d: bolt() }, g);
      tl.fromTo(g, { opacity: 0 }, { opacity: 1, duration: 0.08, immediateRender: false }, from);
      for (let t = from; t < to; t += 0.07) {
        const d1 = bolt(); S(tl, glow, { attr: { d: d1 } }, t); S(tl, core, { attr: { d: d1 } }, t);
        S(tl, g, { opacity: rnd(0.45, 1) }, t);
      }
      tl.to(g, { opacity: 0, duration: 0.2 }, to);
      const f = pt(M.reels[i], M.fx);
      for (let t = from + 0.1; t < to - 0.1; t += 0.28) {
        const side = Math.random() < 0.5, x = side ? f.x + (Math.random() < 0.5 ? -1 : 1) * f.w / 2 : f.x + rnd(-f.w / 2, f.w / 2), y = side ? f.y + rnd(-f.h / 2, f.h / 2) : f.y + (Math.random() < 0.5 ? -1 : 1) * f.h / 2;
        tl.add(burst(M.fx, x, y, { n: 6, kind: 'spark', speed: [80, 200], gravity: 300, dur: 0.45, size: [6, 11], colors: ['#ffffff', '#3be3ff', '#bff7ff'] }), t);
      }
      removeAt(tl, [g], to + 0.25);
      return tl;
    }
  };

  /** teaseRun(M, o) -> timeline. The shared anticipation scenario; o.deco(M, info) adds the look.
      info = {t0 (tease starts), land:[time per reel], from:[tease start per reel], tease:[reels], end} */
  function teaseRun(M, o) {
    o = Object.assign({ symbols: FX.DEMO.bonus, tease: [3, 4], mode: 'slow', hold: 1.25 }, o);
    const n = M.rigs.length, v = FX.cfg.speed, tl = gsap.timeline(), st = FX.start.G1, sp = FX.stop.S1, syms = o.symbols;
    const ends = M.rigs.map((rig, i) => { const r = st.ramp(rig, { i, n, M, v, opts: o }); tl.add(r.tl, 0); return r; });
    const cruiseTo = (i, t) => {
      const e = ends[i], rig = M.rigs[i];
      tl.fromTo(rig, { pos: e.pos }, { pos: e.pos + e.v * (t - e.end), duration: Math.max(0, t - e.end), ease: 'none', immediateRender: false, onUpdate: rig.r }, e.end);
      return e.pos + e.v * (t - e.end);
    };
    const info = { land: [], from: [], tease: o.tease, M };
    let t = Math.max(...ends.map(e => e.end)) + 0.4;
    for (let i = 0; i < n; i++) {
      if (o.tease.includes(i)) continue;
      const p0 = cruiseTo(i, t), l = sp.land(M.rigs[i], { i, n, M, p0, v, syms: syms[i] });
      tl.add(l, t); info.land[i] = t + l.landAt; t += 0.16;
    }
    info.t0 = Math.max(...info.land.filter(x => x != null)) + 0.1;
    let tt = info.t0;
    o.tease.forEach((i, j) => {
      const rig = M.rigs[i]; info.from[i] = tt; let l, tS;
      if (o.mode === 'slow') { tS = tt + (j ? 0.1 : 0.3); l = slowLand(rig, { i, n, M, p0: cruiseTo(i, tS), v, syms: syms[i] }, Object.assign(j ? { Tc: 0.45 } : {}, o.slow)); }
      else if (o.mode === 'fast') { tS = tt; l = fastLand(rig, { i, n, M, p0: cruiseTo(i, tS), v, syms: syms[i] }, { hold: o.hold }); }
      else { tS = tt + o.hold; l = sp.land(rig, { i, n, M, p0: cruiseTo(i, tS), v, syms: syms[i] }); }
      tl.add(l, tS); info.land[i] = tS + l.landAt; tt = info.land[i] + 0.05;
    });
    info.end = tt;
    // SURF badges pop as they land and keep a soft pulse while the tease runs
    for (let i = 0; i < n; i++) syms[i].forEach((k, row) => {
      if (k !== 'S1') return;
      const s = M.sym(i, row), t1 = info.land[i];
      tl.fromTo(s, { scale: 1 }, { keyframes: { scale: [1, 1.32, 1.1] }, duration: 0.4, ease: 'none', immediateRender: false }, t1);
      if (info.end - t1 > 0.8) tl.to(s, { scale: 1.18, duration: 0.3, yoyo: true, repeat: Math.max(1, Math.floor((info.end - t1 - 0.4) / 0.3)), ease: 'sine.inOut' }, t1 + 0.4);
      const p = pt(M.cell(i, row), M.fx);
      tl.add(ring(M.fx, p.x, p.y, { size: p.w * 1.6, color: '#ffd23f', width: 4 }), t1);
    });
    const scat = []; syms.forEach((col, i) => col.forEach((k, row) => { if (k === 'S1') scat.push(M.sym(i, row)); }));
    if (scat.length >= 3) tl.fromTo(scat, { scale: 1.1 }, { keyframes: { scale: [1.1, 1.4, 1.15], rotation: [0, -8, 0] }, duration: 0.6, ease: 'none', immediateRender: false }, info.end + 0.05);
    if (o.deco) tl.add(o.deco(M, info), 0);
    return tl;
  }
  FX.tease.run = teaseRun; FX.tease.slowLand = slowLand; FX.tease.fastLand = fastLand; Object.assign(FX.tease, { deco });

  function teaseDef(id, meta, o, decoFn) {
    return def('tease', id, Object.assign({ scene: 'start' }, meta), (M, opts) => teaseRun(M, Object.assign({}, o, opts, { deco: decoFn })));
  }
  /* run a deco on each tease reel in turn */
  const each = fn => (M, info) => { const tl = gsap.timeline(); info.tease.forEach(i => tl.add(fn(M, i, info.from[i], info.land[i], info), 0)); return tl; };

  teaseDef('T1', { title: 'Slow Roll', desc: 'The teasing reel brakes to a readable crawl, symbols creeping past one by one inside a pulsing sea-blue frame.', dur: '7.5s' }, { mode: 'slow' },
    each((M, i, a, b) => deco.glow(M, i, a, b)));
  teaseDef('T2', { title: 'Turbo Glow', desc: 'Instead of slowing, the reel speeds up into a blur behind a hot gold frame with a light streak racing down it.', dur: '7s' }, { mode: 'fast', hold: 1.0 },
    each((M, i, a, b) => deco.glow(M, i, a, b, { color: '#ffd23f' })));
  teaseDef('T3', { title: 'Light Rays', desc: 'Two layers of sun rays bloom and counter-rotate behind the teasing reel, shining through the glass.', dur: '7.5s' }, { mode: 'slow' },
    each((M, i, a, b) => { const tl = deco.rays(M, i, a, b); tl.add(deco.glow(M, i, a, b, { color: '#ffd23f', shade: false }), 0); return tl; }));
  teaseDef('T4', { title: 'Heartbeat', desc: 'The whole machine pumps on a double heartbeat while the reel crawls, with a soft darkening at the edges.', dur: '7.5s' }, { mode: 'slow' },
    (M, info) => { const tl = deco.heartbeat(M, 0, info.t0, info.end); tl.add(deco.vignette(M, info.tease[0], info.t0, info.end, { peak: 0.5 }), 0); info.tease.forEach(i => tl.add(deco.glow(M, i, info.from[i], info.land[i], { shade: false }), 0)); return tl; });
  teaseDef('T5', { title: 'Lightning Frame', desc: 'Electric bolts crackle around the teasing reel frame and throw sparks while it spins at turbo speed.', dur: '7s' }, { mode: 'fast', hold: 1.0 },
    each((M, i, a, b) => deco.lightning(M, i, a, b)));
  teaseDef('T6', { title: 'Camera Push-In', desc: 'The camera pushes in on the teasing reel as it slows, then eases back out when it lands.', dur: '7.5s' }, { mode: 'slow' },
    (M, info) => { const tl = deco.push(M, info.tease[0], info.t0, info.end); info.tease.forEach(i => tl.add(deco.glow(M, i, info.from[i], info.land[i], { shade: false }), 0)); return tl; });
  teaseDef('T7', { title: 'Spotlight Vignette', desc: 'Everything else falls into darkness; a spotlight stays on the teasing reels. Landed losers dim.', dur: '7.5s' }, { mode: 'slow' },
    (M, info) => {
      const tl = deco.vignette(M, info.tease[0], info.t0, info.end, { peak: 0.92 });
      const losers = []; FX.DEMO.bonus.forEach((col, i) => { if (!info.tease.includes(i)) col.forEach((k, row) => { if (k !== 'S1') losers.push(M.sym(i, row)); }); });
      tl.fromTo(losers, { opacity: 1 }, { opacity: 0.4, duration: 0.5, immediateRender: false }, info.t0).to(losers, { opacity: 1, duration: 0.4 }, info.end);
      return tl;
    });
  teaseDef('T8', { title: 'Full Drama', desc: 'Best-of stack: slow roll, glowing frame, rays, heartbeat, spotlight and sparks together. Use for the big moments only.', dur: '7.5s' }, { mode: 'slow' },
    (M, info) => {
      const tl = deco.heartbeat(M, 0, info.t0, info.end);
      tl.add(deco.vignette(M, info.tease[0], info.t0, info.end, { peak: 0.6 }), 0);
      info.tease.forEach(i => {
        const a = info.from[i], b = info.land[i];
        tl.add(deco.glow(M, i, a, b, { color: '#ffd23f' }), 0).add(deco.rays(M, i, a, b), 0);
        const f = pt(M.reels[i], M.fx);
        for (let t = a + 0.2; t < b - 0.1; t += 0.35) tl.add(burst(M.fx, f.x + rnd(-f.w / 2, f.w / 2), f.y + (Math.random() < 0.5 ? -1 : 1) * f.h / 2, { n: 5, kind: 'star', speed: [60, 160], gravity: 200, dur: 0.6, size: [6, 12], colors: ['#fff6c8', '#ffd23f'] }), t);
      });
      return tl;
    });
  REDUCED.tease = (M, o) => teaseRun(M, Object.assign({}, o, { mode: 'long', hold: 0.8, deco: each((M2, i, a, b) => { const tl = gsap.timeline(), g = overReel(M2, i, 'mfx-over mfx-rglow'); tl.fromTo(g, { opacity: 0 }, { opacity: 1, duration: 0.2, immediateRender: false }, a).to(g, { opacity: 0, duration: 0.2 }, b); return tl; }) }));

  /* ===================================================================================
     4. SYMBOL WIN  (P)
     MangoFX.win.Px(M, {hits:[[reel,row],...], dim:true, loops:2, color}) -> timeline
     Every variant dims the losing symbols and lifts the winning reels above their neighbours.
     =================================================================================== */
  function winPrep(M, o) {
    const hits = o.hits || FX.DEMO.hits, cells = hits.map(h => M.cell(h[0], h[1])), syms = cells.map(symOf), tl = gsap.timeline();
    raise(M, hits); if (o.dim !== false) tl.add(dim(M, hits), 0);
    return { hits, cells, syms, tl, loops: o.loops != null ? o.loops : 2 };
  }
  function addHalo(sym, color) { const h = el('i', 'mfx-halo mfx-add'); if (color) { h.style.setProperty('--c', color); h.style.setProperty('--c2', color); } sym.insertBefore(h, sym.firstChild); return h; }
  function addShine(sym) {
    const k = sym.parentNode && sym.parentNode._k, s = el('i', 'mfx-shine mfx-add', sym), bar = el('i', null, s);
    s.style.setProperty('--m', `url(${src(k || 'W')})`); return bar;
  }
  const centers = (M, cells) => cells.map(c => pt(c, M.fx));
  const winDef = (id, meta, fn) => def('win', id, Object.assign({ scene: 'line' }, meta), fn);

  winDef('P1', { title: 'Overshoot Pop', desc: 'Winners punch up to 130% with a tilt, settle at 112% and keep breathing. Strong, simple, readable.', dur: '2.6s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o);
    tl.fromTo(syms, { scale: 1, rotation: 0 }, { scale: 1.3, rotation: -5, duration: 0.2, ease: 'power2.out', stagger: 0.07, immediateRender: false }, 0.05)
      .to(syms, { scale: 1.12, rotation: 0, duration: 0.4, ease: 'back.out(3)', stagger: 0.07 }, 0.25)
      .to(syms, { scale: 1.2, duration: 0.35, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.95);
    return tl;
  });
  winDef('P2', { title: 'Jelly Wobble', desc: 'Squishy jelly wobble, stretching wide then tall, rippling along the line. Matches the hand-drawn style.', dur: '2.8s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o);
    tl.fromTo(syms, { scaleX: 1, scaleY: 1 }, { keyframes: { scaleX: [1, 1.26, 0.86, 1.12, 0.95, 1.04, 1], scaleY: [1, 0.8, 1.2, 0.9, 1.06, 0.98, 1] }, duration: 0.9, ease: 'none', stagger: 0.07, repeat: loops, repeatDelay: 0.25, immediateRender: false }, 0.05);
    return tl;
  });
  winDef('P3', { title: '3D Flip', desc: 'Each winner turns a full 360 degrees in 3D like a coin, one after another along the line.', dur: '3.0s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o);
    gsap.set(syms, { transformPerspective: 500 });
    tl.fromTo(syms, { rotationY: 0, scale: 1 }, { keyframes: { rotationY: [0, 180, 360], scale: [1, 1.24, 1.08] }, duration: 0.9, ease: 'power2.inOut', stagger: 0.09, repeat: loops, repeatDelay: 0.45, immediateRender: false }, 0.05);
    return tl;
  });
  winDef('P4', { title: 'Glow Halo', desc: 'A warm coloured halo blooms behind every winner and pulses. Soft and premium; pass {color} per symbol.', dur: '2.6s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o), halos = syms.map(s => addHalo(s, o.color));
    tl.fromTo(halos, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1.15, duration: 0.4, ease: 'back.out(2)', stagger: 0.06, immediateRender: false }, 0.05)
      .fromTo(syms, { scale: 1 }, { scale: 1.1, duration: 0.4, ease: 'back.out(2.5)', stagger: 0.06, immediateRender: false }, 0.05)
      .to(halos, { opacity: 0.55, scale: 0.95, duration: 0.4, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.7);
    return tl;
  });
  winDef('P5', { title: 'Shine Sweep', desc: 'A bright glint sweeps across each winner, masked to the drawn symbol shape so it never leaks outside the art.', dur: '2.8s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o), bars = syms.map(addShine);
    tl.fromTo(syms, { scale: 1 }, { scale: 1.1, duration: 0.35, ease: 'back.out(2.5)', stagger: 0.05, immediateRender: false }, 0.05)
      .fromTo(bars, { xPercent: 0 }, { xPercent: 330, duration: 0.7, ease: 'power2.inOut', stagger: 0.1, repeat: loops, repeatDelay: 0.5, immediateRender: false }, 0.2);
    return tl;
  });
  winDef('P6', { title: 'Rumble', desc: 'Winners shudder with an excited rumble, like they cannot sit still. Punchy for higher pays.', dur: '2.4s' }, (M, o) => {
    const { tl, syms, loops } = winPrep(M, o);
    tl.fromTo(syms, { scale: 1 }, { scale: 1.14, duration: 0.25, ease: 'back.out(3)', immediateRender: false }, 0.05)
      .fromTo(syms, { x: 0, rotation: 0 }, { keyframes: { x: [0, -3, 3, -3, 3, -2, 2, 0], rotation: [0, -6, 6, -5, 5, -2, 2, 0] }, duration: 0.45, ease: 'none', repeat: loops * 2, repeatDelay: 0.25, immediateRender: false }, 0.25);
    return tl;
  });
  winDef('P7', { title: 'Lift & Hover', desc: 'Winners float up off the reel and hover with a soft shadow shrinking underneath them.', dur: '2.8s' }, (M, o) => {
    const { tl, syms, cells, loops } = winPrep(M, o);
    const sh = cells.map(c => { const s = el('i', 'mfx-shadow mfx-add'); c.insertBefore(s, c.firstChild); return s; });
    tl.fromTo(syms, { yPercent: 0, scale: 1 }, { yPercent: -12, scale: 1.1, duration: 0.45, ease: 'back.out(2)', stagger: 0.05, immediateRender: false }, 0.05)
      .fromTo(sh, { opacity: 0, scale: 1 }, { opacity: 1, scale: 0.7, duration: 0.45, stagger: 0.05, immediateRender: false }, 0.05)
      .to(syms, { yPercent: -6, duration: 0.55, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.7)
      .to(sh, { scale: 0.85, opacity: 0.8, duration: 0.55, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.7);
    return tl;
  });
  winDef('P8', { title: 'Star Burst', desc: 'Each winner pops and fires a fountain of gold and pink stars, then a second smaller sparkle.', dur: '2.4s' }, (M, o) => {
    const { tl, syms, cells } = winPrep(M, o), cs = centers(M, cells);
    tl.fromTo(syms, { scale: 1 }, { keyframes: { scale: [1, 1.32, 1.12] }, duration: 0.45, ease: 'none', stagger: 0.07, immediateRender: false }, 0.05);
    cs.forEach((p, k) => {
      tl.add(burst(M.fx, p.x, p.y, { n: 14, kind: 'star', speed: [140, 320], gravity: 420, dur: 0.9, size: [p.w * 0.1, p.w * 0.2], colors: ['#fff6c8', '#ffd23f', '#ff8ab8'] }), 0.1 + k * 0.07);
      tl.add(burst(M.fx, p.x, p.y, { n: 8, kind: 'spark', speed: [60, 150], gravity: 120, dur: 0.7, size: [p.w * 0.08, p.w * 0.14], colors: ['#ffffff', '#3be3ff'] }), 0.75 + k * 0.07);
    });
    tl.to(syms, { scale: 1.18, duration: 0.35, yoyo: true, repeat: 3, ease: 'sine.inOut' }, 0.9);
    return tl;
  });
  winDef('P9', { title: 'Ring Shockwave', desc: 'Rings of light ripple out from every winner in waves, like drops hitting water.', dur: '2.6s' }, (M, o) => {
    const { tl, syms, cells, loops } = winPrep(M, o), cs = centers(M, cells);
    tl.fromTo(syms, { scale: 1 }, { scale: 1.12, duration: 0.3, ease: 'back.out(3)', stagger: 0.05, immediateRender: false }, 0.05);
    for (let w = 0; w <= loops; w++) cs.forEach((p, k) => {
      const t = 0.08 + w * 0.8 + k * 0.05;
      tl.add(ring(M.fx, p.x, p.y, { size: p.w * 1.9, color: '#bff7ff', width: 4, dur: 0.7 }), t);
      tl.add(ring(M.fx, p.x, p.y, { size: p.w * 1.4, color: '#ffffff', width: 2, dur: 0.6 }), t + 0.1);
      tl.fromTo(syms[k], { scale: 1.12 }, { keyframes: { scale: [1.12, 1.22, 1.12] }, duration: 0.3, ease: 'none', immediateRender: false }, t);
    });
    return tl;
  });
  winDef('P10', { title: 'Frame Draw', desc: 'A gold frame draws itself around each winning cell with a maroon outline, then sparkles at the corners.', dur: '2.6s' }, (M, o) => {
    const { tl, syms, hits, loops } = winPrep(M, o), { w } = svgFit(M), s = w / 420, g = sv('g', { class: 'mfx-add' }, M.svg), frames = [];
    hits.forEach(h => {
      const b = cellBox(M, h[0], h[1]), i = 2 * s, a = { x: b.x + i, y: b.y + i, width: b.w - 2 * i, height: b.h - 2 * i, rx: 12 * s, fill: 'none', pathLength: 100, 'stroke-linecap': 'round' };
      const o1 = sv('rect', Object.assign({}, a, { stroke: COL.ink, 'stroke-width': 6.5 * s }), g), o2 = sv('rect', Object.assign({}, a, { stroke: COL.gold, 'stroke-width': 3.2 * s }), g);
      [o1, o2].forEach(r => { r.style.strokeDasharray = '100 100'; r.style.strokeDashoffset = 100; r.style.opacity = 0; }); frames.push([o1, o2]);
    });
    frames.forEach((f, k) => {
      S(tl, f, { opacity: 1 }, 0.05 + k * 0.1);
      tl.to(f, { strokeDashoffset: 0, duration: 0.5, ease: 'power2.inOut' }, 0.05 + k * 0.1);
      const b = cellBox(M, hits[k][0], hits[k][1]), gp = pt(M.grid, M.fx), sc = gp.w / M.grid.clientWidth, ox = gp.x - gp.w / 2, oy = gp.y - gp.h / 2;
      [[b.x, b.y], [b.x + b.w, b.y + b.h]].forEach(q => tl.add(burst(M.fx, ox + q[0] * sc, oy + q[1] * sc, { n: 5, kind: 'star', speed: [40, 110], gravity: 80, dur: 0.6, size: [7, 12], colors: ['#fff6c8', '#ffd23f'] }), 0.5 + k * 0.1));
    });
    tl.fromTo(syms, { scale: 1 }, { scale: 1.08, duration: 0.35, ease: 'back.out(2.5)', stagger: 0.1, immediateRender: false }, 0.1);
    tl.to(frames.map(f => f[1]), { opacity: 0.4, duration: 0.35, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 1.1);
    return tl;
  });
  winDef('P11', { title: 'Chase', desc: 'Winners light up one after another along the line, like a marquee chase running left to right.', dur: '3.0s' }, (M, o) => {
    const { tl, syms, cells, loops } = winPrep(M, o), cs = centers(M, cells);
    tl.fromTo(syms, { scale: 1 }, { scale: 1.06, duration: 0.2, immediateRender: false }, 0);
    for (let pass = 0; pass <= loops; pass++) syms.forEach((sy, k) => {
      const t = 0.15 + pass * 0.95 + k * 0.12;
      tl.to(sy, { keyframes: { scale: [1.06, 1.34, 1.06], rotation: [0, k % 2 ? 6 : -6, 0] }, duration: 0.36, ease: 'none' }, t);
      tl.add(burst(M.fx, cs[k].x, cs[k].y, { n: 6, kind: 'spark', speed: [70, 160], gravity: 150, dur: 0.5, size: [8, 13], colors: ['#ffffff', '#ffd23f'] }), t + 0.05);
    });
    return tl;
  });
  winDef('P12', { title: 'Splash Pop', desc: 'Winners hop up out of the water and land back with a squash and a splash of sea spray. On-theme.', dur: '2.8s' }, (M, o) => {
    const { tl, syms, cells, loops } = winPrep(M, o), cs = centers(M, cells);
    for (let pass = 0; pass <= loops; pass++) syms.forEach((sy, k) => {
      const t = 0.05 + pass * 1.0 + k * 0.08;
      tl.to(sy, { yPercent: -22, scaleX: 0.92, scaleY: 1.1, duration: 0.22, ease: 'power2.out' }, t)
        .to(sy, { yPercent: 0, scaleX: 1, scaleY: 1, duration: 0.2, ease: 'power2.in' }, t + 0.22)
        .to(sy, { keyframes: { scaleX: [1, 1.18, 0.96, 1.08], scaleY: [1, 0.84, 1.05, 1.06] }, transformOrigin: '50% 100%', duration: 0.3, ease: 'none' }, t + 0.42);
      tl.add(splash(M.fx, cs[k].x, cs[k].y + cs[k].h * 0.38, { n: 7, power: cs[k].w / 110, ripple: pass === 0 }), t + 0.42);
    });
    return tl;
  });
  winDef('P13', { title: 'Premium Stack', desc: 'Best-of: elastic pop, gold halo, masked shine and a light ring per winner. The richest single option.', dur: '3.0s' }, (M, o) => {
    const { tl, syms, cells, loops } = winPrep(M, o), cs = centers(M, cells), halos = syms.map(s => addHalo(s)), bars = syms.map(addShine);
    tl.fromTo(syms, { scale: 1 }, { scale: 1.14, duration: 0.55, ease: 'mfx.pop', stagger: 0.07, immediateRender: false }, 0.05)
      .fromTo(halos, { opacity: 0, scale: 0.4 }, { opacity: 0.9, scale: 1.1, duration: 0.45, ease: 'back.out(2)', stagger: 0.07, immediateRender: false }, 0.05)
      .fromTo(bars, { xPercent: 0 }, { xPercent: 330, duration: 0.7, ease: 'power2.inOut', stagger: 0.08, repeat: loops, repeatDelay: 0.6, immediateRender: false }, 0.45)
      .to(halos, { opacity: 0.5, scale: 0.95, duration: 0.45, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.7)
      .to(syms, { scale: 1.2, duration: 0.45, yoyo: true, repeat: loops * 2 + 1, ease: 'sine.inOut' }, 0.7);
    cs.forEach((p, k) => tl.add(ring(M.fx, p.x, p.y, { size: p.w * 1.7, color: '#ffe680', width: 3, dur: 0.6 }), 0.12 + k * 0.07));
    return tl;
  });
  REDUCED.win = (M, o) => {
    const { tl, syms } = winPrep(M, o), halos = syms.map(s => addHalo(s));
    tl.fromTo(halos, { opacity: 0 }, { opacity: 0.8, duration: 0.4, immediateRender: false }, 0.05);
    return tl;
  };

  /* ===================================================================================
     5. WIN LINE  (L)
     MangoFX.line.Lx(M, {line:[rows per reel], color, hits, dim:true}) -> timeline
     Lines live in M.svg (grid pixel space) and pass through cell centres, extended a little past the
     first and last reel.
     =================================================================================== */
  let gid = 0;
  function linePts(M, line, ext) {
    ext = ext == null ? 0.42 : ext;
    const pts = line.map((row, r) => { const b = cellBox(M, r, row); return [b.cx, b.cy]; });
    const w = cellBox(M, 0, 0).w; pts.unshift([pts[0][0] - w * ext, pts[0][1]]); pts.push([pts[pts.length - 1][0] + w * ext, pts[pts.length - 1][1]]);
    return pts;
  }
  function dPath(pts, smooth) {
    if (!smooth) return 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2, t = smooth;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6 * t, p1[1] + (p2[1] - p0[1]) / 6 * t], c2 = [p2[0] - (p3[0] - p1[0]) / 6 * t, p2[1] - (p3[1] - p1[1]) / 6 * t];
      d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }
  function wavyD(pts, amp, wl) {
    const out = []; let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L, n = Math.max(2, Math.ceil(L / 4));
      for (let j = 0; j < n; j++) { const t = j / n, a = Math.sin((dist + t * L) / wl * Math.PI * 2) * amp; out.push([x0 + (x1 - x0) * t + nx * a, y0 + (y1 - y0) * t + ny * a]); }
      dist += L;
    }
    out.push(pts[pts.length - 1]);
    return 'M' + out.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');
  }
  function stroke(g, d, color, width, extra) {
    return sv('path', Object.assign({ d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, extra || {}), g);
  }
  /* draw paths on (stroke-dashoffset), hidden until their start */
  function drawIn(tl, paths, dur, at, ease) {
    paths.forEach(p => { const L = p.getTotalLength(); p.style.strokeDasharray = L + ' ' + (L + 10); p.style.strokeDashoffset = L; p.style.opacity = 0; });
    S(tl, paths, { opacity: 1 }, at);
    tl.fromTo(paths, { strokeDashoffset: (i, p) => p.getTotalLength() }, { strokeDashoffset: 0, duration: dur, ease: ease || 'power1.inOut', immediateRender: false }, at);
  }
  function grad(M, color) {
    let defs = M.svg.querySelector('defs'); if (!defs) defs = sv('defs', {}, M.svg);
    const id = 'mfxg' + (++gid), r = sv('radialGradient', { id }, defs);
    sv('stop', { offset: '0', 'stop-color': '#ffffff' }, r); sv('stop', { offset: '0.35', 'stop-color': color }, r); sv('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '0' }, r);
    return `url(#${id})`;
  }
  function g2fx(M) { const gp = pt(M.grid, M.fx), sc = gp.w / M.grid.clientWidth, ox = gp.x - gp.w / 2, oy = gp.y - gp.h / 2; return (x, y) => ({ x: ox + x * sc, y: oy + y * sc }); }
  function linePrep(M, o) {
    const line = o.line || FX.DEMO.lines.A, hits = o.hits || lineHits(line), tl = gsap.timeline(), { w } = svgFit(M);
    if (o.dim !== false) { raise(M, hits); tl.add(dim(M, hits, { opacity: 0.5 }), 0); }
    return { line, hits, tl, s: w / 420, g: sv('g', { class: 'mfx-add' }, M.svg), pts: linePts(M, line), color: o.color || COL.gold };
  }
  const lineDef = (id, meta, fn) => def('line', id, Object.assign({ scene: 'line' }, meta), fn);

  lineDef('L1', { title: 'Comet Line', desc: 'A glowing comet races along the payline, drawing the line behind it, then bursts at the end. The line keeps a soft glow.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts, color } = linePrep(M, o), d = dPath(pts, 1), f = g2fx(M);
    const glow = stroke(g, d, color, 16 * s, { opacity: 0.28 }), out = stroke(g, d, COL.ink, 9 * s), body = stroke(g, d, color, 5.5 * s), core = stroke(g, d, '#fff', 2 * s, { opacity: 0.9 });
    drawIn(tl, [glow, out, body, core], 0.9, 0.1);
    const fill = grad(M, color), head = sv('g', { opacity: 0 }, g);
    sv('circle', { cx: 0, cy: 0, r: 17 * s, fill }, head); sv('circle', { cx: 0, cy: 0, r: 4.5 * s, fill: '#fff' }, head);
    const trail = []; for (let i = 0; i < 8; i++) trail.push(sv('circle', { cx: 0, cy: 0, r: (6.5 - i * 0.6) * s, fill: i % 2 ? '#fff' : color, opacity: 0 }, g));
    S(tl, head, { opacity: 1 }, 0.1);
    tl.to(head, { motionPath: { path: body, align: body, alignOrigin: [0.5, 0.5] }, duration: 0.9, ease: 'power1.inOut' }, 0.1);
    trail.forEach((c, i) => { S(tl, c, { opacity: 0.85 - i * 0.09 }, 0.1 + i * 0.022); tl.to(c, { motionPath: { path: body, align: body, alignOrigin: [0.5, 0.5] }, duration: 0.9, ease: 'power1.inOut' }, 0.1 + i * 0.022); tl.to(c, { opacity: 0, duration: 0.15 }, 1.0 + i * 0.022); });
    tl.to(head, { opacity: 0, scale: 2, transformOrigin: '50% 50%', duration: 0.25 }, 1.0);
    const e = f(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    tl.add(burst(M.fx, e.x, e.y, { n: 12, kind: 'spark', speed: [80, 220], gravity: 200, dur: 0.6, size: [8, 14], colors: ['#fff', color] }), 1.0);
    tl.to(glow, { opacity: 0.65, duration: 0.4, yoyo: true, repeat: 3, ease: 'sine.inOut' }, 1.1);
    return tl;
  });
  lineDef('L2', { title: 'Neon Double', desc: 'Two neon tubes, pink and cyan, flicker on like a beach-bar sign and keep a faint electric buzz.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts } = linePrep(M, o), off = 3.6 * s, gs = [];
    [['#ff4f8b', -off], ['#3be3ff', off]].forEach(([c, dy]) => {
      const d = dPath(pts.map(p => [p[0], p[1] + dy]), 0.8), sub = sv('g', { opacity: 0 }, g);
      stroke(sub, d, c, 13 * s, { opacity: 0.3 }); stroke(sub, d, c, 5 * s); stroke(sub, d, '#ffffff', 1.8 * s, { opacity: 0.95 }); gs.push(sub);
    });
    gs.forEach((sub, k) => tl.fromTo(sub, { opacity: 0 }, { keyframes: { opacity: [0, 1, 0.15, 1, 0.3, 0.9, 1] }, duration: 0.55, ease: 'steps(6)', immediateRender: false }, 0.1 + k * 0.18));
    tl.to(gs, { keyframes: { opacity: [1, 0.55, 1, 0.8, 1] }, duration: 0.25, ease: 'steps(4)', repeat: 2, repeatDelay: 0.45 }, 1.0);
    return tl;
  });
  lineDef('L3', { title: 'Sparkle Trail', desc: 'A dotted trail of little stars pops on along the line, then the stars twinkle at random.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts, color } = linePrep(M, o), d = dPath(pts, 1), base = stroke(g, d, '#ffffff', 2 * s, { opacity: 0.35 });
    drawIn(tl, [base], 0.7, 0.1, 'none');
    const L = base.getTotalLength(), step = 16 * s, stars = [], r = 7 * s;
    const star = (x, y) => `M${x} ${y - r} L${x + r * 0.28} ${y - r * 0.28} L${x + r} ${y} L${x + r * 0.28} ${y + r * 0.28} L${x} ${y + r} L${x - r * 0.28} ${y + r * 0.28} L${x - r} ${y} L${x - r * 0.28} ${y - r * 0.28}Z`;
    for (let l = 0; l <= L; l += step) {
      const p = base.getPointAtLength(l), st = sv('path', { d: star(p.x, p.y), fill: (stars.length % 3) ? color : '#ffffff', stroke: COL.ink, 'stroke-width': 0.8 * s, opacity: 0 }, g);
      gsap.set(st, { scale: 0, smoothOrigin: false, svgOrigin: `${p.x} ${p.y}` }); stars.push(st);
    }
    tl.to(stars, { opacity: 1, scale: 1.4, rotation: 45, duration: 0.25, ease: 'back.out(3)', stagger: 0.7 / stars.length }, 0.1)
      .to(stars, { scale: 0.9, duration: 0.2, stagger: 0.7 / stars.length }, 0.35);
    tl.to(stars, { scale: 1.5, opacity: 0.6, duration: 0.3, yoyo: true, repeat: 3, ease: 'sine.inOut', stagger: { amount: 0.6, from: 'random' } }, 1.0);
    return tl;
  });
  lineDef('L4', { title: 'Sine Wave', desc: 'A wavy sea-blue line draws itself through the cells, then white foam flows along it.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts } = linePrep(M, o), d = wavyD(pts, 5 * s, 34 * s);
    const out = stroke(g, d, COL.ink, 8.5 * s), body = stroke(g, d, o.color || '#3be3ff', 4.8 * s), foam = stroke(g, d, '#ffffff', 1.8 * s, { 'stroke-dasharray': `${6 * s} ${10 * s}`, opacity: 0 });
    drawIn(tl, [out, body], 0.8, 0.1, 'power1.inOut');
    tl.to(foam, { opacity: 0.95, duration: 0.3 }, 0.8).fromTo(foam, { strokeDashoffset: 0 }, { strokeDashoffset: -32 * s, duration: 0.5, ease: 'none', repeat: 3, immediateRender: false }, 0.8);
    return tl;
  });
  lineDef('L5', { title: 'Box Chain', desc: 'Gold boxes pop around each winning cell in turn, linked by short connectors that draw between them.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, hits } = linePrep(M, o), boxes = [], links = [];
    hits.forEach((h, k) => {
      const b = cellBox(M, h[0], h[1]), i = 3 * s, a = { x: b.x + i, y: b.y + i, width: b.w - 2 * i, height: b.h - 2 * i, rx: 11 * s, fill: 'rgba(255,210,63,.12)' };
      const bx = sv('g', { opacity: 0 }, g); sv('rect', Object.assign({}, a, { stroke: COL.ink, 'stroke-width': 6 * s }), bx); sv('rect', Object.assign({}, a, { stroke: COL.gold, 'stroke-width': 3 * s, fill: 'none' }), bx);
      boxes.push(bx);
      if (k) { const p = cellBox(M, hits[k - 1][0], hits[k - 1][1]); links.push([stroke(g, `M${p.x + p.w - i} ${p.cy} L${b.x + i} ${b.cy}`, COL.ink, 6 * s), stroke(g, `M${p.x + p.w - i} ${p.cy} L${b.x + i} ${b.cy}`, COL.gold, 3 * s)]); }
    });
    boxes.forEach((bx, k) => {
      const bb = cellBox(M, hits[k][0], hits[k][1]);
      tl.fromTo(bx, { opacity: 0, scale: 0.55 }, { opacity: 1, scale: 1, smoothOrigin: false, svgOrigin: `${bb.cx} ${bb.cy}`, duration: 0.35, ease: 'back.out(2.6)', immediateRender: false }, 0.1 + k * 0.16);
      tl.fromTo(M.sym(hits[k][0], hits[k][1]), { scale: 1 }, { keyframes: { scale: [1, 1.2, 1.06] }, duration: 0.35, ease: 'none', immediateRender: false }, 0.1 + k * 0.16);
      if (links[k]) drawIn(tl, links[k], 0.12, 0.05 + k * 0.16, 'none');
    });
    tl.to(boxes, { opacity: 0.55, duration: 0.3, yoyo: true, repeat: 3, stagger: 0.06, ease: 'sine.inOut' }, 1.1);
    return tl;
  });
  lineDef('L6', { title: 'Pulse Line', desc: 'A thick line draws in fast, then throbs with light three times like it is charged with energy.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts, color } = linePrep(M, o), d = dPath(pts, 0.6);
    const halo = stroke(g, d, color, 22 * s, { opacity: 0 }), glow = stroke(g, d, color, 12 * s, { opacity: 0.35 }), out = stroke(g, d, COL.ink, 9 * s), body = stroke(g, d, color, 5.5 * s), core = stroke(g, d, '#fff', 2.2 * s);
    drawIn(tl, [glow, out, body, core], 0.55, 0.1, 'power2.out');
    tl.to(halo, { keyframes: { opacity: [0, 0.45, 0] }, duration: 0.5, repeat: 2, ease: 'sine.inOut' }, 0.7)
      .to(glow, { keyframes: { opacity: [0.35, 0.95, 0.35] }, duration: 0.5, repeat: 2, ease: 'sine.inOut' }, 0.7)
      .to(core, { keyframes: { opacity: [1, 0.4, 1] }, duration: 0.5, repeat: 2, ease: 'sine.inOut' }, 0.7);
    return tl;
  });
  lineDef('L7', { title: 'Multi-line Cycle', desc: 'Three wins: every line draws in its own colour with a number tag, then each one gets its own turn in the spotlight.', dur: '4.6s' }, (M, o) => {
    const ls = o.lines || [['A', COL.gold], ['B', COL.pink], ['C', COL.cyan]];
    const allHits = [], seen = new Set();
    ls.forEach(([k]) => lineHits(FX.DEMO.lines[k]).forEach(h => { const key = h.join(); if (!seen.has(key)) { seen.add(key); allHits.push(h); } }));
    const { tl, s, g } = linePrep(M, { line: FX.DEMO.lines.A, hits: allHits }), groups = [];
    ls.forEach(([k, c], j) => {
      const line = FX.DEMO.lines[k], pts = linePts(M, line), d = dPath(pts, 0.5), sub = sv('g', {}, g);
      const ps = [stroke(sub, d, COL.ink, 8 * s), stroke(sub, d, c, 4.5 * s), stroke(sub, d, '#fff', 1.4 * s, { opacity: 0.8 })];
      const tag = sv('g', { opacity: 0 }, sub); sv('circle', { cx: pts[0][0], cy: pts[0][1], r: 9 * s, fill: c, stroke: COL.ink, 'stroke-width': 2.4 * s }, tag);
      const tx = sv('text', { x: pts[0][0], y: pts[0][1] + 4 * s, 'text-anchor': 'middle', 'font-size': 12 * s, fill: COL.ink, 'font-family': 'Lilita One, system-ui, sans-serif' }, tag); tx.textContent = FX.DEMO.lineNo[k];
      drawIn(tl, ps, 0.55, 0.1 + j * 0.3, 'power1.inOut');
      tl.fromTo(tag, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, smoothOrigin: false, svgOrigin: `${pts[0][0]} ${pts[0][1]}`, duration: 0.3, ease: 'back.out(3)', immediateRender: false }, 0.1 + j * 0.3);
      groups.push({ sub, hits: lineHits(line) });
    });
    groups.forEach((gr, j) => {
      const t = 1.4 + j * 1.0;
      tl.to(groups.filter(x => x !== gr).map(x => x.sub), { opacity: 0.15, duration: 0.2 }, t).to(gr.sub, { opacity: 1, duration: 0.2 }, t);
      tl.to(gr.hits.map(h => M.sym(h[0], h[1])), { keyframes: { scale: [1, 1.22, 1.08] }, duration: 0.45, ease: 'none', stagger: 0.05 }, t + 0.05);
      tl.to(gr.hits.map(h => M.sym(h[0], h[1])), { scale: 1, duration: 0.2 }, t + 0.85);
    });
    tl.to(groups.map(x => x.sub), { opacity: 1, duration: 0.3 }, 1.4 + groups.length * 1.0);
    return tl;
  });
  lineDef('L8', { title: 'Foam Line', desc: 'The current game look done in GSAP: maroon edge, colour body and white foam dashes flowing along it.', dur: '2.4s' }, (M, o) => {
    const { tl, s, g, pts, color } = linePrep(M, o), d = dPath(pts, 0);
    const out = stroke(g, d, COL.ink, 9 * s), body = stroke(g, d, color, 5 * s), foam = stroke(g, d, '#ffffff', 2 * s, { 'stroke-dasharray': `${6 * s} ${9 * s}`, opacity: 0 });
    body.style.filter = 'drop-shadow(0 0 4px rgba(255,255,255,.55))';
    drawIn(tl, [out, body], 0.5, 0.1, 'power1.out');
    tl.to(foam, { opacity: 0.85, duration: 0.3 }, 0.55).fromTo(foam, { strokeDashoffset: 0 }, { strokeDashoffset: -15 * s, duration: 0.5, ease: 'none', repeat: 3, immediateRender: false }, 0.55);
    return tl;
  });
  lineDef('L9', { title: 'Surfer Ride', desc: 'The wild mango surfs the payline on his board, carving a water trail behind him and splashing every winning cell.', dur: '2.8s' }, (M, o) => {
    const { tl, s, g, pts, hits } = linePrep(M, o), d = dPath(pts, 1), f = g2fx(M), cw = cellBox(M, 0, 0).w;
    const out = stroke(g, d, COL.ink, 9 * s), body = stroke(g, d, '#3be3ff', 5.5 * s), foam = stroke(g, d, '#ffffff', 2 * s, { 'stroke-dasharray': `${5 * s} ${8 * s}` });
    const D = 1.5; drawIn(tl, [out, body, foam], D, 0.15, 'none');
    const im = sv('image', { href: src('W'), width: cw * 0.95, height: cw * 0.95, x: 0, y: 0, opacity: 0 }, g);
    S(tl, im, { opacity: 1 }, 0.15);
    tl.to(im, { motionPath: { path: body, align: body, alignOrigin: [0.5, 0.62] }, duration: D, ease: 'none' }, 0.15);
    tl.fromTo(im, { rotation: -8 }, { rotation: 8, transformOrigin: '50% 60%', duration: 0.25, yoyo: true, repeat: Math.round(D / 0.25) - 1, ease: 'sine.inOut', immediateRender: false }, 0.15);
    tl.to(im, { opacity: 0, scale: 0.4, transformOrigin: '50% 50%', duration: 0.25 }, 0.15 + D);
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    hits.forEach(h => {
      const b = cellBox(M, h[0], h[1]), t = 0.15 + D * (b.cx - x0) / (x1 - x0), p = f(b.cx, b.cy);
      tl.add(splash(M.fx, p.x, p.y + b.h * 0.25, { n: 8, power: b.w / 110, ripple: false }), t);
      tl.to(M.sym(h[0], h[1]), { keyframes: { scale: [1, 1.25, 1.1] }, duration: 0.4, ease: 'none' }, t);
    });
    const e = f(x1, pts[pts.length - 1][1]); tl.add(splash(M.fx, e.x, e.y, { n: 14, power: cw / 90 }), 0.15 + D);
    return tl;
  });
  REDUCED.line = (M, o) => {
    const { tl, s, g, pts, color } = linePrep(M, o), d = dPath(pts, 0.6), ps = [stroke(g, d, COL.ink, 9 * s), stroke(g, d, color, 5 * s)];
    tl.fromTo(ps, { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, 0.05); return tl;
  };
  FX.line.points = linePts; FX.line.path = dPath;

  /* ===================================================================================
     6. WIN AMOUNT / COUNTER  (C)
     MangoFX.count.Cx(M, {amount:12.5, hits, bet}) -> timeline. Writes into M.winval / M.winbox.
     =================================================================================== */
  function countPrep(M, o) {
    const amount = o.amount != null ? o.amount : 12.5, tl = gsap.timeline();
    M.winval.textContent = money(0);
    return { amount, tl, box: pt(M.winbox, M.fx) };
  }
  const countDef = (id, meta, fn) => def('count', id, Object.assign({ scene: 'line' }, meta), fn);
  /** odometer(node, text, o) -> tl. Rolls each digit of text into place; non-digits stay still. */
  function odometer(node, str, o) {
    o = Object.assign({ dur: 1.0, step: 0.14 }, o); node.textContent = ''; const tl = gsap.timeline(), cols = [];
    [...str].forEach(ch => {
      if (!/\d/.test(ch)) { el('span', 'mfx-ch', node).textContent = ch; return; }
      const box = el('span', 'mfx-odo', node), inner = el('span', null, box); cols.push({ inner, d: +ch });
    });
    cols.forEach((c, k) => {
      const cycles = 1 + k, list = [];
      for (let j = 0; j < cycles; j++) for (let x = 0; x < 10; x++) list.push(x);
      for (let x = 0; x <= c.d; x++) list.push(x);
      list.push((c.d + 1) % 10);
      list.forEach(x => { el('span', null, c.inner).textContent = x; });
      const end = -(list.length - 2) / list.length * 100;
      tl.fromTo(c.inner, { yPercent: 0 }, { yPercent: end, duration: o.dur + k * o.step, ease: 'back.out(1.3)', immediateRender: false }, 0);
    });
    return tl;
  }
  countDef('C1', { title: 'Odometer Roll', desc: 'Every digit rolls like a slot reel; the right-hand digits spin longest and each lands with a tiny bounce.', dur: '2.2s' }, (M, o) => {
    const { amount, tl, box } = countPrep(M, o), od = odometer(M.winval, money(amount), { dur: 0.8, step: 0.13 });
    tl.add(od, 0.1);
    const t = 0.1 + od.duration();
    tl.fromTo(M.winbox, { scale: 1 }, { keyframes: { scale: [1, 1.12, 1] }, duration: 0.35, ease: 'none', immediateRender: false }, t - 0.1);
    tl.add(burst(M.fx, box.x, box.y, { n: 10, kind: 'star', speed: [90, 220], gravity: 260, dur: 0.7, size: [8, 14], colors: ['#ffd23f', '#fff6c8'] }), t - 0.1);
    return tl;
  });
  countDef('C2', { title: 'Punch-in', desc: 'The final amount punches in from huge to normal size with a bounce, a shockwave ring and a shudder of the win box.', dur: '1.4s' }, (M, o) => {
    const { amount, tl, box } = countPrep(M, o);
    tl.call(() => { M.winval.textContent = money(amount); }, null, 0.1);
    tl.fromTo(M.winval, { scale: 2.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.42, ease: 'back.out(2.2)', immediateRender: false }, 0.1)
      .add(ring(M.fx, box.x, box.y, { size: box.w * 1.3, color: '#ffd23f', width: 5, sy: 0.55, dur: 0.6 }), 0.32)
      .add(shake(M.winbox, { amp: 4, dur: 0.3 }), 0.32)
      .fromTo(M.winbox, { scale: 1 }, { scale: 1.06, duration: 0.3, yoyo: true, repeat: 1, ease: 'sine.inOut', immediateRender: false }, 0.65);
    return tl;
  });
  countDef('C3', { title: 'Coin Fly', desc: 'Gold coins spin out of every winning cell and arc into the win box; the box bumps and the total climbs as they arrive.', dur: '2.2s' }, (M, o) => {
    const { amount, tl, box } = countPrep(M, o), hits = o.hits || FX.DEMO.hits, cs = hits.map(h => pt(M.cell(h[0], h[1]), M.fx)), per = 3;
    const coins = makeParticles(M.fx, cs.length * per, 'mfx-coin', p => sizeP(p, cs[0].w * 0.32));
    let first = 9, last = 0;
    coins.forEach((c, j) => {
      const s = cs[Math.floor(j / per)], t = 0.1 + j * 0.045, sx = s.x + rnd(-8, 8), sy = s.y + rnd(-8, 8);
      S(tl, c, { x: sx, y: sy, opacity: 1, scale: 0.3 }, t);
      tl.to(c, { scale: 1, duration: 0.15, ease: 'back.out(3)' }, t);
      tl.to(c, { motionPath: { path: [{ x: sx, y: sy }, { x: (sx + box.x) / 2 + rnd(-40, 40), y: Math.min(sy, box.y) - rnd(40, 90) }, { x: box.x + rnd(-10, 10), y: box.y }], curviness: 1.2 }, duration: 0.7, ease: 'power1.in' }, t + 0.05);
      tl.to(c, { scaleX: 0.15, duration: 0.12, yoyo: true, repeat: 5, ease: 'sine.inOut' }, t + 0.05);
      tl.to(c, { opacity: 0, scale: 0.5, duration: 0.08 }, t + 0.72);
      tl.fromTo(M.winbox, { scale: 1 }, { keyframes: { scale: [1, 1.05, 1] }, duration: 0.14, ease: 'none', immediateRender: false }, t + 0.74);
      first = Math.min(first, t + 0.74); last = Math.max(last, t + 0.74);
    });
    tl.add(count(M.winval, 0, amount, last - first + 0.1, { ease: 'none' }), first);
    removeAt(tl, coins, last + 0.2);
    tl.add(burst(M.fx, box.x, box.y, { n: 12, kind: 'star', speed: [90, 220], gravity: 260, dur: 0.7, size: [8, 14], colors: ['#ffd23f', '#fff6c8'] }), last + 0.05);
    return tl;
  });
  countDef('C4', { title: 'Tick & Slam', desc: 'The count starts slow and ticks faster and faster, then the final number slams down with a shake and a flash.', dur: '3.0s' }, (M, o) => {
    const { amount, tl, box } = countPrep(M, o), T = 2.0, N = 16;
    tl.add(count(M.winval, 0, amount, T, { ease: 'power2.in' }), 0.1);
    for (let k = 1; k < N; k++) tl.fromTo(M.winval, { scale: 1 }, { keyframes: { scale: [1, 1.09, 1] }, duration: 0.07, ease: 'none', immediateRender: false }, 0.1 + T * Math.cbrt(k / N));
    const t = 0.1 + T;
    tl.to(M.winval, { scale: 1.75, duration: 0.12, ease: 'power2.out' }, t).to(M.winval, { scale: 1, duration: 0.14, ease: 'power4.in' }, t + 0.12);
    tl.add(shake(M.winbox, { amp: 5, dur: 0.3 }), t + 0.26).add(shake(M.cam, { amp: 3, dur: 0.25 }), t + 0.26)
      .add(ring(M.fx, box.x, box.y, { size: box.w * 1.4, color: '#fff', width: 4, sy: 0.55 }), t + 0.26)
      .add(burst(M.fx, box.x, box.y, { n: 14, kind: 'star', speed: [120, 260], gravity: 300, dur: 0.8, size: [8, 15], colors: ['#ffd23f', '#fff6c8', '#ff8ab8'] }), t + 0.26);
    return tl;
  });
  countDef('C5', { title: 'Floating Amounts', desc: 'Small "+$2.50" values float up out of each winning cell, then the total "+$12.50" rises over the line.', dur: '2.4s' }, (M, o) => {
    const { amount, tl } = countPrep(M, o), hits = o.hits || FX.DEMO.hits, cs = hits.map(h => pt(M.cell(h[0], h[1]), M.fx)), part = amount / hits.length;
    cs.forEach((p, k) => {
      const f = el('div', 'mfx-float mfx-add', M.fx); f.textContent = '+' + money(part); f.style.fontSize = '3.6cqw';
      gsap.set(f, { x: p.x, y: p.y, xPercent: -50, yPercent: -50 });
      tl.fromTo(f, { opacity: 0, scale: 0.4, y: p.y }, { opacity: 1, scale: 1, y: p.y - p.h * 0.35, duration: 0.3, ease: 'back.out(2.5)', immediateRender: false }, 0.1 + k * 0.1)
        .to(f, { y: p.y - p.h * 0.85, opacity: 0, duration: 0.6, ease: 'power1.in' }, 0.5 + k * 0.1);
    });
    const mid = cs[Math.floor(cs.length / 2)], big = el('div', 'mfx-float mfx-add', M.fx); big.textContent = '+' + money(amount);
    gsap.set(big, { x: mid.x, y: mid.y, xPercent: -50, yPercent: -50 });
    tl.fromTo(big, { opacity: 0, scale: 0.3, y: mid.y }, { opacity: 1, scale: 1.15, y: mid.y - mid.h * 0.5, duration: 0.4, ease: 'back.out(2.2)', immediateRender: false }, 0.9)
      .to(big, { scale: 1, duration: 0.2 }, 1.3)
      .to(big, { y: mid.y - mid.h * 1.3, opacity: 0, duration: 0.7, ease: 'power1.in' }, 1.6);
    tl.add(count(M.winval, 0, amount, 0.6), 1.0);
    return tl;
  });
  countDef('C6', { title: 'Win Pill', desc: 'A cream label pops above the last winning cell with the full maths (line, count, symbol, pay x multiplier), then the box counts.', dur: '2.4s' }, (M, o) => {
    const { amount, tl } = countPrep(M, o), hits = o.hits || FX.DEMO.hits, last = pt(M.cell(...hits[hits.length - 1]), M.fx);
    const p = el('div', 'mfx-pill mfx-add', M.fx);
    p.innerHTML = `<span class="ln">LINE ${o.lineNo || 7}</span><span>${hits.length}×</span><img src="${src(o.symbol || 'H3')}" alt=""><span>${money(amount / 5)} × 5 = <span class="tot">${money(amount)}</span></span>`;
    const pw = p.offsetWidth, x = clamp(last.x, pw / 2 + 6, M.fx.offsetWidth - pw / 2 - 6), below = last.y - last.h * 0.55 - p.offsetHeight < 4;
    gsap.set(p, { x, y: below ? last.y + last.h * 0.55 : last.y - last.h * 0.55, xPercent: -50, yPercent: below ? 0 : -100 });
    tl.fromTo(p, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, transformOrigin: below ? '50% 0%' : '50% 100%', duration: 0.38, ease: 'back.out(2.6)', immediateRender: false }, 0.15)
      .fromTo(p.querySelector('.tot'), { scale: 1 }, { keyframes: { scale: [1, 1.35, 1] }, duration: 0.35, ease: 'none', immediateRender: false }, 0.55);
    tl.add(count(M.winval, 0, amount, 0.8), 0.6);
    tl.fromTo(M.winbox, { scale: 1 }, { keyframes: { scale: [1, 1.08, 1] }, duration: 0.3, ease: 'none', immediateRender: false }, 1.4);
    return tl;
  });
  countDef('C7', { title: 'Digit Wave', desc: 'A quick count, then the digits jump in a ripple from left to right, twice, while the box glows.', dur: '2.4s' }, (M, o) => {
    const { amount, tl, box } = countPrep(M, o);
    tl.add(count(M.winval, 0, amount, 0.9, { ease: 'power2.out' }), 0.1);
    tl.call(() => { M.winval.innerHTML = [...money(amount)].map(c => `<span class="mfx-ch">${c}</span>`).join(''); }, null, 1.02);
    const wave = gsap.timeline();
    for (let pass = 0; pass < 2; pass++) wave.add(() => {
      const chars = M.winval.querySelectorAll('.mfx-ch');
      gsap.fromTo(chars, { yPercent: 0 }, { yPercent: -38, duration: 0.16, yoyo: true, repeat: 1, ease: 'power2.out', stagger: 0.05 });
      gsap.fromTo(chars, { color: '#fff7d6' }, { color: '#ffd23f', duration: 0.16, yoyo: true, repeat: 1, stagger: 0.05 });
    }, pass * 0.7);
    wave.to({}, { duration: 1.2 });
    tl.add(wave, 1.05);
    tl.add(ring(M.fx, box.x, box.y, { size: box.w * 1.2, color: '#ffd23f', width: 3, sy: 0.5 }), 1.05);
    return tl;
  });
  REDUCED.count = (M, o) => { const { amount, tl } = countPrep(M, o); tl.call(() => { M.winval.textContent = money(amount); }, null, 0.1); tl.fromTo(M.winval, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.1); return tl; };
  FX.count.odometer = odometer;

  /* ===================================================================================
     7. BIG / MEGA / MAX WIN  (B)
     MangoFX.big.Bx(M, {amount, bet}) -> timeline. Everything is drawn in M.fx over the board.
     Building blocks: MangoFX.big.title(M, text, tier), .fountain(M, o), .confetti(M, o), .coinRain(M, o)
     =================================================================================== */
  const TIER = { big: ['BIG WIN', 'big'], mega: ['MEGA WIN', 'mega'], epic: ['EPIC WIN', 'epic'], max: ['MAX WIN', 'max'] };
  function title(M, text, tier, o) {
    o = o || {}; const t = el('div', 'mfx-title mfx-add t-' + (tier || 'big') + (o.cls ? ' ' + o.cls : ''), M.fx); t.textContent = text;
    if (o.top) t.style.top = o.top;
    gsap.set(t, { xPercent: -50, yPercent: -50 }); return t;
  }
  function splitTitle(t) {
    const bg = getComputedStyle(t).backgroundImage, txt = t.textContent; t.textContent = '';
    const spans = [...txt].map(ch => { const s = el('span', null, t); s.textContent = ch === ' ' ? ' ' : ch; s.style.backgroundImage = bg; return s; });
    t.style.backgroundImage = 'none'; return spans;
  }
  function bigNum(M, o) { o = o || {}; const n = el('div', 'mfx-bignum mfx-add', M.fx); n.textContent = money(0); if (o.top) n.style.top = o.top; gsap.set(n, { xPercent: -50, yPercent: -50 }); return n; }
  function darken(M, tl, at, peak) { const d = el('div', 'mfx-dark mfx-add', M.fx); tl.fromTo(d, { opacity: 0 }, { opacity: peak || 1, duration: 0.4, immediateRender: false }, at || 0); return d; }
  /* slam a title in: from big and transparent to its size, with an impact ring and a camera bump */
  function slam(M, tl, t, at, o) {
    o = Object.assign({ from: 3.2, ring: '#ffd23f', shake: 6 }, o); const c = { x: M.fx.offsetWidth / 2, y: M.fx.offsetHeight * parseFloat(t.style.top || 40) / 100 };
    tl.fromTo(t, { opacity: 0, scale: o.from, rotation: -6 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.3, ease: 'power3.in', immediateRender: false }, at);
    tl.add(ring(M.fx, c.x, c.y, { size: M.fx.offsetWidth * 0.95, color: o.ring, width: 6, sy: 0.6, dur: 0.7 }), at + 0.3);
    if (o.shake) tl.add(shake(M.cam, { amp: o.shake, dur: 0.35 }), at + 0.3);
    tl.to(t, { keyframes: { scale: [1, 1.1, 1] }, duration: 0.35, ease: 'none' }, at + 0.3);
    return at + 0.3;
  }
  /** bounce(p, x0, y0, v, angle, g, floor, o) -> tl. Physics2D flight that bounces off a floor line. */
  function bounce(p, x0, y0, v, ang, g, floor, o) {
    o = Object.assign({ bounces: 2, rest: 0.45, fric: 0.8 }, o); const tl = gsap.timeline();
    let vx = v * Math.cos(ang * Math.PI / 180), vy = v * Math.sin(ang * Math.PI / 180), y = y0, t = 0;
    S(tl, p, { x: x0, y: y0, opacity: 1 }, 0);
    for (let b = 0; b <= o.bounces; b++) {
      const th = (-vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * (floor - y)))) / g;
      tl.to(p, { physics2D: { velocity: Math.hypot(vx, vy), angle: Math.atan2(vy, vx) * 180 / Math.PI, gravity: g }, duration: th, ease: 'none' }, t);
      vy = -(vy + g * th) * o.rest; vx *= o.fric; y = floor; t += th;
    }
    tl.to(p, { opacity: 0, duration: 0.3 }, t); tl.end = t + 0.3;
    return tl;
  }
  /** fountain(M, o) -> tl. Coins and mangoes shoot up and bounce on the floor. o: {n, dur, x, mango:0..1} */
  function fountain(M, o) {
    o = Object.assign({ n: 40, dur: 1.6, mango: 0.35 }, o); const tl = gsap.timeline(); if (reduced) return tl;
    const W = M.fx.offsetWidth, H = M.fx.offsetHeight, sc = W / 480, x0 = o.x != null ? o.x : W / 2, floor = H * 0.93;
    for (let i = 0; i < o.n; i++) {
      const isM = Math.random() < o.mango, p = makeParticles(M.fx, 1, isM ? 'img' : 'mfx-coin', q => { sizeP(q, (isM ? 34 : 22) * sc * rnd(0.85, 1.15)); if (isM) q.src = src(Math.random() < 0.7 ? 'H3' : 'W'); })[0];
      const at = rnd(0, o.dur), b = bounce(p, x0 + rnd(-10, 10) * sc, floor - 4, rnd(480, 760) * sc, rnd(-118, -62), 1400 * sc, floor);
      tl.add(b, at);
      tl.fromTo(p, { rotation: 0 }, { rotation: rnd(-540, 540), duration: b.end, ease: 'power1.out', immediateRender: false }, at);
      if (!isM) tl.to(p, { scaleX: 0.2, duration: 0.12, yoyo: true, repeat: Math.round(b.end / 0.12), ease: 'sine.inOut' }, at);
      removeAt(tl, [p], at + b.end + 0.05);
    }
    return tl;
  }
  /** confetti(M, o) -> tl. Two cannons in the bottom corners. o: {n per side, colors} */
  function confetti(M, o) {
    o = Object.assign({ n: 60, colors: ['#ff4f8b', '#ffd23f', '#3be3ff', '#7dffb0', '#ffffff', '#c77dff'] }, o); const tl = gsap.timeline(); if (reduced) return tl;
    const W = M.fx.offsetWidth, H = M.fx.offsetHeight, sc = W / 480;
    [[W * 0.04, -78, -48], [W * 0.96, -132, -102]].forEach(([x, a0, a1]) => {
      const ps = makeParticles(M.fx, o.n, 'mfx-conf', p => { p.style.width = rnd(7, 12) * sc + 'px'; p.style.height = rnd(4, 7) * sc + 'px'; p.style.setProperty('--c', pick(o.colors)); });
      ps.forEach(p => {
        const at = rnd(0, 0.35), d = rnd(2.2, 3.0);
        S(tl, p, { x, y: H + 4, opacity: 1, rotation: rnd(0, 360) }, at);
        tl.to(p, { physics2D: { velocity: rnd(520, 900) * sc, angle: rnd(a0, a1), gravity: 620 * sc, friction: 0.012 }, duration: d, ease: 'none' }, at);
        tl.to(p, { rotationX: '+=' + rnd(540, 1080), rotation: '+=' + rnd(-360, 360), duration: d, ease: 'none' }, at);
        tl.to(p, { opacity: 0, duration: 0.4 }, at + d - 0.4);
      });
      removeAt(tl, ps, 3.5);
    });
    return tl;
  }
  /** coinRain(M, o) -> tl. Coins fall from the top across the whole screen. o: {n, dur} */
  function coinRain(M, o) {
    o = Object.assign({ n: 46, dur: 2.4 }, o); const tl = gsap.timeline(); if (reduced) return tl;
    const W = M.fx.offsetWidth, H = M.fx.offsetHeight, sc = W / 480;
    const ps = makeParticles(M.fx, o.n, 'mfx-coin', p => sizeP(p, rnd(16, 26) * sc));
    ps.forEach(p => {
      const at = rnd(0, o.dur), d = rnd(1.0, 1.6), x = rnd(0, W);
      S(tl, p, { x, y: -30, opacity: 1 }, at);
      tl.to(p, { y: H + 30, x: x + rnd(-30, 30), duration: d, ease: 'power1.in' }, at)
        .to(p, { scaleX: 0.15, duration: 0.14, yoyo: true, repeat: Math.round(d / 0.14), ease: 'sine.inOut' }, at);
    });
    removeAt(tl, ps, o.dur + 1.7);
    return tl;
  }
  function ribbon(M, text, o) {
    o = o || {}; const r = el('div', 'mfx-ribbon mfx-add', M.fx); if (o.top) r.style.top = o.top;
    const l = el('div', 'tail l', r), rr = el('div', 'tail r', r), band = el('div', 'band', r); band.textContent = text;
    gsap.set(r, { xPercent: -50, yPercent: -50 }); return { r, band, l, rr };
  }
  function unfurl(tl, rb, at) {
    S(tl, rb.r, { opacity: 1 }, at);
    tl.fromTo(rb.band, { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'power3.out', immediateRender: false }, at)
      .fromTo(rb.l, { xPercent: 120, rotation: 0, opacity: 0 }, { xPercent: 0, opacity: 1, duration: 0.4, ease: 'back.out(2)', immediateRender: false }, at + 0.3)
      .fromTo(rb.rr, { xPercent: -120, opacity: 0 }, { xPercent: 0, opacity: 1, duration: 0.4, ease: 'back.out(2)', immediateRender: false }, at + 0.3)
      .to(rb.r, { rotation: 1.5, duration: 0.6, yoyo: true, repeat: 3, ease: 'sine.inOut' }, at + 0.7);
  }
  const bigDef = (id, meta, fn) => def('big', id, Object.assign({ scene: 'line' }, meta), fn);
  const mid = M => ({ x: M.fx.offsetWidth / 2, y: M.fx.offsetHeight * 0.45 });

  bigDef('B1', { title: 'Tier Ladder', desc: 'The counter climbs while BIG WIN, MEGA WIN and EPIC WIN slam in one after another, each with a shockwave and a camera hit.', dur: '6.5s' }, (M, o) => {
    const tl = gsap.timeline(), amt = o.amount || 1250; darken(M, tl, 0);
    const n = bigNum(M); tl.fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.3).add(count(n, 0, amt, 5.2, { ease: 'power1.in' }), 0.3);
    const ts = [['BIG WIN', 'big', 0.3, '#ffd23f'], ['MEGA WIN', 'mega', 2.1, '#ff8ab8'], ['EPIC WIN', 'epic', 3.9, '#7ff0ff']];
    let prev = null;
    ts.forEach(([txt, tier, at, rc]) => {
      const t = title(M, txt, tier);
      if (prev) tl.to(prev, { scale: 0.3, opacity: 0, duration: 0.22, ease: 'power2.in' }, at - 0.05);
      const hit = slam(M, tl, t, at, { ring: rc });
      tl.add(burst(M.fx, mid(M).x, mid(M).y - 10, { n: 18, kind: 'star', speed: [200, 420], gravity: 380, dur: 1.0, size: [10, 18], colors: ['#fff6c8', rc] }), hit);
      prev = t;
    });
    tl.to(n, { keyframes: { scale: [1, 1.3, 1] }, duration: 0.4, ease: 'none' }, 5.5);
    tl.to(prev, { scale: 1.06, duration: 0.4, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 5.6);
    return tl;
  });
  bigDef('B2', { title: 'Sunburst', desc: 'Two layers of sun rays bloom open and counter-rotate behind a popping BIG WIN, everything gently pulsing.', dur: '4.6s' }, (M, o) => {
    const tl = gsap.timeline(), W = M.fx.offsetWidth, c = mid(M); darken(M, tl, 0, 0.85);
    const r1 = rays(M.fx, c.x, c.y, W * 1.7), r2 = rays(M.fx, c.x, c.y, W * 1.15, { cls: 'white' });
    tl.fromTo([r1, r2], { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'back.out(1.5)', immediateRender: false }, 0.15)
      .fromTo(r1, { rotation: 0 }, { rotation: 120, duration: 4.4, ease: 'none', immediateRender: false }, 0.15)
      .fromTo(r2, { rotation: 0 }, { rotation: -90, duration: 4.4, ease: 'none', immediateRender: false }, 0.15)
      .to([r1, r2], { scale: 1.08, duration: 0.6, yoyo: true, repeat: 4, ease: 'sine.inOut' }, 0.85);
    const t = title(M, 'BIG WIN', 'big'), n = bigNum(M);
    tl.fromTo(t, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'mfx.pop', immediateRender: false }, 0.35)
      .to(t, { scale: 1.07, duration: 0.5, yoyo: true, repeat: 5, ease: 'sine.inOut' }, 1.0)
      .fromTo(n, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3, immediateRender: false }, 0.7).add(count(n, 0, o.amount || 250, 2.4), 0.7)
      .to(n, { keyframes: { scale: [1, 1.25, 1] }, duration: 0.35, ease: 'none' }, 3.15);
    return tl;
  });
  bigDef('B3', { title: 'Coin & Mango Fountain', desc: 'Physics2D fountain: coins and mangoes shoot up from the bottom, spin, bounce on the floor twice and fade.', dur: '4.4s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.7);
    const t = title(M, 'MEGA WIN', 'mega', { top: '30%' }), n = bigNum(M, { top: '48%' });
    tl.fromTo(t, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'mfx.pop', immediateRender: false }, 0.2)
      .fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.4).add(count(n, 0, o.amount || 640, 2.6), 0.4);
    tl.add(fountain(M, { n: 44, dur: 1.8 }), 0.3);
    return tl;
  });
  bigDef('B4', { title: 'Upgrade Flash & Shake', desc: 'BIG WIN is on screen; on each tier upgrade the screen flashes white, the camera shakes hard and the new tier punches in.', dur: '5.2s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0);
    const n = bigNum(M); tl.fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.2).add(count(n, 0, o.amount || 980, 4.2, { ease: 'power1.in' }), 0.2);
    const a = title(M, 'BIG WIN', 'big'), b = title(M, 'MEGA WIN', 'mega'), c = title(M, 'EPIC WIN', 'epic');
    tl.fromTo(a, { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2.5)', immediateRender: false }, 0.2);
    [[a, b, 1.7], [b, c, 3.3]].forEach(([from, to, at]) => {
      tl.add(flash(M.fx, { peak: 0.9, dur: 0.45 }), at).add(shake(M.cam, { amp: 11, dur: 0.5, rot: 1.2 }), at)
        .to(from, { scale: 1.8, opacity: 0, duration: 0.25, ease: 'power2.out' }, at)
        .fromTo(to, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(3)', immediateRender: false }, at + 0.05);
      tl.add(burst(M.fx, mid(M).x, mid(M).y, { n: 16, kind: 'spark', speed: [200, 420], gravity: 200, dur: 0.8, size: [10, 18], colors: ['#ffffff', '#ffd23f'] }), at + 0.05);
    });
    tl.to(c, { scale: 1.06, duration: 0.4, yoyo: true, repeat: 2, ease: 'sine.inOut' }, 3.9);
    return tl;
  });
  bigDef('B5', { title: 'Ribbon Banner', desc: 'A pink ribbon unfurls from the centre, its folded tails flip out, and it sways gently while the amount counts.', dur: '4.0s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.75);
    const rb = ribbon(M, 'BIG WIN', { top: '42%' }), n = bigNum(M, { top: '62%' });
    unfurl(tl, rb, 0.2);
    const W = M.fx.offsetWidth, H = M.fx.offsetHeight;
    tl.add(burst(M.fx, W * 0.16, H * 0.42, { n: 10, kind: 'star', speed: [100, 260], gravity: 300, dur: 0.8, colors: ['#fff6c8', '#ffd23f'] }), 0.55)
      .add(burst(M.fx, W * 0.84, H * 0.42, { n: 10, kind: 'star', speed: [100, 260], gravity: 300, dur: 0.8, colors: ['#fff6c8', '#ffd23f'] }), 0.55);
    tl.fromTo(n, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)', immediateRender: false }, 0.6).add(count(n, 0, o.amount || 320, 2.2), 0.6);
    return tl;
  });
  bigDef('B6', { title: 'Confetti Cannons', desc: 'Two cannons in the bottom corners fire beach-coloured confetti that flutters down in 3D over MEGA WIN.', dur: '4.0s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.75);
    const t = title(M, 'MEGA WIN', 'mega'), n = bigNum(M);
    slam(M, tl, t, 0.15, { ring: '#ff8ab8', shake: 5 });
    tl.add(confetti(M, { n: 60 }), 0.4);
    tl.fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.5).add(count(n, 0, o.amount || 720, 2.4), 0.5);
    return tl;
  });
  bigDef('B7', { title: 'Letter Drop', desc: 'The letters of EPIC WIN drop in one by one, squash as they land, then bounce in a wave.', dur: '4.0s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.8);
    const t = title(M, 'EPIC WIN', 'epic'), n = bigNum(M);
    S(tl, t, { opacity: 1 }, 0.1);
    const spans = splitTitle(t);
    tl.fromTo(spans, { yPercent: -420, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.38, ease: 'power2.in', stagger: 0.07, immediateRender: true }, 0.15)
      .to(spans, { keyframes: { scaleX: [1, 1.3, 0.92, 1], scaleY: [1, 0.7, 1.1, 1] }, transformOrigin: '50% 100%', duration: 0.35, ease: 'none', stagger: 0.07 }, 0.53)
      .to(spans, { yPercent: -22, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', stagger: 0.05 }, 1.6)
      .to(spans, { yPercent: -22, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', stagger: 0.05 }, 2.6);
    tl.fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 1.0).add(count(n, 0, o.amount || 1500, 2.0), 1.0);
    return tl;
  });
  bigDef('B8', { title: 'MAX WIN 20,000x (full sequence)', desc: 'The whole show, about 11 s: rays, a climbing counter, four tier slams with flashes and shakes, fountains, a ribbon, confetti and coin rain, landing on 20,000x.', dur: '11s' }, (M, o) => {
    const tl = gsap.timeline(), W = M.fx.offsetWidth, c = mid(M), bet = o.bet || 1, X = o.x || 20000;
    darken(M, tl, 0, 1);
    tl.fromTo(M.vig, { opacity: 0 }, { opacity: 0.6, duration: 0.6, immediateRender: false }, 0);
    const r1 = rays(M.fx, c.x, c.y, W * 1.8), r2 = rays(M.fx, c.x, c.y, W * 1.2, { cls: 'white' });
    tl.fromTo([r1, r2], { opacity: 0, scale: 0 }, { opacity: 0.8, scale: 1, duration: 0.8, ease: 'back.out(1.4)', immediateRender: false }, 0.2)
      .fromTo(r1, { rotation: 0 }, { rotation: 400, duration: 10.5, ease: 'power1.in', immediateRender: false }, 0.2)
      .fromTo(r2, { rotation: 0 }, { rotation: -300, duration: 10.5, ease: 'power1.in', immediateRender: false }, 0.2);
    const n = bigNum(M, { top: '60%' }), sub = el('div', 'mfx-sub mfx-add', M.fx); sub.textContent = '0x'; gsap.set(sub, { xPercent: -50, yPercent: -50 });
    tl.fromTo([n, sub], { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.4);
    const pc = { v: 0 };
    tl.fromTo(pc, { v: 0 }, { v: X, duration: 7.4, ease: 'power2.in', immediateRender: false, onUpdate: () => { n.textContent = money(pc.v * bet); sub.textContent = Math.round(pc.v).toLocaleString('en-US') + 'x'; } }, 0.4);
    const tiers = [['BIG WIN', 'big', 0.45, '#ffd23f'], ['MEGA WIN', 'mega', 2.4, '#ff8ab8'], ['EPIC WIN', 'epic', 4.6, '#7ff0ff']];
    let prev = null;
    tiers.forEach(([txt, tier, at, rc], k) => {
      const t = title(M, txt, tier);
      if (prev) { tl.to(prev, { scale: 2, opacity: 0, duration: 0.25, ease: 'power2.out' }, at); tl.add(flash(M.fx, { peak: 0.8, dur: 0.4 }), at); }
      slam(M, tl, t, at, { ring: rc, shake: 5 + k * 3 });
      tl.add(fountain(M, { n: 10 + k * 8, dur: 1.2, mango: 0.25 + k * 0.1 }), at + 0.3);
      tl.to([r1, r2], { scale: 1 + k * 0.08, duration: 0.4 }, at + 0.3);
      prev = t;
    });
    const maxAt = 7.8;
    tl.to(prev, { scale: 2.2, opacity: 0, duration: 0.25, ease: 'power2.out' }, maxAt);
    tl.add(flash(M.fx, { peak: 1, dur: 0.7 }), maxAt).add(shake(M.cam, { amp: 14, dur: 0.8, rot: 1.5 }), maxAt);
    const rb = ribbon(M, 'MAX WIN', { top: '38%' }); rb.band.style.background = 'linear-gradient(100deg,#ff4f8b,#ffb52e 35%,#ff4f8b 70%,#c77dff)';
    unfurl(tl, rb, maxAt + 0.05);
    tl.to(n, { keyframes: { scale: [1, 1.45, 1.1] }, duration: 0.5, ease: 'none' }, maxAt)
      .to(sub, { keyframes: { scale: [1, 1.8, 1.4] }, color: '#fff', duration: 0.5, ease: 'none' }, maxAt);
    tl.add(ring(M.fx, c.x, c.y, { size: W * 1.2, color: '#ffffff', width: 8, sy: 0.6, dur: 0.9 }), maxAt + 0.05)
      .add(ring(M.fx, c.x, c.y, { size: W * 0.9, color: '#ffd23f', width: 6, sy: 0.6, dur: 0.8 }), maxAt + 0.2);
    tl.add(confetti(M, { n: 70 }), maxAt + 0.1).add(coinRain(M, { n: 50, dur: 2.2 }), maxAt + 0.3).add(fountain(M, { n: 26, dur: 1.4, mango: 0.5 }), maxAt + 0.2);
    tl.to(rb.r, { scale: 1.05, duration: 0.45, yoyo: true, repeat: 3, ease: 'sine.inOut' }, maxAt + 1.2);
    tl.to([r1, r2], { opacity: 0, duration: 0.6 }, 10.6).to(M.vig, { opacity: 0, duration: 0.6 }, 10.6);
    return tl;
  });
  bigDef('B9', { title: 'Coin Shower', desc: 'Gold coins rain down over the whole screen, flipping as they fall, behind a bouncing BIG WIN.', dur: '3.8s' }, (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.7);
    tl.add(coinRain(M, { n: 54, dur: 2.2 }), 0.1);
    const t = title(M, 'BIG WIN', 'big'), n = bigNum(M);
    tl.fromTo(t, { opacity: 0, yPercent: -300 }, { opacity: 1, yPercent: -50, duration: 0.6, ease: 'bounce.out', immediateRender: false }, 0.25)
      .fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.6).add(count(n, 0, o.amount || 180, 2.0), 0.6);
    return tl;
  });
  REDUCED.big = (M, o) => {
    const tl = gsap.timeline(); darken(M, tl, 0, 0.8); const t = title(M, 'BIG WIN', 'big'), n = bigNum(M);
    tl.fromTo([t, n], { opacity: 0 }, { opacity: 1, duration: 0.5, immediateRender: false }, 0.1); tl.call(() => { n.textContent = money(o.amount || 250); }, null, 0.1); return tl;
  };
  Object.assign(FX.big, { title, fountain, confetti, coinRain, ribbon });

  /* ===================================================================================
     8. WILD  (W)
     MangoFX.wild.Wx(M, {reel:2, row:2, mult:25}) -> timeline
     Building block: MangoFX.wild.stack(M, reel) -> {st, w, sw, fm, img} (a full-reel wild overlay).
     =================================================================================== */
  function stackEl(M, i) {
    const st = overReel(M, i, 'mfx-over mfx-stack mfx-add'), w = el('div', 'w', st), sw = el('div', 'sw', st), fm = el('div', 'fm', st), img = el('img', null, st);
    img.src = src('W'); img.alt = ''; img.draggable = false; st.style.opacity = 0;
    return { st, w, sw, fm, img };
  }
  function badge(M, text, x, y, o) {
    o = o || {}; const b = el('div', 'mfx-mx mfx-add ' + (o.tier || 't5'), M.fx); b.textContent = text; if (o.size) b.style.fontSize = o.size;
    gsap.set(b, { x, y, xPercent: -50, yPercent: -50 }); return b;
  }
  const wildDef = (id, meta, fn) => def('wild', id, Object.assign({ scene: 'line' }, meta), fn);
  const swellLoop = (tl, sw, at, n) => tl.fromTo(sw, { yPercent: 0 }, { yPercent: 18, duration: 1.1, ease: 'none', repeat: n || 3, immediateRender: false }, at);

  wildDef('W1', { title: 'Splash Landing', desc: 'The wild drops in from above the reels, squashes on impact and throws spray plus two water ripples.', dur: '2.4s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, row = o.row != null ? o.row : 2, tl = gsap.timeline(), s = M.sym(r, row), p = pt(M.cell(r, row), M.fx);
    raise(M, [[r, row]]);
    tl.fromTo(s, { yPercent: -190, opacity: 0, scale: 0.9, rotation: -10 }, { yPercent: 0, opacity: 1, rotation: 0, duration: 0.42, ease: 'power2.in', immediateRender: true }, 0.15)
      .to(s, { keyframes: { scaleX: [0.9, 1.3, 0.92, 1.06, 1], scaleY: [0.9, 0.7, 1.15, 0.97, 1] }, transformOrigin: '50% 90%', duration: 0.55, ease: 'none' }, 0.57);
    tl.add(splash(M.fx, p.x, p.y + p.h * 0.32, { n: 18, power: p.w / 80 }), 0.57)
      .add(ring(M.fx, p.x, p.y, { size: p.w * 2, color: '#bff7ff', width: 4, dur: 0.6 }), 0.57)
      .add(shake(M.cam, { amp: 3, dur: 0.25 }), 0.57);
    const h = addHalo(s, 'rgba(120,230,255,.9)');
    tl.fromTo(h, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1.2, duration: 0.3, immediateRender: false }, 0.6).to(h, { opacity: 0.4, scale: 1, duration: 0.6, yoyo: true, repeat: 1 }, 0.9);
    tl.to(s, { yPercent: -5, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 1.2);
    return tl;
  });
  wildDef('W2', { title: 'Elastic Expand', desc: 'The wild grows from its cell to fill the whole reel with an elastic stretch; the surfer rides to the centre.', dur: '2.8s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, row = o.row != null ? o.row : 2, tl = gsap.timeline(), { st, w, sw, fm, img } = stackEl(M, r), H = M.reels[r].offsetHeight, s = M.sym(r, row);
    const oy = (row + 0.5) / M.rows * 100;
    tl.fromTo(s, { scale: 1 }, { scale: 1.2, duration: 0.15, yoyo: true, repeat: 1, ease: 'sine.inOut', immediateRender: false }, 0);
    S(tl, st, { opacity: 1 }, 0.3); S(tl, winSyms(M.rigs[r]), { opacity: 0 }, 0.32);
    tl.fromTo(w, { scaleY: 1 / M.rows }, { scaleY: 1, transformOrigin: `50% ${oy}%`, duration: 1.0, ease: 'elastic.out(1,0.45)', immediateRender: false }, 0.3)
      .fromTo([sw, fm], { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, 0.5)
      .fromTo(img, { y: ((row + 0.5) / M.rows - 0.5) * H, scale: 0.8 }, { y: 0, scale: 1, duration: 0.7, ease: 'back.out(1.6)', immediateRender: false }, 0.35)
      .to(img, { y: -H * 0.03, rotation: 3, duration: 0.55, yoyo: true, repeat: 2, ease: 'sine.inOut' }, 1.05);
    swellLoop(tl, sw, 0.5);
    const p = pt(M.reels[r], M.fx); tl.add(burst(M.fx, p.x, p.y, { n: 12, kind: 'drop', speed: [120, 260], angle: [-170, -10], gravity: 700, dur: 0.8 }), 0.4);
    return tl;
  });
  wildDef('W3', { title: 'Water Fill', desc: 'Sea water rises up the reel from the bottom with a foamy crest and bubbles, then the surfer pops up on top.', dur: '2.8s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, tl = gsap.timeline(), { st, w, sw, fm, img } = stackEl(M, r), H = M.reels[r].offsetHeight;
    const crest = el('div', 'mfx-crest', st), p = pt(M.reels[r], M.fx);
    S(tl, st, { opacity: 1 }, 0.15);
    tl.fromTo(w, { scaleY: 0 }, { scaleY: 1, transformOrigin: '50% 100%', duration: 1.1, ease: 'power2.inOut', immediateRender: false }, 0.15)
      .fromTo(crest, { y: H }, { y: 0, duration: 1.1, ease: 'power2.inOut', immediateRender: false }, 0.15)
      .fromTo(crest, { xPercent: 0 }, { xPercent: -12, duration: 0.5, ease: 'none', repeat: 3, immediateRender: false }, 0.15)
      .to(crest, { opacity: 0, duration: 0.3 }, 1.25)
      .fromTo([sw, fm], { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, 0.9)
      .fromTo(img, { y: H * 0.5, opacity: 0, scale: 0.7 }, { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.8)', immediateRender: true }, 1.05)
      .to(img, { y: -H * 0.03, rotation: 3, duration: 0.55, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 1.65);
    S(tl, winSyms(M.rigs[r]), { opacity: 0 }, 1.2);
    swellLoop(tl, sw, 0.9);
    for (let k = 0; k < 5; k++) tl.add(burst(M.fx, p.x + rnd(-p.w * 0.3, p.w * 0.3), p.y + p.h / 2 - 6, { n: 4, kind: 'spark', speed: [40, 90], angle: [-100, -80], gravity: -160, dur: 0.9, size: [5, 9], colors: ['#ffffff', '#bff7ff'] }), 0.2 + k * 0.2);
    return tl;
  });
  wildDef('W4', { title: 'Wave Crash', desc: 'A wave crashes down the reel from the top, foam leading, hits the bottom in a burst of spray and shake; the surfer drops in.', dur: '2.6s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, row = o.row != null ? o.row : 2, tl = gsap.timeline(), { st, w, sw, fm, img } = stackEl(M, r), H = M.reels[r].offsetHeight, p = pt(M.reels[r], M.fx);
    const crest = el('div', 'mfx-crest', st);
    tl.fromTo(M.sym(r, row), { x: 0 }, { keyframes: { x: [0, -3, 3, -3, 3, 0] }, duration: 0.3, ease: 'none', immediateRender: false }, 0);
    S(tl, st, { opacity: 1 }, 0.3);
    tl.fromTo(w, { scaleY: 0 }, { scaleY: 1, transformOrigin: '50% 0%', duration: 0.45, ease: 'power3.in', immediateRender: false }, 0.3)
      .fromTo(crest, { y: 0 }, { y: H, duration: 0.45, ease: 'power3.in', immediateRender: false }, 0.3)
      .to(crest, { scaleX: 1.6, opacity: 0, duration: 0.3 }, 0.75);
    S(tl, winSyms(M.rigs[r]), { opacity: 0 }, 0.6);
    tl.add(splash(M.fx, p.x, p.y + p.h / 2 - 4, { n: 22, power: p.w / 60 }), 0.75)
      .add(burst(M.fx, p.x - p.w / 2, p.y + p.h * 0.3, { n: 8, kind: 'drop', speed: [120, 240], angle: [-170, -120], gravity: 900, dur: 0.7 }), 0.75)
      .add(burst(M.fx, p.x + p.w / 2, p.y + p.h * 0.3, { n: 8, kind: 'drop', speed: [120, 240], angle: [-60, -10], gravity: 900, dur: 0.7 }), 0.75)
      .add(shake(M.cam, { amp: 7, dur: 0.4 }), 0.75)
      .fromTo([sw, fm], { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.75)
      .fromTo(img, { y: -H * 0.35, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'bounce.out', immediateRender: true }, 0.85);
    swellLoop(tl, sw, 0.75);
    return tl;
  });
  wildDef('W5', { title: 'Multiplier Stamp', desc: 'A big "x25" badge stamps down onto the full-reel wild: impact shake, flash, ink ring and stars, then a cocky wobble.', dur: '2.6s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, tl = gsap.timeline(), { st, w, sw, fm, img } = stackEl(M, r), p = pt(M.reels[r], M.fx);
    S(tl, winSyms(M.rigs[r]), { opacity: 0 }, 0.3);
    tl.fromTo(st, { opacity: 0, scaleY: 0.3 }, { opacity: 1, scaleY: 1, duration: 0.45, ease: 'back.out(1.6)', immediateRender: false }, 0.05);
    swellLoop(tl, sw, 0.1);
    const b = badge(M, 'x' + (o.mult || 25), p.x, p.y + p.h * 0.36, { size: '8cqw' }), hit = 0.95;
    tl.fromTo(b, { opacity: 0, scale: 4.2, rotation: -28 }, { opacity: 1, scale: 1, rotation: -8, duration: 0.32, ease: 'power4.in', immediateRender: false }, hit - 0.32)
      .add(shake(M.cam, { amp: 8, dur: 0.4 }), hit).add(flash(M.fx, { peak: 0.35, dur: 0.25 }), hit)
      .add(ring(M.fx, p.x, p.y + p.h * 0.36, { size: p.w * 2.2, color: '#2a0e12', width: 6, dur: 0.5 }), hit)
      .add(burst(M.fx, p.x, p.y + p.h * 0.36, { n: 16, kind: 'star', speed: [160, 340], gravity: 360, dur: 0.9, colors: ['#ffd23f', '#fff6c8', '#ff8ab8'] }), hit)
      .add(dust(M.fx, p.x, p.y + p.h * 0.42, { n: 8, spread: p.w * 0.9, size: p.w * 0.4 }), hit)
      .to(b, { keyframes: { rotation: [-8, 7, -5, 3, 0], scale: [1, 1.12, 1, 1.05, 1] }, duration: 0.6, ease: 'none' }, hit + 0.1)
      .to(b, { scale: 1.1, duration: 0.4, yoyo: true, repeat: 1, ease: 'sine.inOut' }, hit + 0.8);
    return tl;
  });
  wildDef('W6', { title: 'Multiplier Merge', desc: 'Two wilds show x5 each; the badges fly together and collide in a flash into one big x25, which then flies to the win box.', dur: '3.6s', scene: 'wild2' }, (M, o) => {
    const tl = gsap.timeline(), cells = [[1, 1], [3, 2]], W = M.fx.offsetWidth, H = M.fx.offsetHeight, tgt = { x: W / 2, y: H * 0.3 }, box = pt(M.winbox, M.fx);
    raise(M, cells); tl.add(dim(M, cells), 0);
    const bs = cells.map(([r, row], k) => {
      const p = pt(M.cell(r, row), M.fx), b = badge(M, 'x5', p.x + p.w * 0.28, p.y + p.h * 0.32, { tier: 't3' });
      tl.fromTo(M.sym(r, row), { scale: 1 }, { keyframes: { scale: [1, 1.3, 1.1] }, duration: 0.4, ease: 'none', immediateRender: false }, 0.15 + k * 0.2)
        .fromTo(b, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(3)', immediateRender: false }, 0.25 + k * 0.2);
      return { b, x: p.x + p.w * 0.28, y: p.y + p.h * 0.32 };
    });
    const eq = el('div', 'mfx-sub mfx-add', M.fx); eq.textContent = 'x5  ×  x5'; eq.style.top = '18%'; gsap.set(eq, { xPercent: -50, yPercent: -50 });
    tl.fromTo(eq, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1.2, duration: 0.3, ease: 'back.out(2)', immediateRender: false }, 1.0);
    bs.forEach(({ b, x, y }, k) => tl.to(b, { motionPath: { path: [{ x, y }, { x: (x + tgt.x) / 2 + (k ? 30 : -30), y: Math.min(y, tgt.y) - 60 }, { x: tgt.x + (k ? 14 : -14), y: tgt.y }], curviness: 1.4 }, rotation: k ? 360 : -360, duration: 0.6, ease: 'power2.in' }, 1.05));
    const hit = 1.65, big = badge(M, 'x25', tgt.x, tgt.y, { size: '9.5cqw' });
    tl.to(bs.map(q => q.b), { scale: 0, opacity: 0, duration: 0.1 }, hit)
      .add(flash(M.fx, { peak: 0.6, dur: 0.3 }), hit).add(ring(M.fx, tgt.x, tgt.y, { size: W * 0.6, color: '#ff8ab8', width: 6 }), hit)
      .add(burst(M.fx, tgt.x, tgt.y, { n: 20, kind: 'star', speed: [180, 380], gravity: 300, dur: 0.9, colors: ['#ffd23f', '#fff6c8', '#ff8ab8'] }), hit)
      .fromTo(big, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'mfx.pop', immediateRender: false }, hit)
      .to(eq, { opacity: 0, duration: 0.3 }, hit + 0.3)
      .to(big, { x: box.x, y: box.y - box.h * 0.9, scale: 0.6, duration: 0.55, ease: 'power2.in' }, hit + 1.0)
      .to(big, { opacity: 0, scale: 0.3, duration: 0.15 }, hit + 1.55)
      .fromTo(M.winbox, { scale: 1 }, { keyframes: { scale: [1, 1.15, 1] }, duration: 0.3, ease: 'none', immediateRender: false }, hit + 1.55)
      .add(count(M.winval, 0, o.amount || 62.5, 0.5), hit + 1.55);
    return tl;
  });
  wildDef('W7', { title: 'Surf-In', desc: 'The mango surfs in from the left edge on a wave, carving a water trail across the row, and plants himself in his cell.', dur: '2.4s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, row = o.row != null ? o.row : 2, tl = gsap.timeline(), { w } = svgFit(M), s = w / 420, g = sv('g', { class: 'mfx-add' }, M.svg);
    const tb = cellBox(M, r, row), pts = []; const x0 = -tb.w * 0.8;
    for (let k = 0; k <= 24; k++) { const t = k / 24, x = x0 + (tb.cx - x0) * t; pts.push([x, tb.cy + Math.sin(t * Math.PI * 2.5) * tb.h * 0.22 * (1 - t)]); }
    const d = dPath(pts, 0.7), out = stroke(g, d, COL.ink, 8 * s), body = stroke(g, d, '#3be3ff', 5 * s), foam = stroke(g, d, '#fff', 1.8 * s, { 'stroke-dasharray': `${5 * s} ${8 * s}` });
    const rig = M.rigs[r]; rig.put(rig.L + row, 'L3');
    raise(M, [[r, row]]);
    const D = 1.0; drawIn(tl, [out, body, foam], D, 0.1, 'power1.out');
    const im = sv('image', { href: src('W'), width: tb.w, height: tb.h, x: 0, y: 0, opacity: 0 }, g);
    S(tl, im, { opacity: 1 }, 0.1);
    tl.to(im, { motionPath: { path: body, align: body, alignOrigin: [0.5, 0.5] }, duration: D, ease: 'power1.out' }, 0.1);
    tl.fromTo(im, { rotation: -12 }, { rotation: 10, transformOrigin: '50% 60%', duration: 0.2, yoyo: true, repeat: 4, ease: 'sine.inOut', immediateRender: false }, 0.1);
    const t = 0.1 + D, p = pt(M.cell(r, row), M.fx), sy = M.sym(r, row);
    tl.to(im, { opacity: 0, duration: 0.08 }, t);
    tl.call(() => rig.put(rig.L + row, 'W'), null, t);
    tl.fromTo(sy, { scale: 0.6 }, { scale: 1, duration: 0.5, ease: 'back.out(3)', immediateRender: false }, t)
      .add(splash(M.fx, p.x, p.y + p.h * 0.3, { n: 16, power: p.w / 80 }), t)
      .to([out, body, foam], { opacity: 0, duration: 0.5 }, t + 0.4);
    return tl;
  });
  wildDef('W8', { title: 'Multiplier Climb', desc: 'The full-reel wild\'s badge counts up x2, x3, x5, x10, x25, changing colour on each step, with a slam on the last.', dur: '3.2s' }, (M, o) => {
    const r = o.reel != null ? o.reel : 2, tl = gsap.timeline(), { st, w, sw, fm, img } = stackEl(M, r), p = pt(M.reels[r], M.fx), by = p.y + p.h * 0.36;
    S(tl, winSyms(M.rigs[r]), { opacity: 0 }, 0.3);
    tl.fromTo(st, { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 0.05); swellLoop(tl, sw, 0.1);
    const b = badge(M, 'x2', p.x, by, { tier: 't1', size: '7cqw' }), steps = [[2, 't1'], [3, 't2'], [5, 't3'], [10, 't4'], [o.mult || 25, 't5']];
    tl.fromTo(b, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'back.out(3)', immediateRender: false }, 0.35);
    steps.forEach(([m, tier], k) => {
      if (!k) return; const at = 0.6 + k * 0.42, last = k === steps.length - 1;
      tl.call(() => { b.textContent = 'x' + m; b.className = 'mfx-mx mfx-add ' + tier; b.style.opacity = 1; }, null, at);
      tl.fromTo(b, { scale: 1 }, { keyframes: { scale: last ? [1, 1.9, 1] : [1, 1.4, 1], rotation: [0, k % 2 ? 10 : -10, 0] }, duration: last ? 0.5 : 0.32, ease: 'none', immediateRender: false }, at);
      tl.add(burst(M.fx, p.x, by, { n: last ? 18 : 7, kind: last ? 'star' : 'spark', speed: [100, last ? 340 : 200], gravity: 260, dur: 0.7, colors: ['#ffd23f', '#fff6c8', '#ff8ab8'] }), at);
      if (last) tl.add(shake(M.cam, { amp: 7, dur: 0.35 }), at + 0.15).add(ring(M.fx, p.x, by, { size: p.w * 2.4, color: '#ffd23f', width: 5 }), at + 0.15);
    });
    return tl;
  });
  REDUCED.wild = (M, o) => {
    const r = o.reel != null ? o.reel : 2, tl = gsap.timeline(), { st } = stackEl(M, r), p = pt(M.reels[r], M.fx), b = badge(M, 'x' + (o.mult || 25), p.x, p.y + p.h * 0.36);
    tl.fromTo([st, b], { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, 0.1); return tl;
  };
  FX.wild.stack = stackEl; FX.wild.badge = badge;

  /* ===================================================================================
     9. BONUS TRIGGER  (F)
     MangoFX.bonus.Fx(M, {spins:10}) -> timeline. Scatters are found with M.find('S1').
     =================================================================================== */
  const bonusDef = (id, meta, fn) => def('bonus', id, Object.assign({ scene: 'bonus' }, meta), fn);
  function cellRays(M, cell, size) {
    const r = el('i', 'mfx-p mfx-rays mfx-add', null); sizeP(r, size); r.style.opacity = 0; cell.insertBefore(r, cell.firstChild);
    gsap.set(r, { x: cell.offsetWidth / 2, y: cell.offsetHeight / 2 }); return r;
  }
  /* SURF badges pulse in order, then together; returns end time */
  function surfPulse(M, tl, at, o) {
    o = Object.assign({ gap: 0.38, beams: true, hold: 2 }, o);
    const sc = M.find('S1'); raise(M, sc); tl.add(dim(M, sc), at);
    sc.forEach((h, k) => {
      const c = M.cell(h[0], h[1]), s = symOf(c), t = at + 0.1 + k * o.gap, p = pt(c, M.fx), halo = addHalo(s), ry = cellRays(M, c, c.offsetWidth * 2.4);
      tl.fromTo(s, { scale: 1 }, { keyframes: { scale: [1, 1.45, 1.15], rotation: [0, -10, 0] }, duration: 0.42, ease: 'none', immediateRender: false }, t)
        .fromTo(halo, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1.2, duration: 0.35, immediateRender: false }, t)
        .fromTo(ry, { opacity: 0, scale: 0.3, rotation: 0 }, { opacity: 1, scale: 1, rotation: 90, duration: 1.4, ease: 'power1.out', immediateRender: false }, t)
        .add(ring(M.fx, p.x, p.y, { size: p.w * 2, color: '#ffd23f', width: 5 }), t);
    });
    const all = at + 0.1 + sc.length * o.gap;
    if (o.beams && sc.length > 1) {
      const { w } = svgFit(M), s = w / 420, g = sv('g', { class: 'mfx-add' }, M.svg);
      for (let k = 1; k < sc.length; k++) {
        const a = cellBox(M, ...sc[k - 1]), b = cellBox(M, ...sc[k]), d = `M${a.cx} ${a.cy} L${b.cx} ${b.cy}`;
        drawIn(tl, [stroke(g, d, '#ffd23f', 7 * s, { opacity: 0.35 }), stroke(g, d, '#fff6c8', 2.4 * s, { 'stroke-dasharray': `${2 * s} ${7 * s}` })], 0.25, all + (k - 1) * 0.12, 'power1.out');
      }
      tl.to(g, { opacity: 0, duration: 0.3 }, all + o.hold);
    }
    tl.to(sc.map(h => M.sym(...h)), { keyframes: { scale: [1.15, 1.35, 1.15] }, duration: 0.4, ease: 'none', repeat: 1 }, all + 0.1);
    return all + 0.9;
  }
  function waveEl(M) {
    const wv = el('div', 'mfx-wave mfx-add', M.fx);
    wv.innerHTML = `<svg viewBox="0 0 140 100" preserveAspectRatio="none" width="100%" height="100%"><defs><linearGradient id="mfxwv" x1="0" x2="1"><stop offset="0" stop-color="#bdf3ff"/><stop offset=".25" stop-color="#3fc4ff"/><stop offset=".7" stop-color="#1676d6"/><stop offset="1" stop-color="#0b3f8f"/></linearGradient></defs>
<path d="M30 0 C12 8 4 22 14 34 C22 44 34 38 30 30 C27 24 18 30 22 36 C30 50 12 62 18 78 C22 90 14 96 16 100 L140 100 L140 0 Z" fill="url(#mfxwv)" stroke="#2a0e12" stroke-width="1.2"/>
<path d="M30 0 C12 8 4 22 14 34 C22 44 34 38 30 30 M22 36 C30 50 12 62 18 78 C22 90 14 96 16 100" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/>
<path d="M40 10 C30 30 42 50 34 70 M55 0 C46 30 58 60 50 100 M80 0 C72 40 84 70 76 100" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.4"/></svg>`;
    return wv;
  }
  function waveSweep(M, tl, at, o) {
    o = Object.assign({ dur: 1.35 }, o); const W = M.fx.offsetWidth, H = M.fx.offsetHeight, wv = waveEl(M);
    tl.fromTo(wv, { x: W * 1.02 }, { x: -W * 1.45, duration: o.dur, ease: 'power1.inOut', immediateRender: false }, at);
    const swap = at + o.dur * 0.42;
    S(tl, M.sunset, { opacity: 1 }, swap); S(tl, M.tint, { opacity: 0.9 }, swap);
    for (let k = 0; k < 6; k++) tl.add(burst(M.fx, W * (0.95 - k * 0.17), rnd(H * 0.1, H * 0.9), { n: 7, kind: 'drop', speed: [120, 260], angle: [-200, -140], gravity: 700, dur: 0.7 }), at + o.dur * (0.08 + k * 0.13));
    removeAt(tl, [wv], at + o.dur + 0.05);
    return at + o.dur;
  }
  function freeTitle(M, tl, at, o) {
    o = Object.assign({ spins: 10 }, o); const W = M.fx.offsetWidth;
    const d = darken(M, tl, at, 0.7), a = title(M, 'FREE', 'mega', { top: '28%' }), b = title(M, 'SPINS', 'mega', { top: '46%' });
    tl.fromTo(a, { opacity: 0, x: -W, rotation: -20 }, { opacity: 1, x: 0, rotation: 0, duration: 0.45, ease: 'back.out(1.5)', immediateRender: false }, at + 0.1)
      .fromTo(b, { opacity: 0, x: W, rotation: 20 }, { opacity: 1, x: 0, rotation: 0, duration: 0.45, ease: 'back.out(1.5)', immediateRender: false }, at + 0.25)
      .add(shake(M.cam, { amp: 5, dur: 0.3 }), at + 0.6).add(ring(M.fx, W / 2, M.fx.offsetHeight * 0.37, { size: W, color: '#ff8ab8', width: 6, sy: 0.6 }), at + 0.6);
    const n = el('div', 'mfx-freecount mfx-add', M.fx); n.textContent = '0'; gsap.set(n, { xPercent: -50, yPercent: -50 });
    tl.fromTo(n, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(3)', immediateRender: false }, at + 0.75);
    for (let k = 1; k <= o.spins; k++) {
      const t = at + 0.9 + k * 0.1;
      tl.call(() => { n.textContent = k; }, null, t);
      tl.fromTo(n, { scale: 1 }, { keyframes: { scale: [1, k === o.spins ? 1.6 : 1.18, 1] }, duration: k === o.spins ? 0.4 : 0.09, ease: 'none', immediateRender: false }, t);
    }
    const end = at + 0.9 + o.spins * 0.1 + 0.4;
    tl.add(burst(M.fx, W / 2, M.fx.offsetHeight * 0.62, { n: 18, kind: 'star', speed: [150, 340], gravity: 300, dur: 0.9, colors: ['#ffd23f', '#fff6c8', '#ff8ab8'] }), end - 0.4);
    const chip = el('div', 'mfx-chip mfx-add', M.fx); chip.textContent = 'FREE SPINS LEFT  ' + o.spins; gsap.set(chip, { xPercent: -50 });
    tl.to([a, b, n], { opacity: 0, scale: 0.6, duration: 0.3, ease: 'power2.in' }, end + 0.5).to(d, { opacity: 0, duration: 0.4 }, end + 0.5)
      .fromTo(chip, { opacity: 0, y: M.fx.offsetHeight * 0.5, scale: 1.6 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, ease: 'back.out(1.6)', immediateRender: false }, end + 0.6);
    return end + 1.2;
  }

  bonusDef('F1', { title: 'SURF Chain Pulse', desc: 'The three SURF badges fire one after another (halo, rays, ring), a dotted beam links them, then all three pulse together.', dur: '2.6s' }, (M, o) => {
    const tl = gsap.timeline(); surfPulse(M, tl, 0, o); return tl;
  });
  bonusDef('F2', { title: 'Wave Sweep', desc: 'A giant cartoon wave sweeps across the screen; behind it the beach has turned to sunset and the panel to bonus colours.', dur: '3.0s' }, (M, o) => {
    const tl = gsap.timeline(), t = surfPulse(M, tl, 0, { gap: 0.2, beams: false });
    waveSweep(M, tl, t - 0.3); return tl;
  });
  bonusDef('F3', { title: 'Iris Wipe', desc: 'The screen closes down to a circle on the last SURF badge, goes dark, then opens again on the sunset bonus with the title.', dur: '3.6s' }, (M, o) => {
    const tl = gsap.timeline(), t = surfPulse(M, tl, 0, { gap: 0.2, beams: false }), sc = M.find('S1'), last = sc[sc.length - 1];
    const p = pt(M.cell(...last), M.fx), W = M.fx.offsetWidth, H = M.fx.offsetHeight, R = Math.hypot(W, H);
    const iris = el('div', 'mfx-iris mfx-add', M.fx); iris.style.setProperty('--x', p.x + 'px'); iris.style.setProperty('--y', p.y + 'px'); iris.style.setProperty('--r', R + 'px');
    tl.fromTo(iris, { '--r': R + 'px' }, { '--r': (p.w * 0.6) + 'px', duration: 0.6, ease: 'power3.in', immediateRender: false }, t - 0.2)
      .to(iris, { '--r': '0px', duration: 0.25, ease: 'power2.in' }, t + 0.55);
    const sw = t + 0.85;
    S(tl, M.sunset, { opacity: 1 }, sw); S(tl, M.tint, { opacity: 0.9 }, sw); S(tl, iris, { '--x': W / 2 + 'px', '--y': H / 2 + 'px' }, sw);
    tl.call(() => FX.util.undim(M), null, sw);
    tl.to(iris, { '--r': R + 'px', duration: 0.9, ease: 'power3.out' }, sw + 0.15);
    const tt = title(M, 'FREE SPINS', 'mega', { cls: 'sm' });
    tl.fromTo(tt, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'mfx.pop', immediateRender: false }, sw + 0.35)
      .to(tt, { scale: 1.06, duration: 0.4, yoyo: true, repeat: 1, ease: 'sine.inOut' }, sw + 0.95);
    removeAt(tl, [iris], sw + 1.1);
    return tl;
  });
  bonusDef('F4', { title: 'Sunset Crossfade', desc: 'The beach slowly turns from day to sunset, a warm sun glow blooms, the panel shifts to bonus colours and the spin counter drops in.', dur: '3.4s' }, (M, o) => {
    const tl = gsap.timeline(), sc = M.find('S1'), sun = el('div', 'mfx-sun mfx-add', M.bg);
    sc.forEach(h => { const s = M.sym(...h), hl = addHalo(s); tl.fromTo(hl, { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, 0.1).fromTo(s, { scale: 1 }, { scale: 1.15, duration: 0.4, yoyo: true, repeat: 3, ease: 'sine.inOut', immediateRender: false }, 0.1); });
    tl.fromTo(M.sunset, { opacity: 0 }, { opacity: 1, duration: 1.8, ease: 'sine.inOut', immediateRender: false }, 0.3)
      .fromTo(M.tint, { opacity: 0 }, { opacity: 0.9, duration: 1.6, ease: 'sine.inOut', immediateRender: false }, 0.5)
      .fromTo(sun, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1.1, duration: 1.6, ease: 'sine.out', immediateRender: false }, 0.6)
      .to(sun, { opacity: 0.7, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 2.2);
    const W = M.fx.offsetWidth, H = M.fx.offsetHeight, motes = makeParticles(M.fx, 16, 'mfx-mote', p => sizeP(p, rnd(6, 14)));
    motes.forEach(p => { const x = rnd(0, W), y = rnd(H * 0.4, H); S(tl, p, { x, y }, 0); tl.fromTo(p, { opacity: 0 }, { opacity: 0.9, y: y - rnd(60, 140), x: x + rnd(-30, 30), duration: rnd(1.6, 2.4), ease: 'sine.out', immediateRender: false }, rnd(0.8, 1.4)).to(p, { opacity: 0, duration: 0.5 }, 2.9); });
    const chip = el('div', 'mfx-chip mfx-add', M.fx); chip.textContent = 'FREE SPINS  ' + (o.spins || 10); gsap.set(chip, { xPercent: -50 });
    tl.fromTo(chip, { opacity: 0, yPercent: -200 }, { opacity: 1, yPercent: 0, duration: 0.6, ease: 'bounce.out', immediateRender: false }, 2.0);
    return tl;
  });
  bonusDef('F5', { title: 'FREE SPINS Title', desc: '"FREE" and "SPINS" fly in from both sides and lock together, the spin count ticks up to 10, then shrinks into a counter chip.', dur: '3.6s' }, (M, o) => {
    const tl = gsap.timeline(); freeTitle(M, tl, 0, o); return tl;
  });
  bonusDef('F6', { title: 'Full Trigger Sequence', desc: 'Everything chained: SURF chain pulse, the wave sweep into sunset, then the FREE SPINS title and counter. About 7 s.', dur: '7.2s' }, (M, o) => {
    const tl = gsap.timeline(); let t = surfPulse(M, tl, 0, { hold: 1.0 });
    t = waveSweep(M, tl, t - 0.1); tl.call(() => FX.util.undim(M), null, t - 0.6);
    freeTitle(M, tl, t - 0.2, o); return tl;
  });
  REDUCED.bonus = (M, o) => {
    const tl = gsap.timeline(), t = title(M, 'FREE SPINS', 'mega', { cls: 'sm' });
    tl.fromTo(M.sunset, { opacity: 0 }, { opacity: 1, duration: 0.6, immediateRender: false }, 0.1).fromTo(M.tint, { opacity: 0 }, { opacity: 0.9, duration: 0.6, immediateRender: false }, 0.1)
      .fromTo(t, { opacity: 0 }, { opacity: 1, duration: 0.5, immediateRender: false }, 0.6); return tl;
  };
  Object.assign(FX.bonus, { surfPulse, waveSweep, freeTitle });

  /* ===================================================================================
     10. IDLE / AMBIENT  (I)   (these loop forever: kill the timeline when a spin starts)
     MangoFX.idle.Ix(M, o) -> timeline (repeat -1 inside)
     =================================================================================== */
  const idleDef = (id, meta, fn) => def('idle', id, Object.assign({ scene: 'line', loop: 6 }, meta), fn);
  const tops = M => ['H3', 'H4', 'W'].flatMap(k => M.find(k)).map(h => M.sym(...h));
  idleDef('I1', { title: 'Breathing Tops', desc: 'The mangoes, surfboards and wild breathe slowly in and out, each on its own phase. Very subtle life.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline();
    tops(M).forEach(s => tl.fromTo(s, { scale: 1, yPercent: 0 }, { scale: 1.06, yPercent: -3, duration: rnd(1.1, 1.5), yoyo: true, repeat: -1, ease: 'sine.inOut', immediateRender: false }, rnd(0, 0.8)));
    return tl;
  });
  idleDef('I2', { title: 'Wild Shine', desc: 'Every couple of seconds a glint slides across the wild and a little star twinkles on its corner.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline();
    M.find('W').forEach(h => {
      const s = M.sym(...h), bar = addShine(s), p = pt(M.cell(...h), M.fx);
      tl.fromTo(bar, { xPercent: 0 }, { xPercent: 330, duration: 0.8, ease: 'power2.inOut', repeat: -1, repeatDelay: 1.6, immediateRender: false }, 0.3);
      const st = makeParticles(M.fx, 1, 'mfx-star', q => { sizeP(q, p.w * 0.22); q.style.setProperty('--c', '#fffbe0'); })[0];
      gsap.set(st, { x: p.x + p.w * 0.3, y: p.y - p.h * 0.3, opacity: 1, scale: 0 });
      tl.to(st, { keyframes: { scale: [0, 1.2, 0], rotation: [0, 90, 180] }, duration: 0.6, ease: 'none', repeat: -1, repeatDelay: 1.8 }, 0.75);
    });
    return tl;
  });
  idleDef('I3', { title: 'Light Motes', desc: 'Soft specks of sunlight drift up and twinkle over the beach behind the reels.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline(), lay = el('div', 'mfx-add', M.bg, { position: 'absolute', inset: 0 }), W = M.root.offsetWidth, H = M.root.offsetHeight;
    makeParticles(lay, o.n || 28, 'mfx-mote', p => sizeP(p, rnd(5, 15))).forEach(p => {
      const x = rnd(0, W), y = rnd(0, H); gsap.set(p, { x, y, opacity: 0 });
      tl.to(p, { y: y - rnd(30, 90), x: x + rnd(-25, 25), duration: rnd(3, 5), yoyo: true, repeat: -1, ease: 'sine.inOut' }, rnd(0, 2))
        .to(p, { opacity: rnd(0.5, 1), duration: rnd(0.8, 1.6), yoyo: true, repeat: -1, ease: 'sine.inOut' }, rnd(0, 1.5));
    });
    return tl;
  });
  idleDef('I4', { title: 'Sea Sway', desc: 'Every symbol bobs and sways a touch, like the whole board is floating on a calm sea.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline();
    M.cells().map(symOf).forEach((s, k) => tl.fromTo(s, { rotation: -2.2, yPercent: -1.5 }, { rotation: 2.2, yPercent: 1.5, duration: rnd(1.4, 2.0), yoyo: true, repeat: -1, ease: 'sine.inOut', immediateRender: false }, (k % 5) * 0.18 + Math.floor(k / 5) * 0.1));
    return tl;
  });
  idleDef('I5', { title: 'Attract Hop', desc: 'Now and then a random top symbol does a little hop and squash with a sparkle, to invite a spin.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline({ repeat: -1 }), list = ['H3', 'H4', 'W', 'H1', 'H2'].flatMap(k => M.find(k));
    for (let k = 0; k < 6; k++) {
      const h = pick(list), s = M.sym(...h), p = pt(M.cell(...h), M.fx), t = 0.3 + k * 0.9;
      tl.to(s, { yPercent: -16, scaleY: 1.08, scaleX: 0.95, duration: 0.18, ease: 'power2.out' }, t)
        .to(s, { yPercent: 0, scaleY: 1, scaleX: 1, duration: 0.16, ease: 'power2.in' }, t + 0.18)
        .to(s, { keyframes: { scaleX: [1, 1.12, 1], scaleY: [1, 0.88, 1] }, transformOrigin: '50% 100%', duration: 0.25, ease: 'none' }, t + 0.34)
        .add(burst(M.fx, p.x, p.y - p.h * 0.3, { n: 5, kind: 'star', speed: [50, 120], gravity: 150, dur: 0.6, size: [6, 11], colors: ['#fff6c8', '#ffd23f'] }), t + 0.1);
    }
    return tl;
  });
  idleDef('I6', { title: 'Glass Glint', desc: 'A slow diagonal sheen slides over the reel glass every few seconds, like sun catching the machine.', dur: 'loop' }, (M, o) => {
    const tl = gsap.timeline(), g = el('div', 'mfx-glint mfx-add', M.panel), bar = el('i', null, g);
    tl.fromTo(bar, { xPercent: 0, skewX: -12 }, { xPercent: 480, skewX: -12, duration: 1.3, ease: 'power1.inOut', repeat: -1, repeatDelay: 2.4, immediateRender: false }, 0.4);
    return tl;
  });
  REDUCED.idle = () => gsap.timeline();
})(window);
