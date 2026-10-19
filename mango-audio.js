/*
 * Mango Surf audio - Web Audio module (play money learning project).
 * Fork of sk8-audio.js: same public API plus the extra cues below. Defines exactly one global: window.MangoAudio.
 *
 * 2026-10-19: merged from an outside build of the site (mango-surf.zip). The effects now play from a small kit of recorded
 *   instrument and beach samples (audio/sfx/*.mp3: swish bamboo conga bongo shake shaker marimba ukulele splash1 splash2
 *   rain gull gulls wave surf), with the old synthesis kept as the fallback while a sample is not in yet (smp() returns
 *   null, the caller synthesizes). loadKit() fetches the kit one file at a time, 1.2 s after init() (the first SFX/MUSIC
 *   tap), at low priority; build.js also lists the kit in MANGO_LOAD.later so the loading screen pulls it into the cache
 *   right after the first-screen art, and stamps each file with a content hash (window.MANGO_SFX_V -> ?v=).
 *   New cues the game calls (build.js): stackStep, wildExpand, legendLand, tierUp, freeSpin, combo, topUp, maxWin, buyOpen,
 *   buy, modeSelect, trickSpin, slam, bet, toggle, panel, cash, nope, ui. A quiet surf/gull bed (ambience) runs while SFX is on.
 *   Mute rule: every sample is an SFX voice (sfxBus -> sfxVol): SFX off sets sfxVol to 0 and the game stops calling cues;
 *   the ambience also checks the SFX volume. MUSIC off stops the loop. Origin/licence of the samples: unknown (no tags).
 *
 * Music: one recorded loop, surf theme v2 (audio/surf-theme-v2.*, gapless), fetched after the loading screen at low priority.
 *
 * Graph:
 *   music loop -> fade -> musicMode -> musicBus -> duck -> musicLP -> musicVol --\
 *   sfx voices (synth + samples) -> sfxBus -> sfxVol --------------------------+-> compressor -> master -> destination
 *        \-> sfxVerb / caveVerb (sends) -> sfxBus
 */
(function (root) {
  'use strict';
  if (!root) return;

  var AC = root.AudioContext || root.webkitAudioContext;


  var MASTER = 0.9;
  var MUSIC_LEVEL = 0.154;
  var TICK_MS = 25;
  var CAP = { sfx: 40, music: 96 };
  var LP_OPEN = 20000, LP_DUCK = 4500;


  var ctx = null;
  var muted = false;
  var musicVolume = 0.8;
  var sfxVolume = 1;
  var N = {};
  var noiseBuf = null, pinkBuf = null, brownBuf = null, crackBuf = null, curveSoft = null, curveHard = null;
  var curMode = 'base';
  var musicOn = false;
  var duckCount = 0;
  var antic = null;
  var voices = { sfx: [], music: [] };
  var stats = { created: 0, stolen: 0, leakWarned: false };


  function noop() {}
  function clamp(v, a, b) { v = +v; if (!isFinite(v)) v = a; return v < a ? a : (v > b ? b : v); }
  function mf(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function log10(x) { return Math.log(x) / Math.LN10; }
  function log2(x) { return Math.log(x) / Math.LN2; }
  function ok() { return !!ctx && !muted && ctx.state !== 'closed'; }
  function tNow(pad) { return ctx.currentTime + (pad || 0.01); }
  function rnd() { return Math.random(); }

  function safe(fn, fallback) {
    return function () {
      try { return fn.apply(null, arguments); }
      catch (e) { if (root.console) root.console.warn('[MangoAudio]', e); return fallback; }
    };
  }


  function holdAt(p, t) {
    if (p.cancelAndHoldAtTime) {
      try { p.cancelAndHoldAtTime(t); return; } catch (e) {  }
    }
    var v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }


  function envAD(p, t, a, peak, d) {
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  function envAHR(p, t, a, peak, hold, sus, r) {
    peak = Math.max(peak, 0.0002);
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(Math.max(peak * sus, 0.0001), t + Math.max(hold, a + 0.005));
    p.exponentialRampToValueAtTime(0.0001, t + Math.max(hold, a + 0.005) + r);
  }

  function makeCurve(drive) {
    var n = 1024, c = new Float32Array(n), norm = Math.tanh(drive);
    for (var i = 0; i < n; i++) {
      var x = i * 2 / (n - 1) - 1;
      c[i] = Math.tanh(drive * x) / norm;
    }
    return c;
  }


  function Voice(pool, dest) {
    this.pool = pool;
    this.nodes = [];
    this.sources = [];
    this.pending = 0;
    this.done = false;
    this.stolen = false;
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.nodes.push(this.out);
  }
  Voice.prototype.add = function (n) { this.nodes.push(n); return n; };
  Voice.prototype.play = function (src, t0, t1, offset) {
    var self = this;
    this.nodes.push(src);
    this.sources.push(src);
    this.pending++;
    src.onended = function () { self.pending--; if (self.pending <= 0) self.finish(); };
    if (offset) src.start(t0, offset); else src.start(t0);
    src.stop(t1);
    return src;
  };
  Voice.prototype.finish = function () {
    if (this.done) return;
    this.done = true;
    for (var i = 0; i < this.nodes.length; i++) {
      try { this.nodes[i].disconnect(); } catch (e) {  }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    var list = voices[this.pool], idx = list.indexOf(this);
    if (idx >= 0) list.splice(idx, 1);
  };
  Voice.prototype.steal = function () {
    if (this.stolen || this.done) return;
    this.stolen = true;
    stats.stolen++;
    var now = ctx.currentTime, g = this.out.gain, self = this;
    holdAt(g, now);
    g.linearRampToValueAtTime(0.0001, now + 0.02);
    for (var i = 0; i < this.sources.length; i++) {
      try { this.sources[i].stop(now + 0.03); } catch (e) {  }
    }
    setTimeout(function () { self.finish(); }, 600);
  };

  function newVoice(pool, dest) {
    var list = voices[pool], live = 0, i;
    for (i = 0; i < list.length; i++) if (!list[i].stolen) live++;
    i = 0;
    while (live >= CAP[pool] && i < list.length) {
      if (!list[i].stolen) { list[i].steal(); live--; }
      i++;
    }

    i = 0;
    while (list.length >= CAP[pool] * 2 && i < list.length) {
      if (list[i].stolen) list[i].finish(); else i++;
    }
    var v = new Voice(pool, dest);
    list.push(v);
    stats.created++;
    if (!stats.leakWarned && list.length > CAP[pool] * 3) {
      stats.leakWarned = true;
      if (root.console) root.console.warn('[MangoAudio] voice list growing: ' + pool + '=' + list.length);
    }
    return v;
  }
  function sfxVoice() { return newVoice('sfx', N.sfxBus); }


  function gn(v, dest) { var g = v.add(ctx.createGain()); g.gain.value = 0.0001; g.connect(dest); return g; }
  function gc(v, val, dest) { var g = v.add(ctx.createGain()); g.gain.value = val; g.connect(dest); return g; }
  function hz(f) { return Math.min(f, ctx.sampleRate * 0.45); }
  function filt(v, type, f, q, dest) {
    var b = v.add(ctx.createBiquadFilter());
    b.type = type; b.frequency.value = hz(f); b.Q.value = q; b.connect(dest);
    return b;
  }
  function osc(v, type, f, t0, t1, dest, f1, glide, detune) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + glide);
    if (detune) o.detune.value = detune;
    o.connect(dest);
    v.play(o, t0, t1);
    return o;
  }
  function noise(v, t0, t1, dest, buf, rate) {
    var s = ctx.createBufferSource();
    s.buffer = buf || noiseBuf;
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.connect(dest);
    v.play(s, t0, t1, Math.random() * s.buffer.duration * 0.75);
    return s;
  }
  function shaper(v, curve, dest) {
    var w = v.add(ctx.createWaveShaper());
    w.curve = curve; w.oversample = '2x'; w.connect(dest);
    return w;
  }

  function send(v, node, amt) { if (N.sfxVerb) node.connect(gc(v, amt, N.sfxVerb)); }

  function pn(v, x, dest) {
    if (!ctx.createStereoPanner) return dest;
    var p = v.add(ctx.createStereoPanner());
    p.pan.value = clamp(x, -1, 1);
    p.connect(dest);
    return p;
  }


  function makeIR(sec, dark) {
    var sr = ctx.sampleRate, len = Math.floor(sr * sec), buf = ctx.createBuffer(2, len, sr);
    var er = [[0.011, 0.5], [0.019, 0.35], [0.027, 0.28], [0.041, 0.2], [0.053, 0.14]];
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), lp = 0, pre = Math.floor(sr * (0.014 + c * 0.003));
      for (var i = pre; i < len; i++) {
        var x = (i - pre) / sr, k = (dark ? 0.7 : 0.5) + (dark ? 0.28 : 0.45) * (x / sec);
        lp += (1 - k) * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.exp(-6.9 * x / sec) * Math.min(1, x / 0.025 + 0.15);
      }
      for (var e = 0; e < er.length; e++) {
        var at = Math.floor(sr * (er[e][0] + (c ? 0.0023 * (e + 1) : 0)));
        if (at < len) d[at] += er[e][1] * 0.3 * (c === e % 2 ? 1 : -0.8);
      }
    }
    return buf;
  }

  function makeNoise(kind, sec) {
    var sr = ctx.sampleRate, len = Math.floor(sr * sec), b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0), i;
    if (kind === 'crackle') {
      var n = Math.floor(sec * 1100);
      for (var k = 0; k < n; k++) {
        var at = Math.floor(Math.random() * len), a = Math.pow(Math.random(), 2.2) * (Math.random() < 0.5 ? -1 : 1);
        var w = 2 * Math.PI * (1800 + Math.random() * 7000) / sr, tau = sr * (0.0006 + Math.random() * 0.0018);
        for (var j = 0; j < tau * 5 && at + j < len; j++) d[at + j] += a * Math.exp(-j / tau) * Math.sin(w * j);
      }
      return b;
    }
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (i = 0; i < len; i++) {
      var x = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.969 * b2 + x * 0.153852;
        b3 = 0.8665 * b3 + x * 0.3104856; b4 = 0.55 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11; b6 = x * 0.115926;
      } else if (kind === 'brown') {
        br = (br + 0.02 * x) / 1.02; d[i] = br * 3.5;
      } else d[i] = x;
    }
    return b;
  }


  function partial(v, dest, t, f, amp, dec, att, det, f0, gl) {
    if (f > ctx.sampleRate * 0.45 || amp < 0.0002) return;
    att = att || 0.002;
    var g = gn(v, dest); envAD(g.gain, t, att, amp, dec);
    osc(v, 'sine', f0 || f, t, t + att + dec + 0.05, g, f0 ? f : 0, gl || 0, det || 0);
  }

  function tick(v, dest, t, fc, q, amp, len, buf) {
    var g = gn(v, dest); envAD(g.gain, t, 0.0008, amp, len);
    noise(v, t, t + len + 0.03, filt(v, 'bandpass', fc, q, g), buf);
  }


  function marimba(v, dest, t, f, peak, soft) {
    var dec = clamp(0.55 * Math.pow(392 / f, 0.6), 0.16, 1.3);
    partial(v, dest, t, f, peak, dec, 0.0025);
    partial(v, dest, t, f * 3.93, peak * (soft ? 0.07 : 0.15), dec * 0.2, 0.001);
    partial(v, dest, t, f * 9.2, peak * (soft ? 0.012 : 0.04), dec * 0.06, 0.0008);
    tick(v, dest, t, Math.min(f * 2.2, 5000), 1.2, peak * (soft ? 0.3 : 0.55), 0.01);
  }

  function steelPan(v, dest, t, f, peak, dur) {
    partial(v, dest, t, f, peak * 0.7, dur, 0.002, 0, f * 1.008, 0.035);
    partial(v, dest, t, f * 2, peak * 0.3, dur * 0.65, 0.009, 6);
    partial(v, dest, t, f * 2, peak * 0.14, dur * 0.5, 0.005, -5);
    partial(v, dest, t, f * 3, peak * 0.1, dur * 0.3, 0.003);
    partial(v, dest, t, f * 4.02, peak * 0.03, dur * 0.12, 0.002);
    tick(v, dest, t, 2400, 0.8, peak * 0.35, 0.007);
  }

  function panRoll(v, dest, t, f, peak, dur) {
    partial(v, dest, t, f, peak * 0.75, dur, 0.002);
    partial(v, dest, t, f * 2, peak * 0.32, dur * 0.6, 0.006, 5);
    tick(v, dest, t, 2400, 0.8, peak * 0.25, 0.006);
  }
  function panChord(v, t, base, dur, peak) {
    var ns = [base, base + 4, base + 7, base + 12];
    for (var i = 0; i < ns.length; i++) steelPan(v, pn(v, -0.3 + 0.2 * i, v.out), t + i * 0.014 + rnd() * 0.004, mf(ns[i]), peak, dur);
  }

  function chimeBar(v, dest, t, f, peak, dur) {
    partial(v, dest, t, f, peak, dur, 0.0015);
    partial(v, dest, t, f * 2.756, peak * 0.32, dur * 0.4, 0.001);
    partial(v, dest, t, f * 5.404, peak * 0.1, dur * 0.15, 0.001);
  }

  var CHIMES = [79, 81, 83, 86, 88, 91, 93, 95, 98];
  function windChimes(v, t, n, span, peak) {
    var last = -1;
    for (var k = 0; k < n; k++) {
      var m; do { m = Math.floor(rnd() * CHIMES.length); } while (m === last && CHIMES.length > 1);
      last = m;
      var tk = t + span * (k / n) + rnd() * (span / n) * 0.8, d = pn(v, rnd() * 1.4 - 0.7, v.out);
      send(v, d, 0.5);
      chimeBar(v, d, tk, mf(CHIMES[m]) * (1 + (rnd() - 0.5) * 0.004), peak * (0.55 + 0.45 * rnd()) * (k ? 1 : 1.2), 1.1 + rnd() * 0.9);
    }
  }

  function woodKnock(v, dest, t, f, peak) {
    var e = v.add(ctx.createGain()); e.gain.value = 0.0001;
    envAD(e.gain, t, 0.0005, 1, 0.006);
    noise(v, t, t + 0.03, e);
    var modes = [[1, 22, 45], [2.31, 16, 20], [3.95, 12, 10]];
    for (var k = 0; k < modes.length; k++) {
      if (f * modes[k][0] > ctx.sampleRate * 0.4) break;
      e.connect(filt(v, 'bandpass', f * modes[k][0], modes[k][1], gc(v, peak * modes[k][2], dest)));
    }
    e.connect(filt(v, "lowpass", 1300, 0.7, gc(v, peak * 1.2, dest)));
  }

  function thump(v, t, peak, dest) {
    dest = dest || v.out;
    partial(v, dest, t, mf(31), peak, 0.2, 0.002, 0, 160, 0.1);
    tick(v, dest, t, 700, 0.8, peak * 0.35, 0.012);
  }

  function sub(v, t, midi, peak, dur) {
    var g = gn(v, v.out); envAHR(g.gain, t, 0.008, peak, dur * 0.5, 0.5, dur * 0.5);
    osc(v, 'sine', mf(midi), t, t + dur + 0.05, g);
    osc(v, 'sine', mf(midi + 12), t, t + dur * 0.5 + 0.05, gc(v, 0.25, g));
  }

  function shaker(v, dest, t, peak, len, bright) {
    var g = gn(v, dest); envAD(g.gain, t, len * 0.4, peak, len * 0.6);
    noise(v, t, t + len + 0.03, filt(v, 'bandpass', bright ? 7200 : 5200, 0.9, g), crackBuf, 1.5);
    var g2 = gn(v, dest); envAD(g2.gain, t + len * 0.38, 0.002, peak * 0.5, 0.025);
    noise(v, t + len * 0.38, t + len * 0.38 + 0.05, filt(v, 'highpass', 5500, 0.7, g2));
  }


  function bubble(v, dest, t, f, amp) {
    var d = 0.006 + 14 / f;
    partial(v, dest, t, f * 1.35, amp, d, 0.0015, 0, f, d * 1.1);
  }
  function bubbles(v, t, span, n, lo, hi, amp, width) {
    var ps = [pn(v, -width, v.out), pn(v, 0, v.out), pn(v, width, v.out)];
    for (var k = 0; k < n; k++) {
      var u = rnd();
      bubble(v, ps[k % 3], t + span * u * u, lo * Math.pow(hi / lo, rnd()), amp * (0.3 + 0.7 * rnd()) * (1 - 0.6 * u));
    }
  }

  function splash(v, t, peak, dur) {
    if (!sample(v, v.out, t, spl(), peak * 1.6, 0.95 + 0.25 * rnd(), { dur: Math.min(1.45, dur + 0.5), fade: Math.min(1, dur) })) splashSynth(v, t, peak, dur);
  }
  function splashSynth(v, t, peak, dur) {
    var C = v.out;
    var g = gn(v, C); envAD(g.gain, t, 0.002, peak * 0.9, 0.09);
    var lp = filt(v, 'lowpass', 6000, 0.6, g);
    lp.frequency.setValueAtTime(hz(6000), t); lp.frequency.exponentialRampToValueAtTime(900, t + 0.1);
    noise(v, t, t + 0.14, lp);
    var gb = gn(v, C); envAHR(gb.gain, t, 0.012, peak * 0.9, dur * 0.35, 0.4, dur * 0.65);
    var bp = filt(v, 'bandpass', 1800, 0.8, gb);
    bp.frequency.setValueAtTime(1800, t); bp.frequency.exponentialRampToValueAtTime(450, t + dur);
    noise(v, t, t + dur + 0.05, bp, pinkBuf);
    for (var s = -1; s <= 1; s += 2) {
      var gs = gn(v, pn(v, s * 0.5, C)); envAD(gs.gain, t + 0.01, 0.025, peak * 1.2, dur * 0.8);
      noise(v, t, t + dur + 0.1, filt(v, 'highpass', 2500, 0.6, gs), crackBuf, 0.85 + 0.3 * rnd());
    }
    partial(v, C, t, 70, peak * 0.6, 0.12, 0.003, 0, 140, 0.05);
    bubbles(v, t + 0.04, dur * 0.9, Math.round(6 + dur * 14), 350, 2200, peak * 0.4, 0.5);
  }

  function waveCrash(v, t, peak, dur) {
    sample(v, v.out, t, OCEAN.wash, peak * 1.2, 0.9, { offset: 0.35 });
    for (var s = -1; s <= 1; s += 2) {
      var side = pn(v, s * 0.6, v.out);
      var g = gn(v, side); envAHR(g.gain, t, 0.05 + 0.02 * (s + 1), peak, dur * 0.3, 0.45, dur * 0.7);
      var lp = filt(v, 'lowpass', 2800, 0.5, g);
      lp.frequency.setValueAtTime(2800, t); lp.frequency.exponentialRampToValueAtTime(320, t + dur);
      noise(v, t, t + dur + 0.1, lp, pinkBuf);
      var gf = gn(v, side); envAD(gf.gain, t + 0.04, 0.12, peak * 1.3, dur * 0.85);
      noise(v, t, t + dur + 0.1, filt(v, 'highpass', 1800, 0.6, gf), crackBuf, 0.7 + 0.1 * s);
    }
    var gr = gn(v, v.out); envAHR(gr.gain, t, 0.03, peak * 0.9, dur * 0.4, 0.4, dur * 0.6);
    noise(v, t, t + dur + 0.1, filt(v, 'lowpass', 220, 0.7, gr), brownBuf);
    var gh = gn(v, v.out); envAD(gh.gain, t, 0.01, peak * 0.2, dur * 0.4);
    noise(v, t, t + dur * 0.4 + 0.05, filt(v, 'highpass', 6000, 0.7, gh));
    bubbles(v, t + 0.25, dur * 0.8, 16, 300, 1800, peak * 0.3, 0.7);
  }


  var ksCache = {};
  function ksBuf(midi, vi) {
    var key = midi + ':' + vi;
    if (ksCache[key]) return ksCache[key];
    var sr = ctx.sampleRate, f = mf(midi), P = sr / f, L = Math.max(2, Math.floor(P - 0.6)), dd = P - L - 0.5;
    var c = (1 - dd) / (1 + dd);
    var t60 = clamp(2.3 * Math.pow(262 / f, 0.45), 0.6, 3), loss = Math.pow(10, -3 / (t60 * f));
    var bright = [0.5, 0.62, 0.42][vi % 3];
    var len = Math.floor(sr * Math.min(1.8, t60 + 0.25)), b = ctx.createBuffer(1, len, sr), out = b.getChannelData(0);
    var ring = new Float32Array(L), ex = new Float32Array(L), lp = 0, pos = Math.max(1, Math.floor(L * (0.18 + 0.06 * (vi % 3)))), i;

    for (i = 0; i < L; i++) { lp += bright * ((Math.random() * 2 - 1) - lp); ex[i] = lp; }
    var mean = 0;
    for (i = 0; i < L; i++) { ring[i] = (i < pos ? i / pos : (L - i) / (L - pos)) + 0.35 * ex[i]; mean += ring[i]; }
    mean /= L;
    for (i = 0; i < L; i++) ring[i] -= mean;
    var idx = 0, prev = 0, apx = 0, apy = 0, pk = 0;
    for (var n = 0; n < len; n++) {
      var cur = ring[idx];
      out[n] = cur;
      var avg = loss * 0.5 * (cur + prev); prev = cur;
      var ap = c * avg + apx - c * apy; apx = avg; apy = ap;
      ring[idx] = ap;
      if (++idx >= L) idx = 0;
      var a = cur < 0 ? -cur : cur; if (a > pk) pk = a;
    }
    var fade = Math.floor(sr * 0.05);
    for (i = 0; i < len; i++) out[i] = out[i] / (pk || 1) * 0.5 * (i > len - fade ? (len - i) / fade : 1);
    ksCache[key] = b;
    return b;
  }

  var WARM = [67, 62, 71, 60, 64, 72, 69, 66, 74, 79, 76];
  function warmStrings() {
    var q = [];
    for (var i = 0; i < WARM.length; i++) for (var vi = 0; vi < 2; vi++) q.push([WARM[i], vi]);
    (function next() {
      if (!ctx || !q.length) return;
      if (held()) { setTimeout(next, 250); return; }
      var j = q.shift();
      try { ksBuf(j[0], j[1]); } catch (e) { return; }
      setTimeout(next, 20);
    })();
  }
  function ukeBody(v, dest) {
    var sh = filt(v, 'highshelf', 4500, 0.7, dest); sh.gain.value = -5;
    var p2 = filt(v, 'peaking', 1900, 1, sh); p2.gain.value = 2.5;
    var p1 = filt(v, 'peaking', 280, 1.4, p2); p1.gain.value = 4;
    return filt(v, 'highpass', 110, 0.7, p1);
  }

  function uke(v, body, t, midi, peak, o) {
    o = o || {};
    var vi = o.vi != null ? o.vi : Math.floor(rnd() * 3);
    var b = ksBuf(midi, vi), s = ctx.createBufferSource(), end;
    s.buffer = b;
    if (o.steps && o.steps.length > 1) {
      var sd = (o.dur || 0.3) / (o.steps.length - 1);
      s.playbackRate.setValueAtTime(Math.pow(2, (o.steps[0] - midi) / 12), t);
      for (var j = 1; j < o.steps.length; j++) {
        s.playbackRate.setValueAtTime(Math.pow(2, (o.steps[j - 1] - midi) / 12), t + j * sd - 0.01);
        s.playbackRate.exponentialRampToValueAtTime(Math.pow(2, (o.steps[j] - midi) / 12), t + j * sd);
      }
    }
    if (o.vib) {
      var lfo = ctx.createOscillator(); lfo.frequency.value = 3 / BEAT;
      lfo.connect(gc(v, o.vib, s.playbackRate)); v.play(lfo, t, t + (o.len || 1) + 0.1);
    }
    var g = gn(v, body);
    g.gain.setValueAtTime(peak, t);
    if (o.len) {
      g.gain.setValueAtTime(peak, t + o.len);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.len + 0.06);
      end = t + o.len + 0.08;
    } else end = t + b.duration / (o.steps ? Math.pow(2, (o.steps[o.steps.length - 1] - midi) / 12) : 1);
    s.connect(g);
    v.play(s, t, end);
    return s;
  }

  var UKE = { G: [67, 62, 67, 71], C: [67, 60, 64, 72], D: [69, 62, 66, 69], Em: [67, 64, 67, 71], D7: [69, 62, 66, 72],
              G8: [74, 67, 71, 79] };
  function strum(v, body, t, notes, peak, o) {
    o = o || {};
    var ord = o.up ? notes.slice().reverse() : notes, sp = o.spread || 0.016, ti = t;
    var p = peak / Math.sqrt(notes.length) * 1.6;
    for (var i = 0; i < ord.length; i++) {
      uke(v, body, ti, ord[i], p * (0.85 + 0.3 * rnd()) * (o.up && i > 1 ? 0.8 : 1), { len: o.len, vi: (i + (o.up ? 1 : 0)) % 3 });
      ti += sp * (0.75 + 0.5 * rnd());
    }
    tick(v, body, t, o.up ? 4200 : 3400, 1.2, peak * 0.12, Math.max(0.02, ti - t));
  }

  function tremoloStrum(v, body, t, notes, dur, peak, step) {
    var n = Math.max(1, Math.round(dur / step));
    for (var k = 0; k < n; k++) {
      var last = k === n - 1;
      strum(v, body, t + k * step, notes, peak * (0.72 + 0.28 * (k / n)) * (k % 2 ? 0.8 : 1),
            { up: k % 2 === 1, spread: 0.009, len: last ? null : step * 1.1 });
    }
  }


  function conch(v, dest, t, midi, len, peak) {
    var f = mf(midi), end = t + len;
    var g = gn(v, dest);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak * 0.7, t + 0.09);
    g.gain.linearRampToValueAtTime(peak, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
    send(v, g, 0.9);
    var lp = filt(v, 'lowpass', 3200, 0.5, g);
    var src = v.add(ctx.createGain()); src.gain.value = 1;
    var fm = [[560, 3.5, 1], [1150, 5, 0.55], [2500, 7, 0.22]];
    for (var k = 0; k < fm.length; k++) src.connect(filt(v, 'bandpass', fm[k][0], fm[k][1], gc(v, fm[k][2], lp)));
    src.connect(gc(v, 0.12, lp));
    var lfo = ctx.createOscillator(); lfo.frequency.value = 5.3;
    var depth = v.add(ctx.createGain()); depth.gain.setValueAtTime(0, t);
    depth.gain.setValueAtTime(0, t + 0.25); depth.gain.linearRampToValueAtTime(f * 0.007, t + len * 0.85);
    lfo.connect(depth);
    v.play(lfo, t, end + 0.3);
    var types = ['sawtooth', 'triangle'], lv = [1, 0.5];
    for (var i = 0; i < 2; i++) {
      var o = ctx.createOscillator(); o.type = types[i]; o.detune.value = i ? 8 : 0;
      o.frequency.setValueAtTime(f * 0.89, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.14);
      o.frequency.setValueAtTime(f, end - 0.12); o.frequency.exponentialRampToValueAtTime(f * 0.94, end + 0.22);
      depth.connect(o.frequency);
      o.connect(gc(v, lv[i], src));
      v.play(o, t, end + 0.3);
    }
    var gb = gn(v, dest);
    gb.gain.setValueAtTime(0.0001, t); gb.gain.linearRampToValueAtTime(peak * 0.35, t + 0.06);
    gb.gain.linearRampToValueAtTime(peak * 0.22, t + len * 0.5); gb.gain.exponentialRampToValueAtTime(0.0001, end + 0.2);
    noise(v, t, end + 0.25, filt(v, 'bandpass', f * 2, 2, gb), pinkBuf);
    var gh = gn(v, dest); envAHR(gh.gain, t, 0.05, peak * 0.05, len, 0.6, 0.2);
    noise(v, t, end + 0.25, filt(v, 'highpass', 3000, 0.7, gh));
  }

  function neutralTick() {
    var v = sfxVoice(), t = tNow();
    woodKnock(v, v.out, t, mf(71) * (1 + (rnd() - 0.5) * 0.02), 0.07);
  }

  function wipe(v, t, k) {
    var d = pn(v, -0.15, v.out);
    if (d.pan) { d.pan.setValueAtTime(-0.15, t); d.pan.linearRampToValueAtTime(0.45, t + 0.9); }
    send(v, d, 0.6);
    var body = ukeBody(v, d), fall = [74, 72, 71, 69, 67, 66, 64, 62, 60, 59, 57, 55, 54, 52, 50];
    var st = Math.min(0.75 / fall.length, beatLen(t) / 12);
    uke(v, body, t, 74, 0.8 * k, { steps: fall, dur: st * (fall.length - 1), len: 0.8, vib: 0.012, vi: 0 });
    uke(v, body, t + 0.01, 62, 0.3 * k, { steps: fall.map(function (m) { return m - 12; }), dur: st * (fall.length - 1), len: 0.8, vi: 1 });
    var gw = gn(v, d);
    gw.gain.setValueAtTime(0.0001, t + 0.5); gw.gain.linearRampToValueAtTime(0.1 * k, t + 0.68);
    gw.gain.exponentialRampToValueAtTime(0.0001, t + 0.78);
    var wb = filt(v, 'bandpass', 2500, 1, gw); wb.frequency.setValueAtTime(2500, t + 0.5); wb.frequency.exponentialRampToValueAtTime(600, t + 0.78);
    noise(v, t + 0.5, t + 0.82, wb, pinkBuf);
    splash(v, t + 0.72, 0.17 * k, 0.55);
    thump(v, t + 0.72, 0.18 * k);
  }


  var OCEAN = { splash: [], wash: null, stream: null, deep: null };
  function seeded(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; }; }

  function rBubble(L, R, sr, t0, f, amp, pan, rise) {
    var d = 0.003 + 8 / f, n = Math.floor(d * 5 * sr), s0 = Math.floor(t0 * sr), ph = 0;
    var gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4), att = 0.0005 * sr;
    for (var j = 0; j < n && s0 + j < L.length; j++) {
      var tt = j / sr, fr = f * (1 + rise * tt / d);
      ph += 2 * Math.PI * fr / sr;
      var x = amp * Math.exp(-tt / d) * (j < att ? j / att : 1) * Math.sin(ph);
      L[s0 + j] += x * gl; R[s0 + j] += x * gr;
    }
  }

  function rGrain(L, R, sr, t0, dur, fc, q, amp, pan, rand) {
    var n = Math.floor(dur * sr), s0 = Math.floor(t0 * sr), lo = 0, bd = 0, F = 2 * Math.sin(Math.PI * Math.min(fc, sr * 0.2) / sr);
    var gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (var j = 0; j < n && s0 + j < L.length; j++) {
      var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / n), x = rand() * 2 - 1;
      lo += F * bd; var hi = x - lo - q * bd; bd += F * hi;
      var y = bd * amp * w; L[s0 + j] += y * gl; R[s0 + j] += y * gr;
    }
  }
  function norm(L, R, peak) {
    var m = 0, i;
    for (i = 0; i < L.length; i++) { var a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > m) m = a; }
    var k = m ? peak / m : 1, fade = Math.min(L.length, Math.floor(ctx.sampleRate * 0.04));
    for (i = 0; i < L.length; i++) { var f = i > L.length - fade ? (L.length - i) / fade : 1; L[i] *= k * f; R[i] *= k * f; }
  }
  function renderSplash(seed) {
    var rand = seeded(seed), sr = ctx.sampleRate, len = Math.floor(sr * 1.5), b = ctx.createBuffer(2, len, sr);
    var L = b.getChannelData(0), R = b.getChannelData(1), i, k;

    var a = 0, c = 0;
    for (i = 0; i < sr * 0.3; i++) {
      var t = i / sr, env = Math.exp(-t / 0.03) * Math.min(1, i / (0.0008 * sr)), kk = 0.2 + 0.75 * Math.min(1, t / 0.12);
      a += (1 - kk) * ((rand() * 2 - 1) - a); c += (1 - kk) * ((rand() * 2 - 1) - c);
      L[i] += a * env * 1.6; R[i] += c * env * 1.6;
    }

    for (k = 0; k < 260; k++) {
      var t0 = 0.01 + 0.9 * Math.pow(rand(), 1.7), age = t0 / 0.9;
      rGrain(L, R, sr, t0, 0.008 + 0.05 * rand(), 300 + (2600 - 1900 * age) * rand(), 0.5 + rand(), 0.55 * (1 - 0.8 * age) * (0.3 + 0.7 * rand()), rand() * 1.6 - 0.8, rand);
    }

    for (k = 0; k < 300; k++) rBubble(L, R, sr, 0.04 + 1.1 * Math.pow(rand(), 1.4), 1800 + 6000 * rand(), 0.05 * rand(), rand() * 1.8 - 0.9, 0.25);

    for (k = 0; k < 130; k++) rBubble(L, R, sr, 0.02 + 0.7 * Math.pow(rand(), 2), 260 * Math.pow(6, rand()), 0.16 * (0.3 + 0.7 * rand()), rand() * 1.2 - 0.6, 0.15 + 0.3 * rand());
    norm(L, R, 0.85);
    return b;
  }

  function renderWash(seed) {
    var rand = seeded(seed), sr = ctx.sampleRate, sec = 2.8, len = Math.floor(sr * sec), b = ctx.createBuffer(2, len, sr);
    var L = b.getChannelData(0), R = b.getChannelData(1), a = 0, c = 0, a2 = 0, c2 = 0, i, k;
    for (i = 0; i < len; i++) {
      var t = i / sr, env = t < 0.55 ? Math.pow(t / 0.55, 1.6) : Math.exp(-(t - 0.55) / 0.75);
      var open = t < 0.55 ? 0.35 + 0.55 * (t / 0.55) : 0.9 - 0.6 * Math.min(1, (t - 0.55) / 1.6), kk = 1 - open * 0.5;
      a += (1 - kk) * ((rand() * 2 - 1) - a); c += (1 - kk) * ((rand() * 2 - 1) - c);
      a2 += 0.02 * ((rand() * 2 - 1) - a2); c2 += 0.02 * ((rand() * 2 - 1) - c2);
      L[i] += (a * 0.9 + a2 * 6) * env; R[i] += (c * 0.9 + c2 * 6) * env;
    }
    for (k = 0; k < 1800; k++) {
      var tf = 0.3 + 2.3 * Math.pow(rand(), 0.9), ef = tf < 0.6 ? tf / 0.6 : Math.exp(-(tf - 0.6) / 0.9);
      rBubble(L, R, sr, tf, 2200 + 7000 * rand(), 0.045 * ef * rand(), rand() * 1.8 - 0.9, 0.3);
    }
    for (k = 0; k < 140; k++) rGrain(L, R, sr, 0.2 + 1.6 * rand(), 0.02 + 0.08 * rand(), 500 + 1500 * rand(), 0.8, 0.25 * rand(), rand() * 1.6 - 0.8, rand);
    norm(L, R, 0.85);
    return b;
  }

  function renderStream(seed) {
    var rand = seeded(seed), sr = ctx.sampleRate, len = Math.floor(sr * 3), b = ctx.createBuffer(2, len, sr);
    var L = b.getChannelData(0), R = b.getChannelData(1);
    for (var k = 0; k < 190; k++) rBubble(L, R, sr, 2.9 * rand(), 280 * Math.pow(5, rand()), 0.12 * (0.3 + 0.7 * rand()), rand() * 1.6 - 0.8, 0.5 + 0.6 * rand());
    norm(L, R, 0.7);
    return b;
  }
  function renderOcean() {
    var jobs = [function () { OCEAN.splash[0] = renderSplash(11); }, function () { OCEAN.wash = renderWash(7); },
                function () { OCEAN.splash[1] = renderSplash(23); }, function () { OCEAN.stream = renderStream(5); },
                function () { OCEAN.splash[2] = renderSplash(37); }];
    (function next() { if (!ctx || !jobs.length) return; if (held()) { setTimeout(next, 250); return; } try { jobs.shift()(); } catch (e) { return; } setTimeout(next, 30); })();
  }

  function sample(v, dest, t, buf, peak, rate, o) {
    if (!buf) return null;
    o = o || {};
    var s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate || 1; if (o.loop) s.loop = true;
    var g = gc(v, peak, dest), tail = g;
    if (o.lp) tail = filt(v, 'lowpass', o.lp, 0.7, tail);
    if (o.hp) tail = filt(v, 'highpass', o.hp, 0.7, tail);
    s.connect(tail);
    var dur = o.dur || (buf.duration - (o.offset || 0)) / (rate || 1);
    if (o.fade) { g.gain.setValueAtTime(peak, t + Math.max(0, dur - o.fade)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
    v.play(s, t, t + dur + 0.02, o.offset || 0);
    return g;
  }
  var spl = function () { return OCEAN.splash[Math.floor(rnd() * OCEAN.splash.length)]; };


  var SB = {}, SB_LIST = ['swish', 'bamboo', 'conga', 'bongo', 'shake', 'shaker', 'marimba', 'ukulele', 'splash1', 'splash2', 'rain', 'gull', 'gulls', 'wave', 'surf'];
  function loadKit() {
    var q = SB_LIST.slice();
    (function next() {
      if (!ctx || !q.length || !root.fetch) return;
      if (held()) { setTimeout(next, 250); return; }
      var n = q.shift();
      var V = root.MANGO_SFX_V || {};   // content hash per file (build.js): same address as MANGO_LOAD.later, so the cached copy is used
      root.fetch('audio/sfx/' + n + '.mp3' + (V[n] ? '?v=' + V[n] : ''), { priority: 'low', credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(decodeBuf).then(function (b) { SB[n] = b; }, function () {})
        .then(function () { setTimeout(next, 20); });
    })();
  }
  function smp(v, dest, t, name, peak, rate, o) { return sample(v, dest, t, SB[name], peak, (rate || 1) * (1 + (rnd() - 0.5) * 0.01), o); }

  function mar(v, dest, t, midi, peak) { while (midi < 62) midi += 12; while (midi > 88) midi -= 12; return smp(v, dest, t, 'marimba', peak, Math.pow(2, (midi - 79) / 12)); }

  function uk(v, dest, t, semis, peak, len) { return smp(v, dest, t, 'ukulele', peak, Math.pow(2, semis / 12), len ? { dur: len, fade: len * 0.5 } : null); }


  function sendCave(v, node, amt) { if (N.caveVerb) node.connect(gc(v, amt, N.caveVerb)); }

  function whoosh(v, dest, t, peak, dur, o) {
    o = o || {};
    var p = pn(v, o.from || 0, dest);
    if (p.pan) { p.pan.setValueAtTime(o.from || 0, t); p.pan.linearRampToValueAtTime(o.to == null ? 0 : o.to, t + dur); }
    var g = gn(v, p);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + dur * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var f0 = o.f0 || 500, f1 = o.f1 || 2600;
    var bp = filt(v, 'bandpass', f0, 0.8, g);
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.55); bp.frequency.exponentialRampToValueAtTime(f0 * 1.4, t + dur);
    var n0 = v.add(ctx.createGain()); n0.gain.value = 1; n0.connect(bp);
    var dl = v.add(ctx.createDelay(0.03));
    dl.delayTime.setValueAtTime(0.009, t); dl.delayTime.exponentialRampToValueAtTime(0.0011, t + dur * 0.6); dl.delayTime.exponentialRampToValueAtTime(0.004, t + dur);
    n0.connect(dl); dl.connect(bp); dl.connect(gc(v, 0.55, dl));
    noise(v, t, t + dur + 0.05, n0, pinkBuf);
    var ga = gn(v, p); envAD(ga.gain, t + dur * 0.3, dur * 0.25, peak * 0.25, dur * 0.4);
    noise(v, t, t + dur + 0.05, filt(v, 'highpass', 5000, 0.7, ga));
  }

  function riser(v, dest, t, dur, peak) {
    var g = gn(v, dest);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + dur); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.03);
    var bp = filt(v, 'bandpass', 250, 1.3, g);
    bp.frequency.setValueAtTime(250, t); bp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    noise(v, t, t + dur + 0.05, bp, pinkBuf);
    var tg = gn(v, dest);
    tg.gain.setValueAtTime(0.0001, t); tg.gain.exponentialRampToValueAtTime(peak * 0.3, t + dur); tg.gain.linearRampToValueAtTime(0.0001, t + dur + 0.03);
    var lp = filt(v, 'lowpass', 500, 3, tg);
    lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(5000, t + dur);
    for (var i = 0; i < 2; i++) osc(v, 'sawtooth', mf(43), t, t + dur + 0.05, lp, mf(55), dur, i ? 14 : -14);
    sample(v, filt(v, 'highpass', 900, 0.7, dest), t, OCEAN.stream, peak * 0.5, 1.6, { dur: dur, offset: rnd() * 1 });
  }

  function impact(v, t, peak) {
    partial(v, v.out, t, 33, peak, 0.75, 0.003, 0, 75, 0.14);
    var g = gn(v, v.out); envAD(g.gain, t, 0.002, peak * 1.1, 0.2);
    noise(v, t, t + 0.28, filt(v, 'lowpass', 450, 0.8, g), pinkBuf);
    tick(v, v.out, t, 3200, 0.7, peak * 0.45, 0.012);
    sendCave(v, g, 0.7);
  }

  function punch(v, dest, t, peak, f0, f1, dec) {
    partial(v, dest, t, f1 || 46, peak, dec || 0.16, 0.0015, 0, f0 || 130, 0.045);
    tick(v, dest, t, 1800, 0.9, peak * 0.3, 0.006);
  }


  function drop(v, dest, t, f, peak) {
    var d = clamp(0.1 * Math.pow(700 / f, 0.5), 0.05, 0.22);
    partial(v, dest, t, f * 1.15, peak, d, 0.0015, 0, f * 0.9, d * 0.8);
    partial(v, dest, t, f * 2.02, peak * 0.1, d * 0.45, 0.001, 0, f * 1.85, d * 0.4);
    tick(v, dest, t, Math.min(9000, f * 5), 2, peak * 0.3, 0.003);
    if (rnd() < 0.5) bubble(v, dest, t + d * 0.8, f * (1.6 + rnd()), peak * 0.18);
  }

  function glitter(v, t, dur, peak) {
    for (var s = -1; s <= 1; s += 2) {
      var g = gn(v, pn(v, s * 0.7, v.out)); envAHR(g.gain, t, dur * 0.2, peak, dur * 0.4, 0.5, dur * 0.6);
      noise(v, t, t + dur + 0.1, filt(v, 'highpass', 4500, 0.7, g), crackBuf, 1.3 + 0.2 * s);
    }
    bubbles(v, t, dur, 5 + Math.round(dur * 6), 2500, 7000, peak * 0.6, 0.8);
    send(v, v.out, 0.2);
  }

  function shell(v, dest, t, peak) {
    var e = v.add(ctx.createGain()); e.gain.value = 0.0001;
    envAD(e.gain, t, 0.0004, 1, 0.003);
    noise(v, t, t + 0.02, e);
    var f = 2100 + 1500 * rnd();
    e.connect(filt(v, 'bandpass', f, 14, gc(v, peak * 30, dest)));
    e.connect(filt(v, 'bandpass', f * 1.71, 10, gc(v, peak * 14, dest)));
    tick(v, dest, t, 6500, 1.5, peak * 0.5, 0.003);
  }
  function shells(v, t, n, span, peak) {
    for (var k = 0; k < n; k++) shell(v, pn(v, rnd() * 1.4 - 0.7, v.out), t + span * Math.pow(k / Math.max(1, n), 1.4) + rnd() * 0.015, peak * (0.5 + 0.5 * rnd()));
  }


  function sonar(v, dest, t, f, peak) {
    partial(v, dest, t, f, peak, 0.9, 0.003, 0, f * 1.015, 0.1);
    partial(v, dest, t, f * 2.005, peak * 0.1, 0.3, 0.003);
    for (var k = 1; k <= 3; k++) partial(v, pn(v, k % 2 ? -0.65 : 0.65, v.out), t + k * 0.29, f * 0.998, peak * Math.pow(0.34, k), 0.7, 0.006);
    sendCave(v, dest, 0.5);
  }

  function whale(v, dest, t, f, len, peak) {
    var end = t + len, g = gn(v, dest);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + len * 0.35);
    g.gain.setValueAtTime(peak, t + len * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, end);
    sendCave(v, g, 1.1);
    var lp = filt(v, 'lowpass', 1800, 0.7, g), src = v.add(ctx.createGain()); src.gain.value = 1;
    var f1 = filt(v, 'bandpass', 380, 5, gc(v, 1, lp));
    f1.frequency.setValueAtTime(330, t); f1.frequency.linearRampToValueAtTime(720, t + len * 0.45); f1.frequency.linearRampToValueAtTime(380, end);
    src.connect(f1);
    src.connect(filt(v, 'bandpass', 950, 6, gc(v, 0.5, lp)));
    src.connect(filt(v, 'bandpass', 2300, 8, gc(v, 0.15, lp)));
    var lfo = ctx.createOscillator(); lfo.frequency.value = 3.4;
    var dep = v.add(ctx.createGain()); dep.gain.setValueAtTime(0, t); dep.gain.linearRampToValueAtTime(f * 0.025, end);
    lfo.connect(dep); v.play(lfo, t, end + 0.1);
    var types = ['sawtooth', 'triangle'];
    for (var i = 0; i < 2; i++) {
      var o = ctx.createOscillator(); o.type = types[i]; o.detune.value = i ? 9 : -9;
      o.frequency.setValueAtTime(f * 0.78, t); o.frequency.exponentialRampToValueAtTime(f * 1.26, t + len * 0.42);
      o.frequency.exponentialRampToValueAtTime(f * 0.86, end);
      dep.connect(o.frequency); o.connect(gc(v, i ? 0.6 : 1, src)); v.play(o, t, end + 0.05);
    }
  }

  function gulls(v, t, n, peak) {
    for (var c = 0; c < n; c++) {
      var tc = t + c * (0.26 + rnd() * 0.12), d = pn(v, -0.6 + 1.2 * rnd(), v.out), j = 0.9 + 0.25 * rnd(), len = 0.2 + 0.08 * rnd();
      var g = gn(v, filt(v, 'lowpass', 5500, 0.7, d));
      g.gain.setValueAtTime(0.0001, tc); g.gain.linearRampToValueAtTime(peak, tc + 0.025);
      g.gain.setValueAtTime(peak * 0.8, tc + len * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, tc + len);
      send(v, g, 0.6);
      var am = v.add(ctx.createGain()); am.gain.value = 0.6; am.connect(filt(v, 'highpass', 900, 0.7, filt(v, 'bandpass', 2500 * j, 2, g)));
      var fl = ctx.createOscillator(); fl.frequency.value = 55 + 20 * rnd(); fl.connect(gc(v, 0.4, am.gain)); v.play(fl, tc, tc + len + 0.05);
      var o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(1150 * j, tc); o.frequency.exponentialRampToValueAtTime(2300 * j, tc + 0.05);
      o.frequency.exponentialRampToValueAtTime(1450 * j, tc + len);
      o.connect(am); v.play(o, tc, tc + len + 0.05);
    }
  }

  function dolphin(v, dest, t, peak, hi) {
    var k = hi ? 1.25 : 1, g = gn(v, dest), len = 0.34;
    g.gain.setValueAtTime(0.0001, t + 0.06); g.gain.linearRampToValueAtTime(peak, t + 0.09);
    g.gain.setValueAtTime(peak, t + 0.06 + len * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + len);
    send(v, g, 0.5);
    var o = ctx.createOscillator();
    o.frequency.setValueAtTime(3000 * k, t + 0.06); o.frequency.exponentialRampToValueAtTime(7200 * k, t + 0.06 + len * 0.35);
    o.frequency.exponentialRampToValueAtTime(4600 * k, t + 0.06 + len);
    var lfo = ctx.createOscillator(); lfo.frequency.value = 17; lfo.connect(gc(v, 260 * k, o.frequency));
    o.connect(g); v.play(o, t + 0.06, t + 0.06 + len + 0.05); v.play(lfo, t + 0.06, t + 0.06 + len + 0.05);
    var tc = t, gap = 0.028;
    for (var c = 0; c < 9; c++) { tick(v, dest, tc, 4500 + 1500 * rnd(), 3, peak * 0.5 * (0.6 + 0.4 * rnd()), 0.003); tc += gap; gap *= 0.8; }
  }

  function conga(v, dest, t, f, peak, slap) {
    partial(v, dest, t, f, peak, slap ? 0.12 : 0.22, 0.002, 0, f * 1.18, 0.03);
    partial(v, dest, t, f * 1.52, peak * 0.3, 0.07, 0.002);
    tick(v, dest, t, slap ? 3200 : 1300, slap ? 1.2 : 0.9, peak * (slap ? 0.9 : 0.35), slap ? 0.02 : 0.012);
  }

  function card(v, dest, t, peak) {
    var g = gn(v, dest); envAD(g.gain, t, 0.002, peak, 0.035);
    noise(v, t, t + 0.06, filt(v, 'bandpass', 2600 + rnd() * 800, 0.7, g), pinkBuf);
    tick(v, dest, t + 0.012, 380, 1.2, peak * 0.8, 0.03);
  }

  function swish(v, dest, t, peak, dur, f0, f1) {
    var g = gn(v, dest);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + dur * 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var bp = filt(v, 'bandpass', f0, 1.1, g);
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    noise(v, t, t + dur + 0.05, bp, pinkBuf);
  }

  function bigSplash(v, t, peak, washToo) {
    if (!smp(v, pn(v, (rnd() - 0.5) * 0.4, v.out), t, rnd() < 0.5 ? 'splash1' : 'splash2', peak * 1.5, 0.88 + 0.24 * rnd()))
      if (!sample(v, v.out, t, spl(), peak, 0.85 + 0.2 * rnd())) splashSynth(v, t, peak * 0.6, 0.7);
    if (washToo) smp(v, v.out, t + 0.05, 'wave', peak * 0.9, 1.05, { offset: 4.2, dur: 3.2, fade: 1.6 }) || sample(v, v.out, t + 0.05, OCEAN.wash, peak * 0.7, 1, { offset: 0.45 });
  }



  function lpBase() { return Math.min(LP_OPEN, ctx ? ctx.sampleRate * 0.45 : LP_OPEN); }
  function applyDuck(on) {
    var now = ctx.currentTime, g = N.duck.gain, f = N.musicLP.frequency;
    holdAt(g, now); holdAt(f, now);
    if (on) {
      g.linearRampToValueAtTime(0.45, now + 0.08);
      f.exponentialRampToValueAtTime(LP_DUCK, now + 0.35);
    } else {
      g.linearRampToValueAtTime(1, now + 0.6);
      f.exponentialRampToValueAtTime(lpBase(), now + 0.8);
    }
  }
  function acquireDuck() {
    duckCount++;
    if (duckCount === 1) applyDuck(true);
    var released = false;
    return function () {
      if (released || !ctx) return;
      released = true;
      duckCount = Math.max(0, duckCount - 1);
      if (duckCount === 0) applyDuck(false);
    };
  }
  function duckFor(sec) { var rel = acquireDuck(); setTimeout(rel, sec * 1000); }
  function lpTo(when) {
    if (duckCount > 0) return;
    var f = N.musicLP.frequency;
    holdAt(f, when);
    f.exponentialRampToValueAtTime(lpBase(), when + 0.5);
  }


  var MUSIC = { url: 'audio/surf-theme-v2', rate: 48000, pad: 24000, len: 4109664, prime: { m4a: 1024, webm: 312 },
                beats: { b0: 0.00325, p: 0.5378486, c: -1.74927e-5, n: 160 } };
  var BEAT = MUSIC.len / MUSIC.rate / MUSIC.beats.n;
  var S16 = BEAT / 4, S32 = BEAT / 8, S16T = BEAT / 6, S32T = BEAT / 12;
  var BONUS_LIFT = 1.26;
  var mus = { fmts: null, bytes: null, decoding: null, buf: null, fmt: '', off: 0, loopStart: 0, loopEnd: 0,
              src: null, srcGain: null, startedAt: 0, startPos: 0, pos: 0, fetched: false, err: '' };

  function musicFormats() {
    var a = null, cp = function (type) { try { return a && a.canPlayType ? a.canPlayType(type) : ''; } catch (e) { return ''; } };
    try { a = root.document.createElement('audio'); } catch (e) {  }
    var aac = cp('audio/mp4; codecs="mp4a.40.2"'), opus = cp('audio/webm; codecs="opus"');
    var apple = /Apple/.test((root.navigator && root.navigator.vendor) || '');
    var list = [];
    if (opus === 'probably' && !apple) list.push('webm');
    list.push('m4a');
    if (opus && list[0] !== 'webm') list.push('webm');
    return list;
  }

  function musicBytes(i) {
    if (!mus.fmts) mus.fmts = musicFormats();
    var f = mus.fmts[i];
    if (!f) return Promise.reject(new Error('music: no format loaded'));
    if (!root.fetch) return Promise.reject(new Error('music: no fetch'));
    return root.fetch(MUSIC.url + '.' + f, { priority: 'low', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('music: HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) { mus.fetched = true; return { i: i, fmt: f, ab: ab }; },
            function () { return musicBytes(i + 1); });
  }
  function fetchMusic() {
    if (!mus.bytes) {
      mus.bytes = musicBytes(0);
      mus.bytes.catch(function (e) { mus.err = String(e && e.message || e); mus.bytes = null; });
    }
    return mus.bytes;
  }
  function decodeBuf(ab) {
    return new Promise(function (res, rej) {
      var p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }
  function setLoop(buf, fmt) {
    var k = buf.sampleRate / MUSIC.rate;
    var extra = buf.length / k - (MUSIC.len + 2 * MUSIC.pad), prime = MUSIC.prime[fmt] || 0;

    mus.off = prime && extra >= prime - 4 ? prime : 0;
    mus.buf = buf; mus.fmt = fmt;
    mus.loopStart = (MUSIC.pad + mus.off) / MUSIC.rate;
    mus.loopEnd = mus.loopStart + MUSIC.len / MUSIC.rate;
  }
  function decodeMusic() {
    if (mus.buf) return Promise.resolve(mus.buf);
    if (mus.decoding) return mus.decoding;
    function attempt(p) {
      return p.then(function (b) {
        return decodeBuf(b.ab).then(function (buf) { setLoop(buf, b.fmt); mus.bytes = null; return buf; }, function (e) {
          if (b.i + 1 < mus.fmts.length) { mus.bytes = musicBytes(b.i + 1); return attempt(mus.bytes); }
          throw e;
        });
      });
    }
    mus.decoding = attempt(fetchMusic());
    mus.decoding.catch(function (e) {
      mus.decoding = null; mus.bytes = null; mus.err = String(e && e.message || e);
      if (root.console) root.console.warn('[MangoAudio] music did not load', e);
    });
    return mus.decoding;
  }

  function prefetchSoon() {
    setTimeout(function () {
      var get = function () { fetchMusic().catch(noop); };
      if (root.requestIdleCallback) root.requestIdleCallback(get, { timeout: 2000 }); else get();
    }, 2500);
  }
  (function () {
    if (!root.addEventListener || !AC) return;
    var once = false, go = function () { if (!once) { once = true; prefetchSoon(); } };
    root.addEventListener('mango:shown', go);

    var noLoader = function () {
      var L = root.MangoLoader, st = null;
      try { st = L && L.state && L.state(); } catch (e) {  }
      if (!L || (st && st.gone)) go();
    };
    if (root.document && root.document.readyState === 'complete') noLoader();
    else root.addEventListener('load', noLoader);
  })();

  function loopLen() { return mus.loopEnd - mus.loopStart; }
  function playLoop(at, fadeIn) {
    var s = ctx.createBufferSource();
    s.buffer = mus.buf; s.loop = true; s.loopStart = mus.loopStart; s.loopEnd = mus.loopEnd;
    var g = ctx.createGain(); g.gain.value = 0.0001;
    s.connect(g); g.connect(N.musicMode);
    var pos = mus.pos % loopLen();
    s.start(at, mus.loopStart + pos);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(1, at + Math.max(fadeIn, 0.01));
    mus.src = s; mus.srcGain = g; mus.startedAt = at; mus.startPos = pos;
  }
  function stopLoop(fade) {
    if (!mus.src) return;
    var s = mus.src, g = mus.srcGain, t = ctx.currentTime;
    mus.pos = (mus.startPos + Math.max(0, t - mus.startedAt)) % loopLen();
    mus.src = null; mus.srcGain = null;
    holdAt(g.gain, t);
    g.gain.linearRampToValueAtTime(0.0001, t + fade);
    s.onended = function () { try { s.disconnect(); g.disconnect(); } catch (e) {  } };
    try { s.stop(t + fade + 0.02); } catch (e) {  }
  }

  function beatIndex(pos) {
    var B = MUSIC.beats, a = B.b0 - pos;
    return Math.abs(B.c) < 1e-12 ? -a / B.p : (-B.p + Math.sqrt(B.p * B.p - 4 * B.c * a)) / (2 * B.c);
  }
  function beatPos(k) { var B = MUSIC.beats; return B.b0 + B.p * k + B.c * k * k; }
  function grid(t, div, maxWait) {
    if (!mus.src || !mus.buf || t < mus.startedAt) return t;
    var L = loopLen(), n = MUSIC.beats.n;
    var pos = ((mus.startPos + t - mus.startedAt) % L + L) % L;
    var k = beatIndex(pos), kn = Math.ceil(k * div - 1e-6) / div;
    var dt = kn >= n ? (L - pos) + beatPos(kn - n) : beatPos(kn) - pos;
    return dt >= 0 && dt <= (maxWait == null ? 1 / div * BEAT + 0.01 : maxWait) ? t + dt : t;
  }

  function beatLen(t) {
    if (!mus.src || !mus.buf || t < mus.startedAt) return BEAT;
    var L = loopLen(), pos = ((mus.startPos + t - mus.startedAt) % L + L) % L, k = beatIndex(pos), B = MUSIC.beats;
    return B.p + 2 * B.c * Math.min(k, B.n);
  }


  function modeLevel() { return curMode === 'bonus' ? BONUS_LIFT : 1; }
  function modeTo(at, level, ramp) {
    var g = N.musicMode.gain;
    holdAt(g, at);
    g.linearRampToValueAtTime(level, at + Math.max(ramp, 0.01));
  }


  // unlock(): only makes (or resumes) the audio context, inside the player's gesture, so the browser lets it run. The heavy
  // part (node graph, noise and reverb buffers, the ocean renders) waits for init(), which the game calls when it is idle,
  // so the first spin is not held up by it (2026-10-19, sound on by default).
  var pendingCtx = null, yieldFn = null;
  function unlock() {
    if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(noop); return true; }
    if (!AC) return false;
    if (!pendingCtx) pendingCtx = new AC();
    if (pendingCtx.state === 'suspended' && pendingCtx.resume) pendingCtx.resume().catch(noop);
    return true;
  }
  // background preparation (string warm-up, ocean renders, the sample kit) pauses while yieldFn() is true (a round in play)
  function setYield(fn) { yieldFn = typeof fn === 'function' ? fn : null; }
  function held() { try { return !!(yieldFn && yieldFn()); } catch (e) { return false; } }

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(noop);
      return true;
    }
    if (!AC) return false;
    ctx = pendingCtx || new AC(); pendingCtx = null;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(noop);

    N.master = ctx.createGain(); N.master.gain.value = muted ? 0.0001 : MASTER; N.master.connect(ctx.destination);
    N.comp = ctx.createDynamicsCompressor();
    N.comp.threshold.value = -12; N.comp.knee.value = 12; N.comp.ratio.value = 3;
    N.comp.attack.value = 0.004; N.comp.release.value = 0.25;
    N.comp.connect(N.master);
    N.musicVol = ctx.createGain(); N.musicVol.gain.value = musicVolume * MUSIC_LEVEL; N.musicVol.connect(N.comp);
    N.musicLP = ctx.createBiquadFilter(); N.musicLP.type = 'lowpass'; N.musicLP.frequency.value = lpBase(); N.musicLP.Q.value = 0.5;
    N.musicLP.connect(N.musicVol);
    N.duck = ctx.createGain(); N.duck.gain.value = 1; N.duck.connect(N.musicLP);
    N.musicBus = ctx.createGain(); N.musicBus.gain.value = 1; N.musicBus.connect(N.duck);
    N.musicMode = ctx.createGain(); N.musicMode.gain.value = modeLevel(); N.musicMode.connect(N.musicBus);
    N.sfxVol = ctx.createGain(); N.sfxVol.gain.value = sfxVolume; N.sfxVol.connect(N.comp);
    N.sfxBus = ctx.createGain(); N.sfxBus.gain.value = 1; N.sfxBus.connect(N.sfxVol);
    N.sfxVerb = ctx.createGain(); N.sfxVerb.gain.value = 1;
    var vhp = ctx.createBiquadFilter(); vhp.type = "highpass"; vhp.frequency.value = 220; vhp.Q.value = 0.7;
    var conv = ctx.createConvolver(); conv.buffer = makeIR(1.7);
    var vout = ctx.createGain(); vout.gain.value = 0.55;
    N.sfxVerb.connect(vhp); vhp.connect(conv); conv.connect(vout); vout.connect(N.sfxBus);
    N.caveVerb = ctx.createGain(); N.caveVerb.gain.value = 1;
    var chp = ctx.createBiquadFilter(); chp.type = "highpass"; chp.frequency.value = 140; chp.Q.value = 0.7;
    var cave = ctx.createConvolver(); cave.buffer = makeIR(3.4, true);
    var cout = ctx.createGain(); cout.gain.value = 0.5;
    N.caveVerb.connect(chp); chp.connect(cave); cave.connect(cout); cout.connect(N.sfxBus);

    var len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    curveSoft = makeCurve(1.1);
    curveHard = makeCurve(4);
    pinkBuf = makeNoise("pink", 3); brownBuf = makeNoise("brown", 3); crackBuf = makeNoise("crackle", 3);
    setTimeout(warmStrings, 400);
    setTimeout(renderOcean, 60);
    setTimeout(loadKit, 1200);
    setTimeout(ambience, 4000);
    return true;
  }

  function startMusic() {
    if (!ctx || musicOn) return;
    musicOn = true;
    if (mus.buf) { if (!mus.src) playLoop(tNow(0.06), 0.25); return; }
    var asked = ctx.currentTime;
    decodeMusic().then(function () {
      if (!musicOn || mus.src || !ctx) return;
      playLoop(tNow(0.03), ctx.currentTime - asked > 0.5 ? 1.2 : 0.25);
    }, noop);
  }

  function stopMusic() {
    if (!ctx || !musicOn) return;
    musicOn = false;
    stopLoop(0.4);
  }

  function setMode(mode) {
    if (mode !== 'base' && mode !== 'bonus') return;
    curMode = mode;
    if (!ctx) return;
    var t = tNow(0.03);
    modeTo(t, modeLevel(), 0.6);
    lpTo(t);
  }

  function stopAntic(fade) {
    if (!antic) return;
    var a = antic; antic = null;
    clearTimeout(a.timer); clearInterval(a.pump);
    if (a.rel) { a.rel(); a.rel = null; }
    if (a.v.done) return;
    var now = ctx.currentTime;
    holdAt(a.grp.gain, now);
    a.grp.gain.linearRampToValueAtTime(0.0001, now + fade);
    for (var i = 0; i < a.v.sources.length; i++) {
      try { a.v.sources[i].stop(now + fade + 0.02); } catch (e) {  }
    }
  }

  function setMuted(b) {
    muted = !!b;
    if (!ctx) return;
    if (muted) stopAntic(0.05);
    var g = N.master.gain, now = ctx.currentTime;
    holdAt(g, now);
    g.linearRampToValueAtTime(muted ? 0.0001 : MASTER, now + 0.05);
  }
  function setMusicVolume(v) {
    musicVolume = clamp(v, 0, 1);
    if (ctx) N.musicVol.gain.setTargetAtTime(musicVolume * MUSIC_LEVEL, ctx.currentTime, 0.05);
  }
  function setSfxVolume(v) {
    sfxVolume = clamp(v, 0, 1);
    if (ctx) N.sfxVol.gain.setTargetAtTime(sfxVolume, ctx.currentTime, 0.03);
  }
  function isReady() { return !!ctx && ctx.state === 'running'; }


  function ambience() {
    try {
      if (ok() && sfxVolume > 0.01 && SB.surf && !antic) {
        var v = sfxVoice(), t = tNow(0.05), len = 9 + rnd() * 6, off = rnd() * (SB.surf.duration - len - 1);
        var g = smp(v, pn(v, rnd() * 0.8 - 0.4, v.out), t, 'surf', 0.0001, 1, { offset: off, dur: len, lp: 3200 });
        if (g) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 2.5); g.gain.setValueAtTime(0.07, t + len - 2.5); g.gain.linearRampToValueAtTime(0.0001, t + len); }
        if (rnd() < 0.3) smp(v, pn(v, rnd() * 1.4 - 0.7, v.out), t + 1 + rnd() * 4, rnd() < 0.5 ? 'gull' : 'gulls', 0.035, 0.9 + rnd() * 0.25, { lp: 5000, dur: 3, fade: 1 });
        setTimeout(ambience, (len - 2.5) * 1000);
        return;
      }
    } catch (e) {}
    setTimeout(ambience, 3000);
  }


  function later(fn) { setTimeout(function () { if (ok()) { try { fn(); } catch (e) { if (root.console) root.console.warn('[MangoAudio]', e); } } }, 0); }


  var LADDER = [55, 59, 62, 67, 71, 74, 79, 83, 86, 91, 95];
  function arp(t, startIdx, count, step, peak, holdLast) {
    var v = sfxVoice(), last = LADDER[0], bus = gc(v, 1, v.out);
    send(v, bus, 0.22);
    for (var k = 0; k < count; k++) {
      var idx = Math.min(startIdx + k, LADDER.length - 1), isLast = (k === count - 1), tk = t + k * step + (k ? (rnd() - 0.5) * 0.004 : 0);
      var d = pn(v, -0.4 + 0.8 * (count > 1 ? k / (count - 1) : 0.5), bus), pk = (isLast ? peak : peak * 0.8) * (0.85 + 0.25 * rnd());
      last = LADDER[idx];
      if (!mar(v, d, tk, last, pk * 1.6)) drop(v, d, tk, mf(last), pk * 0.8);
      if (isLast) mar(v, d, tk + 0.012, last + 12, pk * 0.5);
    }
    return { tEnd: t + (count - 1) * step, lastMidi: last };
  }

  function spinStart() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(), j = 0.92 + 0.16 * rnd(), d = pn(v, -0.5, v.out);
    if (d.pan) { d.pan.setValueAtTime(-0.55, t); d.pan.linearRampToValueAtTime(0.55, t + 0.6); }
    if (!smp(v, d, t, 'swish', 0.4, j)) { whoosh(v, v.out, t, 0.14, 0.42, { from: -0.6, to: 0.6, f0: 600 * j, f1: 2600 * j }); return; }
    smp(v, d, t + 0.06, 'rain', 0.16, 1.15 + 0.1 * rnd(), { dur: 0.7, fade: 0.45 });
  }

  var PLOP = [62, 64, 67, 69, 71];
  var PANS = [-0.5, -0.25, 0, 0.25, 0.5];
  function reelStop(i) {
    if (!ok()) return;
    i = Math.round(clamp(i, 0, 4));
    var v = sfxVoice(), t = tNow(), vel = 0.85 + 0.25 * rnd(), last = i === 4;
    var d = pn(v, PANS[i] + (rnd() - 0.5) * 0.08, v.out);
    if (!smp(v, d, t, 'bamboo', 0.46 * vel, Math.pow(2, (PLOP[i] + 24 - 91 + (rnd() - 0.5) * 0.12) / 12))) { woodKnock(v, d, t, mf(PLOP[i]) / 2, 0.11 * vel); }
    smp(v, d, t, 'conga', 0.13 * vel, 0.62 + 0.04 * i, { dur: 0.3, fade: 0.15 });
    if (last) smp(v, d, t + 0.01, 'splash2', 0.12 * vel, 1.25 + 0.2 * rnd(), { dur: 0.6, fade: 0.4 });
  }

  var SCATTER = [74, 76, 79, 83, 86];
  function scatterLand(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 1, 5));
    if (n < 2) return;
    var v = sfxVoice(), t = tNow(), d = pn(v, (rnd() - 0.5) * 0.3, v.out);
    send(v, d, 0.3);
    smp(v, d, t, 'bongo', 0.3, 0.95 + 0.06 * n);
    smp(v, d, t + BEAT / 8, 'conga', 0.24, 0.9 + 0.05 * n, { dur: 0.5, fade: 0.25 });
    mar(v, d, t, SCATTER[n - 1], 0.5);
    uk(v, d, t + 0.01, [-5, 0, 2, 7, 7][n - 1], 0.32 + 0.04 * n);
    smp(v, d, t, 'shake', 0.18, 1);
    if (n >= 3) { conch(v, pn(v, -0.15, v.out), t + 0.05, 55, 0.7, 0.1); bigSplash(v, t, 0.16, false); }
  }
  var LEG = [67, 71, 74, 79, 83];
  function legendLand(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 1, 5));
    var v = sfxVoice(), t = tNow(), f = mf(LEG[n - 1]), d = pn(v, (rnd() - 0.5) * 0.3, v.out);
    send(v, d, 0.4);
    partial(v, d, t, mf(31 + n), 0.3, 0.3, 0.004, 0, mf(43 + n), 0.08);
    conga(v, d, t, 140, 0.24, false);
    conch(v, d, t + 0.02, 43 + n, 0.6, 0.09);
    drop(v, d, t, f, 0.16);
    impact(v, t, 0.16 + 0.03 * n);
    if (n >= 2) whale(v, v.out, t + 0.1, mf(36 + n), 1.6, 0.06 + 0.01 * n);
  }


  function anticipation(on) {
    if (!on) { if (ctx) stopAntic(0.25); return; }
    if (!ok() || antic) return;
    var v = sfxVoice(), t = tNow(), MAX = 12, end = t + MAX;
    var t1 = grid(t, 4), step = beatLen(t1) / 2;
    var grp = gc(v, 1, v.out), rel = acquireDuck();
    holdAt(N.musicLP.frequency, t); N.musicLP.frequency.exponentialRampToValueAtTime(1600, t + 0.5);
    send(v, grp, 0.25);

    var wf = filt(v, 'lowpass', 400, 0.7, grp), wg = smp(v, wf, t, 'wave', 0.0001, 1, { dur: MAX });
    if (wg) { wg.gain.setValueAtTime(0.0001, t); wg.gain.linearRampToValueAtTime(0.5, t + 7); wf.frequency.setValueAtTime(400, t); wf.frequency.exponentialRampToValueAtTime(5000, t + 9); }
    else { var ng = gn(v, grp); ng.gain.setValueAtTime(0.0001, t); ng.gain.linearRampToValueAtTime(0.1, t + 8); noise(v, t, end, filt(v, 'lowpass', 600, 0.9, ng), pinkBuf); }
    var L = pn(v, -0.35, grp), R = pn(v, 0.4, grp), i = 0, tp = t1;
    function sched(until) {
      while (tp < until && tp < end - 0.05) {
        var onBeat = i % 2 === 0, prog = Math.min(1, (tp - t) / 5), vg = 0.6 + 0.4 * prog;
        if (onBeat) smp(v, L, tp, 'conga', 0.42 * vg, 0.55, { dur: 0.45, fade: 0.2 });
        else smp(v, L, tp, 'bongo', 0.2 * vg, 1.0 + (i % 4 === 3 ? 0.12 : 0), { dur: 0.4, fade: 0.2 });
        if (prog > 0.45 && tp + step / 2 < end - 0.05) smp(v, L, tp + step / 2, 'bongo', 0.12 + 0.1 * prog, 1.18, { dur: 0.3, fade: 0.15 });
        smp(v, R, tp, 'shake', (onBeat ? 0.2 : 0.13) * vg, 0.95 + 0.1 * rnd());
        if (tp + step / 2 < end - 0.05) smp(v, R, tp + step / 2, 'shake', 0.1 * vg, 1.05);
        if (i % 4 === 0) mar(v, L, tp, i % 8 === 0 ? 66 : 72, 0.16 + 0.12 * prog);
        tp += step; i++;
      }
    }
    sched(t + 0.3);
    var pump = setInterval(function () { try { if (antic && antic.v === v) sched(ctx.currentTime + 0.3); else clearInterval(pump); } catch (e) { clearInterval(pump); } }, 60);
    grp.gain.setValueAtTime(1, end - 0.3); grp.gain.exponentialRampToValueAtTime(0.0001, end);
    antic = { v: v, grp: grp, rel: rel, pump: pump, timer: setTimeout(function () { stopAntic(0.3); }, MAX * 1000) };
  }

  var WILD = [55, 57, 59, 62, 64, 67, 69, 71, 74, 76];
  function wildLand(mult) {
    if (!ok()) return;
    var p = clamp(log2(Math.max(1, +mult || 1)), 0, 7);
    var v = sfxVoice(), t = tNow(), d = pn(v, (rnd() - 0.5) * 0.3, v.out);
    send(v, d, 0.15);
    if (!smp(v, d, t, rnd() < 0.5 ? 'splash1' : 'splash2', 0.34 + 0.02 * Math.min(p, 4), 0.95 + 0.15 * rnd(), { dur: 0.8, fade: 0.5, lp: 6000 })) bigSplash(v, t, 0.08, false);
    smp(v, d, t, 'conga', 0.14, 0.95, { dur: 0.35, fade: 0.2 });
    if (p >= 2) uk(v, d, t + 0.06, 7, 0.16 + 0.015 * Math.min(p, 5), 0.9);
  }

  var STACK = [62, 67, 71, 74, 79];
  var lastStack = { k: -1, t: 0 };
  function stackStep(k) {
    if (!ok()) return;
    k = Math.round(clamp(k, 0, 4));
    var now0 = ctx.currentTime; if (k === lastStack.k && now0 - lastStack.t < 0.09) return;
    lastStack.k = k; lastStack.t = now0;
    var v = sfxVoice(), t = tNow(), d = pn(v, -0.2 + 0.1 * k, v.out);
    smp(v, d, t, 'splash2', 0.24 + 0.02 * k, 1.25 + 0.07 * k, { dur: 0.3, fade: 0.22, hp: 400 }) || drop(v, d, t, mf(STACK[k]), 0.1);
    smp(v, d, t, 'shake', 0.12, 1 + 0.04 * k);
  }
  var lastExpand = -9;
  function wildExpand(M) {
    if (!ok()) return;
    var p = clamp(log2(Math.max(1, +M || 1)), 0, 6), v = sfxVoice(), t = tNow();
    var crowd = t - lastExpand < 0.45; lastExpand = t;
    send(v, v.out, 0.15);
    if (crowd) { smp(v, pn(v, 0.3, v.out), t, 'splash2', 0.14, 0.9, { dur: 0.8, fade: 0.5, lp: 5000 }); return; }
    var wg = smp(v, v.out, t, 'wave', 0.0001, 1, { offset: 3.6, dur: 3, fade: 1.6, lp: 7000 });
    if (wg) { wg.gain.setValueAtTime(0.0001, t); wg.gain.linearRampToValueAtTime(0.3 + 0.03 * p, t + 0.35); }
    else bigSplash(v, t + 0.2, 0.12, true);
    smp(v, pn(v, -0.2, v.out), t + 0.3, 'splash1', 0.16, 0.85, { dur: 1, fade: 0.6, lp: 5000 });
    uk(v, v.out, t + 0.32, p >= 3 ? 7 : -5, 0.2 + 0.02 * p, 1.4);
    if (p >= 4) smp(v, pn(v, 0.4, v.out), t + 0.6, 'gull', 0.05, 1, { dur: 1.5, fade: 0.6 });
  }

  function win(x) {
    if (!ok()) return;
    x = +x;
    if (!(x > 0) || !isFinite(x)) return;
    if (x < 1) { neutralTick(); return; }
    var s = log10(x), t = grid(tNow(), 8), bl = beatLen(t);
    if (x < 5) { arp(t, 2, 3 + Math.floor(s * 3), bl / 6, 0.26, 0.25 + 0.35 * s); return; }
    if (x < 20) {
      var a = arp(t, 2 + Math.floor(s), Math.min(7, 5 + Math.floor((s - 0.7) * 5)), bl / 8, 0.24, 0.5);
      var v = sfxVoice();
      send(v, v.out, 0.25);
      if (!uk(v, v.out, a.tEnd, 7, 0.55)) strum(v, ukeBody(v, v.out), a.tEnd, UKE.G, 0.28 + 0.05 * s);
      smp(v, v.out, a.tEnd, 'shaker', 0.16, 1);
      bigSplash(v, a.tEnd, 0.08, false);
      sub(v, a.tEnd, 31, 0.06, 0.5 + 0.2 * s);
      return;
    }
    bigWin(s, t);
  }
  function bigWin(s, t) {
    var L = Math.min(3.2, 1.4 + 0.55 * (s - 1.3)), st = beatLen(t) / 8, h = t + 2 * st;
    var v = sfxVoice();
    duckFor(L + 0.6);
    send(v, v.out, 0.25);
    impact(v, h, 0.26);
    sub(v, h, 31, 0.14, L * 0.6);
    bigSplash(v, h, 0.22, true);
    var n = Math.max(2, Math.round(L * 0.55 / (st * 2)));
    for (var k = 0; k < n; k++) uk(v, pn(v, k % 2 ? 0.2 : -0.2, v.out), h + k * st * 2, 7, (k % 2 ? 0.32 : 0.45) * (0.75 + 0.25 * k / n), k < n - 1 ? st * 2.4 : 0);
    later(function () {
      var start = Math.min(2 + Math.floor(s - 1.3), 4), cnt = Math.min(LADDER.length - start, 5 + Math.round(s * 1.5));
      var vd = sfxVoice(); send(vd, vd.out, 0.2);
      for (var q = 0; q < cnt; q++) mar(vd, pn(vd, -0.5 + q / cnt, vd.out), h + q * st, LADDER[start + q], 0.42);
      var tf = h + cnt * st;
      smp(vd, vd.out, h, 'shaker', 0.2, 1);
      if (s >= 1.6) smp(vd, pn(vd, 0.4, vd.out), h + 0.3, 'gulls', 0.12, 1, { dur: 3, fade: 1.2 });
      if (s >= 2) {
        var v2 = sfxVoice(); send(v2, v2.out, 0.25);
        for (var k2 = 0; k2 < 4; k2++) uk(v2, v2.out, tf + k2 * st * 2, 7, k2 % 2 ? 0.3 : 0.42, k2 < 3 ? st * 2.4 : 0);
        smp(v2, v2.out, tf, 'wave', 0.5, 1, { offset: 4, dur: 4, fade: 2 });
        if (s >= 2.5) conch(v2, pn(v2, -0.2, v2.out), tf + 0.05, 55, 1.3, 0.1);
      }
    });
  }

  var TICKS = [67, 69, 71, 74, 76, 79, 81, 83, 86, 88, 91, 93, 95];
  function coinTick(dest, t, midi, peak, accent, k) {
    var v = newVoice('sfx', dest), d = pn(v, k % 2 ? 0.25 : -0.25, v.out);
    if (!mar(v, d, t, midi, peak * 1.25)) drop(v, d, t, mf(midi), peak * 0.8);
    if (accent) smp(v, d, t, 'shake', peak * 0.9, 1.05);
  }
  function resolveChord(t, x) {
    var v = sfxVoice(), ns = [67, 71, 74, 79];
    send(v, v.out, 0.3);
    if (!uk(v, v.out, t, 7, 0.6)) strum(v, ukeBody(v, v.out), t, UKE.G, 0.26);
    for (var i = 0; i < ns.length; i++) mar(v, pn(v, -0.3 + 0.2 * i, v.out), t + i * 0.025, ns[i], 0.3);
    smp(v, v.out, t, 'shaker', 0.15, 1);
    if (x >= 5) { bigSplash(v, t, 0.1, false); sub(v, t, 31, 0.06, 0.9); }
    if (x >= 20) impact(v, t, 0.16);
  }
  function countUp(durationMs, x) {
    if (!ok()) return noop;
    var D = clamp((+durationMs || 0) / 1000, 0.2, 30);
    x = +x || 0;
    var s = x > 1 ? Math.min(log10(x), 3) : 0;

    var t0 = grid(tNow(0.03), 8), end = t0 + D, next = t0, done = false, n = 0, m = 0, fast = false;
    var bl = beatLen(t0), i0 = Math.round(s * 2);
    var grp = ctx.createGain(); grp.gain.value = 1; grp.connect(N.sfxBus);
    var releaseDuck = acquireDuck(), timer = null;

    var bed = sfxVoice(), bg = sample(bed, filt(bed, 'highpass', 250, 0.7, bed.out), t0, OCEAN.stream, 0.0001, 1.2, { loop: true, dur: D + 0.2 });
    if (bg) { bg.gain.setValueAtTime(0.0001, t0); bg.gain.exponentialRampToValueAtTime(0.18 + 0.05 * s, end); bg.gain.exponentialRampToValueAtTime(0.0001, end + 0.2); }
    function finish(at, chord) {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (chord && !muted) resolveChord(at, x);
      if (bg) { try { holdAt(bg.gain, ctx.currentTime); bg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15); } catch (e) {} }
      var ms = Math.max(0, (at - ctx.currentTime) * 1000) + 300;
      setTimeout(function () { releaseDuck(); try { grp.disconnect(); } catch (e) {  } }, ms);
    }
    function pump() {
      if (done) return;
      try {
        var lim = ctx.currentTime + 0.1;
        while (next < lim && next < end) {
          var p = (next - t0) / D;
          var idx = Math.min(TICKS.length - 1, i0 + Math.floor(p * 7.99));
          if (!fast && p >= 0.65 && m % 4 === 0) { fast = true; m = 0; }
          if (!muted) coinTick(grp, next, TICKS[idx], 0.13 + 0.03 * p, m % (fast ? 3 : 4) === 0, n);
          n++; m++;
          next += bl / (fast ? 12 : 8);
        }
        if (next >= end) finish(grid(end, 8), true);
      } catch (e) { done = true; clearInterval(timer); releaseDuck(); }
    }
    timer = setInterval(pump, TICK_MS);
    pump();
    return function stop(playFinal) {
      if (done || !ctx) return;
      var t = ctx.currentTime;
      holdAt(grp.gain, t);
      grp.gain.linearRampToValueAtTime(0.0001, t + 0.03);
      finish(t + 0.03, playFinal !== false);
    };
  }


  var TIERCH = ['G', 'C', 'D', 'Em', 'G8', 'D7', 'G8'];
  function tierUp(i) {
    if (!ok()) return;
    i = Math.round(clamp(i, 0, 6));
    var v = sfxVoice(), t = grid(tNow(), 8), semis = [-5, 0, 2, 4, 7, 9, 7][i], root = [55, 60, 62, 64, 67, 69, 72][i];
    send(v, v.out, 0.28);
    impact(v, t, 0.18 + 0.02 * i);
    if (!uk(v, v.out, t, semis, 0.55 + 0.03 * i)) strum(v, ukeBody(v, v.out), t, UKE[TIERCH[i]], 0.36);
    uk(v, v.out, t + beatLen(t) / 4, semis - 12, 0.3, beatLen(t) / 4);
    mar(v, pn(v, -0.2, v.out), t, root + 12, 0.45);
    smp(v, pn(v, 0.25, v.out), t, 'conga', 0.32, 0.8 + 0.05 * i, { dur: 0.6, fade: 0.3 });
    sub(v, t, root - 24, 0.08, 0.5);
    later(function () {
      var w = sfxVoice(); send(w, w.out, 0.25);
      if (i >= 1) bigSplash(w, t, 0.08 + 0.02 * i, i >= 3);
      if (i >= 3) smp(w, pn(w, rnd() - 0.5, w.out), t + 0.1, 'gulls', 0.1, 1, { dur: 2.5, fade: 1 });
      if (i >= 5) conch(w, pn(w, 0.15, w.out), t + 0.05, root - 5, 0.9, 0.08);
    });
  }

  function bonusTrigger(tier) {
    if (!ok()) return;
    tier = tier == null ? 1 : Math.round(clamp(tier, 0, 2));
    var t = tNow(0.02), h = grid(t + 1.15, 1, BEAT + 0.01), T = h > t + 1.15 ? h - t : 1.25, v = sfxVoice();
    h = t + T;
    var st = beatLen(h) / 8;
    riser(v, v.out, t, T, 0.16);
    sample(v, v.out, t, OCEAN.wash, 0.0001, 0.6, { dur: T + 0.1, lp: 1800 });
    for (var s = -1; s <= 1; s += 2) {
      var rg = gn(v, pn(v, s * 0.5, v.out));
      rg.gain.setValueAtTime(0.0001, t); rg.gain.linearRampToValueAtTime(0.16, h); rg.gain.linearRampToValueAtTime(0.0001, h + 0.06);
      var lp = filt(v, 'lowpass', 300, 0.9, rg); lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(3500, h);
      noise(v, t, h + 0.1, lp, pinkBuf);
    }
    if (tier === 0) {
      var cs = beatLen(t) / 4, nk = Math.floor((T - 0.05) / cs);
      for (var ck = 0; ck < nk; ck++) conga(v, pn(v, ck % 2 ? 0.35 : -0.35, v.out), h - (nk - ck) * cs, [196, 247, 294, 247][ck % 4], 0.08 + 0.18 * ck / nk, ck % 4 === 2);
    } else {
      conch(v, pn(v, -0.2, v.out), t + 0.04, 55, T - 0.3, 0.15);
      conch(v, pn(v, 0.25, v.out), t + 0.32, 62, Math.max(0.5, T - 0.58), 0.08);
      if (tier === 2) conch(v, v.out, t + 0.55, 67, Math.max(0.4, T - 0.8), 0.07);
    }
    var gv = gc(v, 1, v.out), body = ukeBody(v, pn(v, 0.15, gv));
    send(v, gv, 0.5);
    var run = [62, 64, 67, 69, 71, 74, 76, 79];
    for (var k = 0; k < run.length; k++) uke(v, body, h - (run.length - k) * st, run[k], 0.2 + 0.015 * k, { len: st * 1.4, vi: k % 3 });

    impact(v, h, 0.45);
    waveCrash(v, h, 0.26, 2.4);
    later(function () {
    var sv = sfxVoice(), sb = ukeBody(sv, sv.out);
    send(sv, sv.out, 0.4);
    bigSplash(sv, h, 0.34, true);
    tremoloStrum(sv, sb, h, UKE.G, beatLen(h) * 1.5, 0.32, beatLen(h) / 4);
    sub(sv, h, 31, 0.2, 1.3);
    glitter(sv, h + 0.05, 1.4, 0.06);
    if (tier === 0) for (var cr = 0; cr < 4; cr++) conga(sv, sv.out, h + cr * beatLen(h) / 4, [294, 247, 196, 147][cr], 0.22, cr === 0);
    if (tier >= 1) gulls(sv, h + 0.2, 3, 0.06);
    if (tier === 2) { whale(sv, sv.out, h + 0.1, mf(38), 2.6, 0.1); waveCrash(sfxVoice(), h + 0.3, 0.16, 2.6); }
    });
    curMode = 'bonus';
    modeTo(t, 0.35, T);
    modeTo(h, BONUS_LIFT, 0.9);
  }
  function freeSpin(i, N) {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(), left = Math.max(0, (N || 10) - (i || 0) - 1);
    if (!smp(v, pn(v, 0.3, v.out), t, 'swish', 0.38, 1.12)) whoosh(v, v.out, t, 0.16, 0.36, { from: 0.5, to: -0.5, f0: 800, f1: 3200 });
    mar(v, v.out, t + 0.02, LADDER[Math.min(LADDER.length - 1, 3 + Math.min(left, 6))], 0.22);
    if (left === 0) for (var cr = 0; cr < 6; cr++) smp(v, pn(v, cr % 2 ? 0.3 : -0.3, v.out), t + 0.05 + cr * BEAT / 8, cr % 2 ? 'bongo' : 'conga', 0.18 + 0.04 * cr, cr % 2 ? 1.05 : 0.8, { dur: 0.35, fade: 0.15 });
  }
  function bonusSpinWin(x) {
    if (!ok()) return;
    x = +x;
    if (!(x > 0) || !isFinite(x)) return;
    if (x < 1) { neutralTick(); return; }
    var s = log10(x), t = grid(tNow(), 8);
    arp(t, Math.min(1 + Math.floor(s), 4), Math.min(5, 2 + Math.floor(s * 2)), beatLen(t) / 8, 0.18, 0.2 + 0.2 * s);
    if (x >= 20) { var v = sfxVoice(); bigSplash(v, t, 0.14, false); glitter(v, t, 0.8, 0.04); }
  }
  function combo(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 1, 8));
    var v = sfxVoice(), t = grid(tNow(), 8), st = beatLen(t) / 8;
    send(v, v.out, 0.3);
    for (var k = 0; k < 2 + n; k++) conga(v, pn(v, k % 2 ? 0.3 : -0.3, v.out), t + k * st, k % 2 ? 330 : 247, 0.16 + 0.02 * k, k === 1 + n);
    for (k = 0; k < Math.min(6, 2 + n); k++) drop(v, pn(v, -0.4 + 0.16 * k, v.out), t + (2 + n) * st + k * st, mf(LADDER[3 + k]), 0.15);
    punch(v, v.out, t + (2 + n) * st, 0.22);
  }
  function topUp() { if (!ok()) return; var v = sfxVoice(), t = tNow(); shells(v, t, 9, 0.45, 0.07); drop(v, v.out, t, mf(79), 0.1); drop(v, v.out, t + BEAT / 4, mf(83), 0.1); }
  function maxWin() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(0.02), h = t + 0.5, body = ukeBody(v, v.out);
    duckFor(3.6);
    send(v, v.out, 0.35);
    riser(v, v.out, t, 0.5, 0.18);
    impact(v, h, 0.55);
    bigSplash(v, h, 0.4, true);
    waveCrash(v, h, 0.22, 2.8);
    whale(v, v.out, h + 0.1, mf(36), 2.8, 0.11);
    conch(v, pn(v, -0.25, v.out), h + 0.1, 55, 1.8, 0.13);
    conch(v, pn(v, 0.25, v.out), h + 0.25, 62, 1.6, 0.08);
    tremoloStrum(v, body, h, UKE.G8, 2, 0.34, BEAT / 4);
    var v2 = sfxVoice();
    gulls(v2, h + 0.3, 4, 0.06);
    shells(v2, h + 0.2, 26, 2.2, 0.06);
    glitter(v2, h + 0.2, 2.4, 0.07);
  }

  function bonusEnd(x) {
    if (!ctx) return;
    x = +x || 0;
    var t = tNow(0.02), L = 0.8;
    if (ok()) {
      var s = x >= 1 ? Math.min(log10(x), 3.5) : 0, v = sfxVoice();
      if (x < 1) { wipe(v, t, 0.4); L = 1.2; }
      else {
        var gv = gc(v, 1, v.out), body = ukeBody(v, gv);
        send(v, gv, 0.45);
        var bl = beatLen(t), tr = bl / 4, tm = grid(t + 3 * tr, 1, bl + 0.01), tp = tm - 3 * tr;
        for (var k = 0; k < 3; k++) uke(v, body, tp + k * tr, 62, 0.24, { len: tr * 0.8, vi: k });
        var h1 = Math.max(1, Math.round((0.5 + 0.2 * s) / bl)) * bl;
        strum(v, body, tm, UKE.G, 0.42);
        impact(v, tm, 0.28);
        sub(v, tm, 31, 0.2, h1 + 0.2);
        bigSplash(v, tm, 0.18, false);
        glitter(v, tm, 0.6 + 0.2 * s, 0.04);
        L = tm - t + h1 + 0.4;
        if (s >= 1) {
          var t2 = tm + h1 - 3 * tr;
          uke(v, body, t2, 62, 0.24, { len: tr * 0.9, vi: 0 });
          uke(v, body, t2 + tr, 64, 0.24, { len: tr * 0.9, vi: 1 });
          uke(v, body, t2 + 2 * tr, 66, 0.25, { len: tr * 0.9, vi: 2 });
          var t3 = tm + h1, h2 = 0.7 + 0.3 * s, v3 = sfxVoice(), b3 = ukeBody(v3, v3.out);
          send(v3, v3.out, 0.4);
          tremoloStrum(v3, b3, t3, UKE.G8, Math.min(h2 * 0.6, 1.6), 0.4, tr);
          impact(v3, t3, 0.35);
          sub(v3, t3, 31, 0.22, h2);
          bigSplash(v3, t3, 0.28, true);
          gulls(v3, t3 + 0.15, 3, 0.05);
          L = t3 - t + h2 + 0.5;
          if (s >= 2) {
            var v2 = sfxVoice();
            for (var r = 0; r < 10; r++) thump(v2, t3 + r * bl / 8, 0.08 + 0.015 * r);
            whale(v2, v2.out, t3 + 0.1, mf(43), 2.2, 0.09);
            conch(v2, v2.out, t3 + bl / 2, 67, 1.1, 0.09);
            shells(v2, t3 + 0.1, 16, 1.4, 0.05);
          }
        }
      }
      duckFor(L);
    }
    if (curMode === 'bonus') { curMode = 'base'; modeTo(t + L * 0.7, 1, 0.6); }
  }
  function bail() { if (!ok()) return; var v = sfxVoice(), t = tNow(); wipe(v, t, 1); }


  function buyOpen() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    for (var k = 0; k < 4; k++) card(v, pn(v, -0.45 + 0.3 * k, v.out), t + k * 0.075 + rnd() * 0.01, 0.65);
    swish(v, v.out, t, 0.16, 0.3, 1200, 3500);
  }
  var BUYKEY = [[55, 'G'], [62, 'D'], [67, 'G8']];
  function buy(tier) {
    if (!ok()) return;
    tier = Math.round(clamp(tier, 0, 2));
    var v = sfxVoice(), t = tNow(), h = t + 0.2, body = ukeBody(v, v.out);
    send(v, v.out, 0.35);
    shells(v, t, 10 + 4 * tier, 0.3, 0.08);
    conga(v, pn(v, -0.25, v.out), t + 0.02, 196, 0.24, false);
    conga(v, pn(v, 0.25, v.out), t + 0.11, 294, 0.22, true);
    impact(v, h, 0.32);
    bigSplash(v, h, 0.18, tier === 2);
    strum(v, body, h, UKE[BUYKEY[tier][1]], 0.38, { spread: 0.01 });
    drop(v, v.out, h, mf(BUYKEY[tier][0] + 12), 0.14);
    if (tier === 2) whale(v, v.out, h + 0.05, mf(38), 1.8, 0.08);
  }
  function modeSelect(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 0, 4));
    var v = sfxVoice(), t = tNow(), body = ukeBody(v, v.out);
    woodKnock(v, v.out, t, mf(55 + 2 * n), 0.16);
    whoosh(v, v.out, t, 0.12, 0.28, { from: -0.3, to: 0.3, f0: 800, f1: 3000 });
    strum(v, body, t + 0.06, [UKE.G, UKE.C, UKE.D, UKE.Em, UKE.G8][n], 0.26, { spread: 0.009 });
  }
  function trickSpin(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 1, 3));
    var v = sfxVoice(), t = tNow();
    for (var k = 0; k < n; k++) { var tk = t + k * 0.11; woodKnock(v, pn(v, -0.2 + 0.2 * k, v.out), tk, mf(57 + 5 * k), 0.2); tick(v, v.out, tk, 2400, 1, 0.12, 0.012); }
    whoosh(v, v.out, t + n * 0.11, 0.2, 0.38, { from: -0.5, to: 0.5, f0: 500, f1: 3800 });
    dolphin(v, pn(v, 0.3, v.out), t + n * 0.11 + 0.05, 0.05, n === 3);
  }
  function slam() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    punch(v, v.out, t, 0.5, 180, 50, 0.12);
    woodKnock(v, v.out, t, mf(50), 0.36);
    sample(v, v.out, t, spl(), 0.12, 1.3, { dur: 0.2, fade: 0.15 });
  }
  function bet(i, n) {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(), q = n > 1 ? clamp(i / (n - 1), 0, 1) : 0.5, f = mf(TICKS[Math.round(q * 9)]);
    drop(v, pn(v, -0.3 + 0.6 * q, v.out), t, f, 0.26);
    woodKnock(v, v.out, t, f / 2, 0.05);
  }
  function toggle(on) {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(), a = on ? 74 : 79, b = on ? 79 : 74;
    woodKnock(v, v.out, t, mf(a) / 2, 0.07);
    drop(v, v.out, t, mf(a), 0.08);
    drop(v, v.out, t + 0.07, mf(b), 0.1);
  }
  function panel(open) {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    whoosh(v, v.out, t, 0.14, 0.22, { from: open ? 0.4 : -0.4, to: open ? -0.1 : 0.1, f0: open ? 900 : 2600, f1: open ? 2600 : 900 });
    woodKnock(v, v.out, t + (open ? 0.12 : 0), mf(open ? 67 : 62) / 2, 0.1);
  }
  function cash() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    shells(v, t, 18, 0.7, 0.08);
    bigSplash(v, t + 0.05, 0.1, false);
    drop(v, v.out, t + 0.1, mf(79), 0.12);
    drop(v, v.out, t + 0.2, mf(86), 0.1);
  }
  function nope() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    woodKnock(v, v.out, t, mf(59) / 2, 0.06);
    drop(v, v.out, t, mf(62), 0.09);
    drop(v, v.out, t + 0.12, mf(55), 0.09);
  }
  var UIN = [74, 79, 83];
  function ui() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    woodKnock(v, pn(v, (rnd() - 0.5) * 0.2, v.out), t, mf(UIN[Math.floor(rnd() * UIN.length)]) / 2 * (1 + (rnd() - 0.5) * 0.02), 0.06);
  }


  function debug() {
    return {
      state: ctx ? ctx.state : 'none', mode: curMode, musicOn: musicOn, muted: muted,
      sfxVoices: voices.sfx.length, musicVoices: mus.src ? 1 : 0,
      music: { fmt: mus.fmt, fetched: mus.fetched, decoded: !!mus.buf, playing: !!mus.src, loopStart: mus.loopStart,
               loopEnd: mus.loopEnd, primingSkipped: mus.off, bufferLength: mus.buf ? mus.buf.length : 0,
               rate: mus.buf ? mus.buf.sampleRate : 0, level: N.musicMode ? N.musicMode.gain.value : 1, error: mus.err },
      created: stats.created, stolen: stats.stolen, ducking: duckCount, ukeStrings: Object.keys(ksCache).length, kit: Object.keys(SB).length
    };
  }

  root.MangoAudio = {
    init: safe(init, false),
    unlock: safe(unlock, false),
    setYield: safe(setYield),
    isReady: safe(isReady, false),
    startMusic: safe(startMusic),
    stopMusic: safe(stopMusic),
    setMode: safe(setMode),
    getMode: function () { return curMode; },
    setMuted: safe(setMuted),
    setMusicVolume: safe(setMusicVolume),
    setSfxVolume: safe(setSfxVolume),
    spinStart: safe(spinStart),
    reelStop: safe(reelStop),
    scatterLand: safe(scatterLand),
    anticipation: safe(anticipation),
    wildLand: safe(wildLand),
    win: safe(win),
    countUp: safe(countUp, noop),
    bonusTrigger: safe(bonusTrigger),
    bonusSpinWin: safe(bonusSpinWin),
    bonusEnd: safe(bonusEnd),
    bail: safe(bail),
    ui: safe(ui),
    stackStep: safe(stackStep),
    wildExpand: safe(wildExpand),
    legendLand: safe(legendLand),
    freeSpin: safe(freeSpin),
    combo: safe(combo),
    topUp: safe(topUp),
    maxWin: safe(maxWin),
    tierUp: safe(tierUp),
    buyOpen: safe(buyOpen),
    buy: safe(buy),
    modeSelect: safe(modeSelect),
    trickSpin: safe(trickSpin),
    slam: safe(slam),
    bet: safe(bet),
    toggle: safe(toggle),
    panel: safe(panel),
    cash: safe(cash),
    nope: safe(nope),
    _debug: debug
  };
})(typeof window !== 'undefined' ? window : null);

