/*
 * Mango Surf audio - synthesized Web Audio module (play money learning project).
 * Fork of sk8-audio.js: same engine and public API, surf musical content.
 * Plain browser JS, no imports, no files, no network. Defines exactly one global: window.MangoAudio.
 *
 * Key: G major everywhere.
 *   Base loop  104 BPM, light swing: G | Em | C | D (I-vi-IV-V) x2, 60s beach surf groove.
 *   Bonus loop 160 BPM straight:     G | C | D | C | G | Em | C | D, tremolo-picked surf rock.
 *   Win stingers, chimes, plops and ticks all use G major / G major pentatonic.
 *
 * Graph:
 *   seq drums  -> shaper -> trim --\
 *   seq guitar -> tremolo ---------+-> seq.gain -> musicBus -> duck -> musicLP -> musicVol --\
 *                   \-> spring ----/                                                           |
 *   seq pad (organ/uke) -----------/  (+ small spring send)                                    |
 *   sfx voices ------------------------------------------> sfxBus -> sfxVol ------------------+-> compressor -> master -> destination
 *        \-> sfx spring (send) --------------------------/
 */
(function (root) {
  'use strict';
  if (!root) return;

  var AC = root.AudioContext || root.webkitAudioContext;

  // ---------- config ----------
  var MASTER = 0.9;          // master gain when unmuted
  var MUSIC_LEVEL = 0.16;    // music bus scaler; with musicVolume 0.8 music peaks ~ -18 dBFS
  var LOOKAHEAD = 0.12;      // seconds scheduled ahead
  var TICK_MS = 25;          // scheduler interval
  var CAP = { sfx: 40, music: 96 };  // max simultaneous voices per pool (oldest is stolen)
  var LP_BASE = 5200, LP_BONUS = 11000, LP_OPEN = 16000;
  var BASE_BPM = 104, BONUS_BPM = 160;

  // ---------- state ----------
  var ctx = null;
  var muted = false;
  var musicVolume = 0.8;
  var sfxVolume = 1;
  var N = {};                // graph nodes
  var noiseBuf = null, curveSoft = null, curveHard = null;
  var seqs = {};
  var curMode = 'base';
  var musicOn = false;
  var duckCount = 0;
  var antic = null;
  var voices = { sfx: [], music: [] };
  var stats = { created: 0, stolen: 0, leakWarned: false };

  // ---------- small helpers ----------
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

  // Freeze a param at time t so a new ramp can start from wherever it is (never jumps).
  function holdAt(p, t) {
    if (p.cancelAndHoldAtTime) {
      try { p.cancelAndHoldAtTime(t); return; } catch (e) { /* fall through */ }
    }
    var v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }

  // Attack/decay envelope from silence to silence (0.0001 = -80 dB, exponential-safe).
  function envAD(p, t, a, peak, d) {
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  // Attack, decay to a sustain level by t+hold, then release.
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

  // ---------- voice management ----------
  // A voice owns every node of one sound. When all of its sources end it disconnects them.
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
      try { this.nodes[i].disconnect(); } catch (e) { /* already gone */ }
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
      try { this.sources[i].stop(now + 0.03); } catch (e) { /* ignore */ }
    }
    setTimeout(function () { self.finish(); }, 600);  // fallback if onended never fires
  };

  function newVoice(pool, dest) {
    var list = voices[pool], live = 0, i;
    for (i = 0; i < list.length; i++) if (!list[i].stolen) live++;
    i = 0;
    while (live >= CAP[pool] && i < list.length) {
      if (!list[i].stolen) { list[i].steal(); live--; }
      i++;
    }
    // Hard ceiling: in a synchronous burst, stolen voices have not started sounding yet,
    // so dropping the oldest of them outright keeps the node count bounded without clicks.
    i = 0;
    while (list.length >= CAP[pool] * 2 && i < list.length) {
      if (list[i].stolen) list[i].finish(); else i++;
    }
    var v = new Voice(pool, dest);
    list.push(v);
    stats.created++;
    return v;
  }
  function sfxVoice() { return newVoice('sfx', N.sfxBus); }

  // node builders (all registered on the voice so they get disconnected)
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
  function noise(v, t0, t1, dest) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.connect(dest);
    v.play(s, t0, t1, Math.random() * 1.5);
    return s;
  }
  function shaper(v, curve, dest) {
    var w = v.add(ctx.createWaveShaper());
    w.curve = curve; w.oversample = '2x'; w.connect(dest);
    return w;
  }
  // send a node's output into the shared SFX spring reverb
  function send(v, node, amt) { if (N.sfxSpring) node.connect(gc(v, amt, N.sfxSpring)); }

  // ---------- spring reverb (persistent; three damped combs behind two chirpy allpasses) ----------
  function makeSpring(dest, wet, fbs) {
    var inp = ctx.createGain(); inp.gain.value = 1;
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.7;
    var ap1 = ctx.createBiquadFilter(); ap1.type = 'allpass'; ap1.frequency.value = 1100; ap1.Q.value = 3;
    var ap2 = ctx.createBiquadFilter(); ap2.type = 'allpass'; ap2.frequency.value = 2300; ap2.Q.value = 3;
    var out = ctx.createGain(); out.gain.value = wet * 0.3;
    var lpo = ctx.createBiquadFilter(); lpo.type = 'lowpass'; lpo.frequency.value = 3600; lpo.Q.value = 0.5;
    inp.connect(hp); hp.connect(ap1); ap1.connect(ap2);
    var times = [0.029, 0.041, 0.053];
    for (var k = 0; k < times.length; k++) {
      var d = ctx.createDelay(0.2); d.delayTime.value = times[k];
      var damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2600; damp.Q.value = 0.5;
      var fb = ctx.createGain(); fb.gain.value = fbs[k];
      ap2.connect(d); d.connect(damp); damp.connect(fb); fb.connect(d); damp.connect(out);
    }
    out.connect(lpo); lpo.connect(dest);
    return inp;
  }

  // ---------- shared SFX building blocks ----------
  // steel drum: strong 2nd and 3rd partials, soft mallet ping
  function pan(v, t, f, dur, peak) {
    var g1 = gn(v, v.out); envAD(g1.gain, t, 0.003, peak * 0.7, dur);
    var g2 = gn(v, v.out); envAD(g2.gain, t, 0.003, peak * 0.32, dur * 0.6);
    var g3 = gn(v, v.out); envAD(g3.gain, t, 0.002, peak * 0.14, dur * 0.3);
    var g4 = gn(v, v.out); envAD(g4.gain, t, 0.001, peak * 0.1, 0.03);
    osc(v, 'sine', f, t, t + dur + 0.05, g1);
    osc(v, 'sine', f * 2, t, t + dur * 0.6 + 0.05, g2, 0, 0, 4);
    osc(v, 'sine', f * 3, t, t + dur * 0.3 + 0.05, g3, 0, 0, -5);
    osc(v, 'triangle', f * 4.2, t, t + 0.06, g4);
  }
  // marimba: fundamental plus the 4th-ish partial and a felt-mallet tap
  function mar(v, dest, t, f, peak, dur) {
    var g1 = gn(v, dest); envAD(g1.gain, t, 0.002, peak, dur);
    var g2 = gn(v, dest); envAD(g2.gain, t, 0.001, peak * 0.25, dur * 0.2);
    var g3 = gn(v, dest); envAD(g3.gain, t, 0.001, peak * 0.15, 0.012);
    osc(v, 'sine', f, t, t + dur + 0.05, g1);
    osc(v, 'sine', f * 3.93, t, t + dur * 0.2 + 0.05, g2);
    noise(v, t, t + 0.03, filt(v, 'bandpass', f * 2, 2, g3));
  }
  function bell(v, t, f, peak, dur) {
    var g1 = gn(v, v.out); envAD(g1.gain, t, 0.002, peak, dur);
    var g2 = gn(v, v.out); envAD(g2.gain, t, 0.002, peak * 0.3, dur * 0.35);
    var g3 = gn(v, v.out); envAD(g3.gain, t, 0.001, peak * 0.12, dur * 0.12);
    osc(v, 'sine', f, t, t + dur + 0.05, g1);
    osc(v, 'sine', f * 2.76, t, t + dur * 0.35 + 0.05, g2);
    osc(v, 'sine', f * 5.4, t, t + dur * 0.12 + 0.05, g3);
  }
  function cymbal(v, t, peak, dur) {
    var g = gn(v, v.out); envAD(g.gain, t, 0.003, peak, dur);
    noise(v, t, t + dur + 0.05, filt(v, 'highpass', 6000, 0.7, g));
    var g2 = gn(v, v.out); envAD(g2.gain, t, 0.002, peak * 0.5, dur * 0.4);
    noise(v, t, t + dur * 0.4 + 0.05, filt(v, 'bandpass', 9500, 2, g2));
  }
  function thump(v, t, peak) {
    var g = gn(v, v.out); envAD(g.gain, t, 0.002, peak, 0.2);
    osc(v, 'sine', 160, t, t + 0.25, g, 48, 0.1);
  }
  // water splash: falling band of noise, a hiss of spray and a low plunk
  function splash(v, t, peak, dur) {
    var g = gn(v, v.out); envAD(g.gain, t, 0.006, peak, dur);
    var bp = filt(v, 'bandpass', 3200, 0.7, g);
    bp.frequency.setValueAtTime(hz(3200), t);
    bp.frequency.exponentialRampToValueAtTime(700, t + dur);
    noise(v, t, t + dur + 0.05, bp);
    var g2 = gn(v, v.out); envAD(g2.gain, t, 0.002, peak * 0.4, dur * 0.35);
    noise(v, t, t + dur * 0.35 + 0.05, filt(v, 'highpass', 6500, 0.7, g2));
    var g3 = gn(v, v.out); envAD(g3.gain, t, 0.004, peak * 0.6, 0.12);
    noise(v, t, t + 0.17, filt(v, 'lowpass', 420, 0.7, g3));
  }
  // big wave crash: wide noise wall that darkens as it rolls out, spray on top, rumble below
  function waveCrash(v, t, peak, dur) {
    var g = gn(v, v.out); envAHR(g.gain, t, 0.03, peak, dur * 0.4, 0.35, dur * 0.6);
    var lp = filt(v, 'lowpass', 3800, 0.6, g);
    lp.frequency.setValueAtTime(hz(3800), t);
    lp.frequency.exponentialRampToValueAtTime(380, t + dur);
    noise(v, t, t + dur + 0.1, lp);
    var g2 = gn(v, v.out); envAD(g2.gain, t, 0.01, peak * 0.35, dur * 0.5);
    noise(v, t, t + dur * 0.5 + 0.05, filt(v, 'highpass', 5000, 0.7, g2));
    var g3 = gn(v, v.out); envAD(g3.gain, t, 0.02, peak * 0.7, dur * 0.7);
    noise(v, t, t + dur * 0.7 + 0.05, filt(v, 'lowpass', 180, 0.7, g3));
  }
  // twangy surf-guitar pluck: saw + a little square through a mid peak and a closing low-pass.
  // o: { bright, from (start freq for a slide), glide, sus, det }
  function pluck(v, dest, t, f, len, peak, o) {
    o = o || {};
    len = Math.max(len, 0.04);
    var g = gn(v, dest);
    envAHR(g.gain, t, 0.003, peak, len, o.sus || 0.3, 0.18);
    var pk = v.add(ctx.createBiquadFilter());
    pk.type = 'peaking'; pk.frequency.value = 1400; pk.Q.value = 1.2; pk.gain.value = 5; pk.connect(g);
    var top = o.bright ? 4400 : 3200;
    var lp = filt(v, 'lowpass', top, 1.4, pk);
    lp.frequency.setValueAtTime(hz(top), t);
    lp.frequency.exponentialRampToValueAtTime(o.bright ? 1300 : 900, t + len + 0.1);
    var end = t + len + 0.2, f0 = o.from || f * 0.988, gl = o.from ? (o.glide || Math.min(0.25, len * 0.6)) : 0.035;
    osc(v, 'sawtooth', f0, t, end, lp, f, gl, o.det || 0);
    osc(v, 'square', f0, t, end, gc(v, 0.3, lp), f, gl, 5);
  }
  // strummed surf-guitar chord with a tremolo bar and spring
  function gchord(v, t, notes, dur, peak, rate) {
    var trem = gc(v, 0.8, v.out);
    send(v, trem, 0.6);
    osc(v, 'sine', rate || 6.5, t, t + dur + 0.6, gc(v, 0.2, trem.gain));
    var sh = shaper(v, curveSoft, trem);
    var p = peak / Math.sqrt(notes.length);
    for (var i = 0; i < notes.length; i++) pluck(v, sh, t + i * 0.012, mf(notes[i]), dur, p, { sus: 0.55 });
  }
  function panChord(v, t, base, dur, peak) {
    var ns = [base, base + 4, base + 7, base + 12];
    for (var i = 0; i < ns.length; i++) pan(v, t + i * 0.012, mf(ns[i]), dur, peak);
  }
  function neutralTick() {
    var v = sfxVoice(), t = tNow();
    var g = gn(v, v.out); envAD(g.gain, t, 0.001, 0.1, 0.035);
    osc(v, 'triangle', 1050, t, t + 0.06, filt(v, 'bandpass', 1400, 1, g));
  }
  // gentle wipe-out: guitar slide falling with a wobble, then a splash
  function wipe(v, t, k) {
    var g = gn(v, v.out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.17 * k, t + 0.02);
    g.gain.linearRampToValueAtTime(0.14 * k, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    send(v, g, 0.7);
    var lp = filt(v, 'lowpass', 2600, 1, g);
    var o = ctx.createOscillator(), o2 = ctx.createOscillator();
    o.type = 'sawtooth'; o2.type = 'square';
    var fs = [o.frequency, o2.frequency];
    for (var i = 0; i < 2; i++) {
      fs[i].setValueAtTime(mf(74), t);
      fs[i].exponentialRampToValueAtTime(mf(74) * 1.03, t + 0.06);
      fs[i].exponentialRampToValueAtTime(mf(50), t + 0.8);
    }
    o.connect(lp); o2.connect(gc(v, 0.3, lp));
    var lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    var depth = gc(v, 9, o.frequency); lfo.connect(depth); depth.connect(o2.frequency);
    v.play(lfo, t, t + 0.9); v.play(o, t, t + 0.9); v.play(o2, t, t + 0.9);
    splash(v, t + 0.72, 0.17 * k, 0.5);
    thump(v, t + 0.72, 0.18 * k);
  }

  // G major arpeggio ladder (same key as the music)
  var LADDER = [55, 59, 62, 67, 71, 74, 79, 83, 86, 91, 95];
  function arp(t, startIdx, count, step, peak, holdLast) {
    var v = sfxVoice(), last = LADDER[0];
    for (var k = 0; k < count; k++) {
      var idx = Math.min(startIdx + k, LADDER.length - 1), isLast = (k === count - 1);
      last = LADDER[idx];
      pan(v, t + k * step, mf(last), isLast ? holdLast : step * 1.6, isLast ? peak : peak * 0.85);
    }
    return { tEnd: t + (count - 1) * step, lastMidi: last };
  }

  // ---------- music ducking (sidechain dip + low-pass opening) ----------
  function lpBase() { return curMode === 'bonus' ? LP_BONUS : LP_BASE; }
  function applyDuck(on) {
    var now = ctx.currentTime, g = N.duck.gain, f = N.musicLP.frequency;
    holdAt(g, now); holdAt(f, now);
    if (on) {
      g.linearRampToValueAtTime(0.45, now + 0.08);
      f.exponentialRampToValueAtTime(LP_OPEN, now + 0.35);
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
    if (duckCount > 0) return;  // release will land on the right value
    var f = N.musicLP.frequency;
    holdAt(f, when);
    f.exponentialRampToValueAtTime(lpBase(), when + 0.5);
  }

  // ---------- music instruments ----------
  function kick(s, t, vel) {
    var v = newVoice('music', s.drums);
    var g = gn(v, v.out); envAD(g.gain, t, 0.002, 0.46 * vel, 0.26);
    osc(v, 'sine', 120, t, t + 0.32, g, 48, 0.1);
    var cg = gn(v, v.out); envAD(cg.gain, t, 0.001, 0.07 * vel, 0.01);
    noise(v, t, t + 0.03, filt(v, 'lowpass', 2200, 0.7, cg));
  }
  function snare(s, t, vel, bright) {
    var v = newVoice('music', s.drums), d = bright ? 0.13 : 0.16;
    var g = gn(v, v.out); envAD(g.gain, t, 0.001, 0.28 * vel, d);
    noise(v, t, t + d + 0.03, filt(v, 'bandpass', bright ? 2800 : 2000, 0.8, g));
    var bg = gn(v, v.out); envAD(bg.gain, t, 0.001, 0.2 * vel, 0.07);
    osc(v, 'triangle', bright ? 230 : 200, t, t + 0.1, bg, 150, 0.07);
  }
  function rim(s, t, vel) {   // cross-stick for the laid-back breakdown loops
    var v = newVoice('music', s.drums);
    var g = gn(v, v.out); envAD(g.gain, t, 0.001, 0.16 * vel, 0.04);
    noise(v, t, t + 0.06, filt(v, 'bandpass', 1900, 3, g));
    var tg = gn(v, v.out); envAD(tg.gain, t, 0.001, 0.12 * vel, 0.03);
    osc(v, 'triangle', 880, t, t + 0.05, tg);
  }
  function hat(s, t, vel, open) {
    var v = newVoice('music', s.drums), d = open ? 0.24 : 0.035;
    var g = gn(v, v.out); envAD(g.gain, t, 0.001, 0.09 * vel, d);
    noise(v, t, t + d + 0.03, filt(v, 'highpass', 7500, 0.7, g));
  }
  var TOMS = [196, 147, 110, 82];   // hi, mid, low, floor
  function tom(s, t, which, vel) {
    var v = newVoice('music', s.drums), f = TOMS[which];
    var g = gn(v, v.out); envAD(g.gain, t, 0.002, 0.34 * vel, 0.26 + which * 0.04);
    osc(v, 'sine', f * 1.6, t, t + 0.36 + which * 0.04, g, f, 0.06);
    var ng = gn(v, v.out); envAD(ng.gain, t, 0.001, 0.05 * vel, 0.02);
    noise(v, t, t + 0.04, filt(v, 'bandpass', f * 5, 1.5, ng));
  }
  function crash(s, t, vel) {
    var v = newVoice('music', s.drums);
    var g = gn(v, v.out); envAD(g.gain, t, 0.003, 0.12 * vel, 1.6);
    noise(v, t, t + 1.65, filt(v, 'highpass', 5200, 0.7, g));
  }
  function wash(s, t, len) {   // distant shore wave under the base groove
    var v = newVoice('music', s.gain);
    var g = gn(v, v.out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.026, t + len * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    var lp = filt(v, 'lowpass', 600, 0.5, g);
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(1700, t + len * 0.4);
    lp.frequency.exponentialRampToValueAtTime(450, t + len);
    noise(v, t, t + len + 0.05, lp);
  }
  function bass(s, t, f, len, vel, picked) {
    var v = newVoice('music', picked ? s.drums : s.gain);
    var g = gn(v, v.out);
    var p = (picked ? 0.19 : 0.22) * vel;
    envAHR(g.gain, t, 0.008, p, Math.max(len, 0.03), 0.45, 0.08);
    var end = t + Math.max(len, 0.03) + 0.12;
    if (picked) {
      var lp = filt(v, 'lowpass', 1800, 1.5, g);
      lp.frequency.setValueAtTime(1800, t);
      lp.frequency.exponentialRampToValueAtTime(600, t + Math.max(len, 0.03));
      osc(v, 'sawtooth', f, t, end, lp);
      osc(v, 'sine', f, t, end, gc(v, 0.6, g));
    } else {
      osc(v, 'sine', f * 1.015, t, end, g, f, 0.03);           // tiny pitch settle = round thump
      osc(v, 'triangle', f, t, end, filt(v, 'lowpass', 650, 0.7, gc(v, 0.5, g)));
    }
  }
  function lead(s, t, midi, len, vel, bright) {   // single twangy reverb-guitar note
    var v = newVoice('music', s.gtr), f = mf(midi);
    var slide = (len > 0.4 && rnd() < 0.18) ? f * Math.pow(2, -2 / 12) : 0;   // occasional slide into the note
    pluck(v, v.out, t, f, len, 0.075 * vel, { bright: bright, from: slide, glide: 0.07, sus: 0.35 });
  }
  function tremLead(s, t, midi, len, vel, rate) {  // tremolo-picked note: one voice, picks re-trigger the gain
    var v = newVoice('music', s.gtr), f = mf(midi), end = t + len + 0.15;
    var g = gn(v, v.out);
    var pk = v.add(ctx.createBiquadFilter());
    pk.type = 'peaking'; pk.frequency.value = 1500; pk.Q.value = 1.2; pk.gain.value = 5; pk.connect(g);
    var lp = filt(v, 'lowpass', 3000, 1.2, pk);
    osc(v, 'sawtooth', f, t, end, lp);
    osc(v, 'square', f, t, end, gc(v, 0.3, lp), 0, 0, 6);
    var k = 0, tp = t, peak = 0.06 * vel;
    while (tp < t + len - 0.01) {
      envAD(g.gain, tp, 0.002, peak * ((k & 1) ? 0.78 : 1), rate * 0.92);
      tp += rate; k++;
    }
  }
  function strum(s, t, notes, len, vel, up) {   // rhythm guitar chord
    var v = newVoice('music', s.gtr), n = notes.length;
    for (var i = 0; i < n; i++) {
      var m = up ? notes[n - 1 - i] : notes[i];
      pluck(v, v.out, t + i * 0.011, mf(m), len, 0.028 * vel * (up ? 0.8 : 1), { sus: 0.4 });
    }
  }
  function organ(s, t, notes, len, vel) {   // soft combo-organ pad (drawbars 8', 4', 2 2/3')
    var v = newVoice('music', s.pad);
    var lp = filt(v, 'lowpass', 2200, 0.5, v.out);
    var g = gn(v, lp);
    envAHR(g.gain, t, 0.09, 0.016 * vel, len, 0.85, 0.35);
    var end = t + len + 0.4, h2 = gc(v, 0.5, g), h3 = gc(v, 0.22, g);
    for (var i = 0; i < notes.length; i++) {
      var f = mf(notes[i]);
      osc(v, 'sine', f, t, end, g);
      osc(v, 'sine', f * 2, t, end, h2, 0, 0, 3);
      osc(v, 'sine', f * 3, t, end, h3);
    }
  }
  function uke(s, t, notes, len, vel, up) {   // ukulele strum, nylon-soft
    var v = newVoice('music', s.pad), n = notes.length, d = Math.min(len, 0.4);
    var lp = filt(v, 'lowpass', 3000, 0.7, v.out);
    for (var i = 0; i < n; i++) {
      var m = up ? notes[n - 1 - i] : notes[i], tk = t + i * 0.016;
      var g = gn(v, lp); envAD(g.gain, tk, 0.002, 0.03 * vel * (up ? 0.7 : 1), d);
      osc(v, 'triangle', mf(m), tk, tk + d + 0.05, g);
    }
  }

  // ---------- patterns (16 steps per bar, 8 bars = 128 steps) ----------
  var BASE = {
    roots: [43, 40, 36, 38],                                                  // G2 E2 C2 D2
    third: [4, 3, 4, 4],
    gtr:   [[55, 59, 62, 67], [52, 55, 59, 64], [48, 55, 60, 64], [50, 57, 62, 66]],  // G Em C D
    org:   [[59, 62, 67], [59, 64, 67], [60, 64, 67], [57, 62, 66]],
    uke:   [[62, 67, 71, 74], [64, 67, 71, 76], [64, 67, 72, 76], [62, 66, 69, 74]]
  };
  var KA = [1, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0.5, 0, 0, 0, 0, 0];
  var KB = [1, 0, 0, 0, 0, 0, 0.45, 0, 0.9, 0, 0, 0, 0, 0, 0, 0];
  // root-fifth bass: [step, interval, length in steps, velocity]; fifth sits below the root
  var BASSRF = [[0, 0, 4, 1], [6, 0, 2, 0.6], [8, -5, 4, 0.9], [14, -5, 2, 0.55]];
  // two lead melodies over G Em C D x2, G major pentatonic + chord tones: [step, midi, length in steps]
  var M1 = [
    [[0, 71, 3], [3, 74, 3], [6, 76, 2], [8, 74, 6]],
    [[0, 71, 2], [2, 67, 2], [4, 64, 8]],
    [[0, 64, 2], [2, 67, 2], [4, 72, 4], [8, 71, 2], [10, 69, 6]],
    [[0, 66, 4], [4, 69, 4], [8, 74, 6]],
    [[0, 79, 4], [4, 76, 2], [6, 74, 2], [8, 71, 8]],
    [[0, 76, 3], [3, 74, 3], [6, 71, 2], [8, 67, 8]],
    [[0, 72, 2], [2, 76, 2], [4, 79, 4], [8, 76, 2], [10, 72, 6]],
    [[0, 74, 4], [4, 72, 2], [6, 69, 2], [8, 66, 4]]
  ];
  var M2 = [
    [[2, 62, 2], [4, 67, 2], [6, 71, 4], [10, 69, 2], [12, 67, 4]],
    [[0, 64, 6]],
    [[2, 64, 2], [4, 67, 2], [6, 72, 4], [10, 71, 2], [12, 69, 4]],
    [[0, 66, 6], [8, 69, 2], [10, 66, 2]],
    [[0, 67, 2], [2, 71, 2], [4, 74, 4], [8, 79, 4], [12, 76, 4]],
    [[0, 74, 8], [8, 71, 4], [12, 67, 4]],
    [[0, 72, 4], [4, 71, 2], [6, 69, 2], [8, 67, 4], [12, 64, 4]],
    [[0, 66, 4], [4, 69, 4], [8, 72, 2], [10, 71, 2]]
  ];
  var LEADS = [M1, M2];
  var UKE = [[0, 0], [4, 0], [6, 1], [10, 1], [12, 0], [14, 1]];   // island strum: [step, up?]
  // bar-7 tom fills: [step, drum ('s' snare or tom index), velocity]
  var FILLS = [
    [[12, 0, 0.8], [13, 0, 0.6], [14, 1, 0.8], [15, 2, 0.9]],
    [[12, 's', 0.8], [13, 's', 0.45], [14, 2, 0.8], [15, 3, 0.95]],
    [[8, 0, 0.55], [9, 0, 0.45], [10, 1, 0.6], [11, 1, 0.5], [12, 2, 0.7], [13, 2, 0.6], [14, 3, 0.85], [15, 's', 0.9]],
    [[12, 's', 0.55], [14, 's', 0.75], [15, 2, 0.85]]
  ];

  // Re-roll the arrangement every 8 bars so the loop never repeats exactly:
  // lead melody A / B / none, organ, ukulele, breakdown (cross-stick, root-fifth only), fill choice, shore wash.
  function arrange(s) {
    var L = s.loops, a = {};
    if (L === 0) {
      a.lead = M1; a.organ = false; a.uke = false; a.drop = false; a.fill = 0; a.fill3 = false; a.wash = true;
    } else {
      a.lead = (L % 3 === 2) ? null : LEADS[(L + (rnd() < 0.3 ? 1 : 0)) & 1];
      if (a.lead && rnd() < 0.15) a.lead = null;
      a.organ = !a.lead || rnd() < 0.35;
      a.uke = !a.lead || rnd() < 0.35;
      a.drop = (L % 4 === 3);
      a.fill = Math.floor(rnd() * FILLS.length);
      a.fill3 = rnd() < 0.5;
      a.wash = rnd() < 0.5;
    }
    s.arr = a;
  }

  function stepBase(s, step, t) {
    if (step === 0 || !s.arr) arrange(s);
    var a = s.arr, bar = step >> 4, i = step & 15, sd = s.sd, ci = bar & 3, k;
    var tt = t + ((i & 3) === 2 ? sd * 0.16 : ((i & 1) ? sd * 0.08 : 0));   // light swing
    var fl = FILLS[a.fill];
    var late7 = (bar === 7) && i >= fl[0][0];
    var late3 = (bar === 3) && a.fill3 && i >= 14;

    // drums: clean surf beat
    var kv = ((bar & 1) ? KB : KA)[i];
    if (a.drop) kv = (i === 0 || i === 8) ? 0.8 : 0;
    if (late7 || late3) kv = (late7 && i === 12 && a.fill !== 1) ? 0.6 : 0;
    if (kv) kick(s, tt, kv);

    var sv = (i === 4 || i === 12) ? 1 : 0;
    if (!a.drop && (bar & 1) && i === 14) sv = 0.12;   // ghost
    if (late7 || late3) sv = 0;
    if (sv) { if (a.drop) rim(s, tt, sv); else snare(s, tt, sv, false); }

    if (late7) {
      for (k = 0; k < fl.length; k++) {
        if (fl[k][0] !== i) continue;
        if (fl[k][1] === 's') snare(s, tt, fl[k][2], false); else tom(s, tt, fl[k][1], fl[k][2]);
      }
    }
    if (late3) tom(s, tt, i === 14 ? 0 : 1, i === 14 ? 0.55 : 0.7);

    if (!late7 && (i & 1) === 0) {
      var open = !a.drop && bar === 5 && i === 14;
      hat(s, tt, open ? 0.5 : (a.drop ? 0.3 : (i % 4 === 0 ? 0.6 : 0.42)), open);
    }
    if (step === 0 && s.loops > 0) crash(s, t, a.drop ? 0.25 : 0.4);

    // bass: root-fifth in the first half (and breakdowns), walking in the second half
    var r = BASE.roots[ci];
    if (bar < 4 || a.drop) {
      for (k = 0; k < BASSRF.length; k++) {
        if (BASSRF[k][0] === i) bass(s, tt, mf(r + BASSRF[k][1]), BASSRF[k][2] * sd * 0.92, BASSRF[k][3], false);
      }
    } else if ((i & 3) === 0) {
      var b = i >> 2, nr = BASE.roots[(ci + 1) & 3];
      var n = b === 0 ? r : b === 1 ? r + BASE.third[ci] : b === 2 ? r + 7 : nr + (nr > r ? -1 : 1);
      bass(s, tt, mf(n), 3.4 * sd, b === 0 ? 1 : 0.8, false);
    }

    // rhythm guitar
    var ch = BASE.gtr[ci];
    if (a.uke) {
      if (i === 0) strum(s, t, ch, 6 * sd, 0.75, false);
    } else if (bar < 4) {
      if (i === 0) strum(s, t, ch, 7 * sd, 1, false);
      else if (i === 10) strum(s, tt, ch, 3 * sd, 0.6, true);
    } else {
      if (i === 0) strum(s, t, ch, 3 * sd, 0.9, false);
      else if (i === 6) strum(s, tt, ch, 2 * sd, 0.5, true);
      else if (i === 10) strum(s, tt, ch, 5 * sd, 0.75, false);
    }

    if (a.uke) {
      for (k = 0; k < UKE.length; k++) {
        if (UKE[k][0] === i) uke(s, tt, BASE.uke[ci], 2 * sd, (i === 0 ? 1 : 0.75), !!UKE[k][1]);
      }
    }
    if (a.organ && i === 0) organ(s, t, BASE.org[ci], 15.6 * sd, 1);

    if (a.lead) {
      var ph = a.lead[bar];
      for (k = 0; k < ph.length; k++) {
        if (ph[k][0] === i) lead(s, tt, ph[k][1], ph[k][2] * sd * 0.95, 1, false);
      }
    }

    if (a.wash && (step === 0 || step === 64)) wash(s, t + 0.2, 4.5);
  }

  var BON = {
    roots: [43, 48, 50, 48, 43, 40, 48, 50],                            // G C D C | G Em C D
    chop:  [[55, 62, 67], [60, 67, 72], [62, 69, 74], [60, 67, 72], [55, 62, 67], [52, 59, 64], [60, 67, 72], [62, 69, 74]]
  };
  var BPAT = [0, 0, 12, 0, 7, 0, 12, 7];   // driving eighth-note bass, per eighth
  // tremolo-picked lead: [step, midi, length in steps]; length 1 = single fast pick (runs)
  var BLEAD = [
    [[0, 67, 4], [4, 71, 4], [8, 74, 6], [14, 76, 2]],
    [[0, 79, 6], [6, 76, 2], [8, 72, 8]],
    [[0, 74, 4], [4, 78, 4], [8, 81, 6], [14, 79, 2]],
    [[0, 76, 8], [8, 79, 1], [9, 76, 1], [10, 74, 1], [11, 72, 1], [12, 71, 1], [13, 69, 1], [14, 67, 1], [15, 64, 1]],
    [[0, 79, 2], [2, 79, 2], [4, 83, 4], [8, 81, 4], [12, 79, 4]],
    [[0, 76, 4], [4, 79, 4], [8, 83, 8]],
    [[0, 84, 4], [4, 83, 2], [6, 81, 2], [8, 79, 4], [12, 76, 4]],
    [[0, 78, 4], [4, 81, 4], [8, 74, 1], [9, 76, 1], [10, 78, 1], [11, 79, 1], [12, 81, 1], [13, 83, 1], [14, 84, 1], [15, 86, 1]]
  ];
  var BFILL7 = [0, 0, 1, 1, 2, 2, 3, 3];

  function stepBonus(s, step, t) {
    var bar = step >> 4, i = step & 15, sd = s.sd, k;
    var fill = (bar === 3 || bar === 7);
    var roll = (bar === 7 && i >= 8) || (bar === 3 && i >= 12);
    var rhythmOnly = (s.loops & 1) && bar < 4;   // odd loops: first half is a rhythm-guitar feature

    var kv = (i === 0 || i === 8) ? 1 : (i === 6) ? 0.55 : ((bar & 1) && i === 10) ? 0.5 : 0;
    if (roll) kv = (i === 8 || i === 12) ? 0.8 : 0;
    if (kv) kick(s, t, kv);

    var sv = (i === 4 || i === 12) ? 1 : (i === 7) ? 0.18 : (i === 15 && !fill) ? 0.15 : 0;
    if (roll) sv = 0;
    if (sv) snare(s, t, sv, true);
    if (roll) {
      if (bar === 7) tom(s, t, BFILL7[i - 8], 0.5 + 0.5 * (i - 8) / 7);
      else if (i === 12 || i === 13) snare(s, t, i === 12 ? 0.9 : 0.6, true);
      else tom(s, t, i === 14 ? 2 : 3, i === 14 ? 0.8 : 1);
    }

    if (!roll) {
      if ((i & 3) === 2) hat(s, t, 0.55, true);          // open hats on the off-beats
      else hat(s, t, (i & 1) ? 0.15 : 0.4, false);
    }
    if (i === 0 && (bar === 0 || bar === 4)) crash(s, t, bar === 0 ? 0.55 : 0.35);

    if ((i & 1) === 0) bass(s, t, mf(BON.roots[bar] + BPAT[i >> 1]), sd * 1.6, i % 4 === 0 ? 1 : 0.8, true);

    var ch = BON.chop[bar];
    if (rhythmOnly) {
      if (i === 0) strum(s, t, ch, 3 * sd, 1, false);
      else if ((i & 3) === 2) strum(s, t, ch, 0.8 * sd, 0.8, (i & 4) !== 0);
    } else if ((i & 3) === 2 && !roll) {
      strum(s, t, ch, 0.6 * sd, 0.45, false);
    }

    if (!rhythmOnly) {
      var ph = BLEAD[bar];
      for (k = 0; k < ph.length; k++) {
        if (ph[k][0] !== i) continue;
        if (ph[k][2] === 1) lead(s, t, ph[k][1], sd * 0.9, 0.85, true);
        else tremLead(s, t, ph[k][1], ph[k][2] * sd * 0.97, 1, sd / 2);
      }
    }
  }

  // ---------- sequencer ----------
  function makeSeq(mode, bpm, tremHz) {
    var g = ctx.createGain(); g.gain.value = 0.0001; g.connect(N.musicBus);
    var trim = ctx.createGain(); trim.gain.value = 0.7; trim.connect(g);
    var sh = ctx.createWaveShaper(); sh.curve = curveSoft; sh.oversample = '2x'; sh.connect(trim);
    var spring = makeSpring(g, 1, [0.72, 0.7, 0.68]);
    // guitar bus: tremolo (gain wobble) then dry + spring
    var gtr = ctx.createGain(); gtr.gain.value = 1;
    var trem = ctx.createGain(); trem.gain.value = 0.84;
    gtr.connect(trem); trem.connect(g); trem.connect(spring);
    var lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = tremHz;
    var depth = ctx.createGain(); depth.gain.value = 0.14;
    lfo.connect(depth); depth.connect(trem.gain); lfo.start();
    // pad bus (organ, ukulele): dry + a little spring
    var pad = ctx.createGain(); pad.gain.value = 1; pad.connect(g);
    var ps = ctx.createGain(); ps.gain.value = 0.35; pad.connect(ps); ps.connect(spring);
    return { mode: mode, bpm: bpm, sd: 60 / bpm / 4, gain: g, drums: sh, gtr: gtr, pad: pad, arr: null,
             active: false, step: 0, nextTime: 0, stopAt: 0, loops: 0 };
  }

  function tick() {
    if (!ctx) return;
    var t = ctx.currentTime;
    for (var key in seqs) {
      var s = seqs[key];
      if (!s.active) continue;
      if (s.stopAt && t > s.stopAt + 0.1) { s.active = false; s.stopAt = 0; continue; }
      if (s.nextTime < t - 0.2) s.nextTime = t + 0.03;   // resync after tab throttling
      var guard = 0;
      while (s.nextTime < t + LOOKAHEAD && guard++ < 64) {
        if ((!s.stopAt || s.nextTime < s.stopAt) && !muted && ctx.state === 'running') {
          try { (s.mode === 'base' ? stepBase : stepBonus)(s, s.step, s.nextTime); }
          catch (e) { if (root.console) root.console.warn('[MangoAudio] step', e); }
        }
        s.nextTime += s.sd;
        s.step = (s.step + 1) % 128;
        if (s.step === 0) s.loops++;
      }
    }
    if (!stats.leakWarned && (voices.sfx.length > CAP.sfx * 3 || voices.music.length > CAP.music * 3)) {
      stats.leakWarned = true;
      if (root.console) root.console.warn('[MangoAudio] voice list growing: sfx=' + voices.sfx.length + ' music=' + voices.music.length);
    }
  }

  function startSeq(s, at, fadeIn) {
    if (!s.active) { s.active = true; s.step = 0; s.loops = 0; s.arr = null; s.nextTime = at; }
    s.stopAt = 0;
    var h = s.gain.gain;
    holdAt(h, at);
    h.linearRampToValueAtTime(1, at + Math.max(fadeIn, 0.01));
  }
  function fadeSeq(s, from, to) {
    var g = s.gain.gain;
    holdAt(g, from);
    g.linearRampToValueAtTime(0.0001, to);
    s.stopAt = to;
  }
  // from-seq fades over [fadeStart, fadeEnd]; to-seq starts at step 0 at startAt.
  function switchMode(mode, fadeStart, fadeEnd, startAt, fadeIn) {
    if (mode === curMode) return;
    var from = seqs[curMode], to = seqs[mode];
    curMode = mode;
    lpTo(startAt);
    if (!musicOn) return;
    if (from.active) fadeSeq(from, fadeStart, fadeEnd);
    startSeq(to, startAt, fadeIn);
  }

  // ---------- public: control ----------
  function init() {
    if (ctx) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(noop);
      return true;
    }
    if (!AC) return false;
    ctx = new AC();
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
    N.sfxVol = ctx.createGain(); N.sfxVol.gain.value = sfxVolume; N.sfxVol.connect(N.comp);
    N.sfxBus = ctx.createGain(); N.sfxBus.gain.value = 1; N.sfxBus.connect(N.sfxVol);
    N.sfxSpring = makeSpring(N.sfxBus, 0.8, [0.7, 0.68, 0.66]);

    var len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    curveSoft = makeCurve(1.1);
    curveHard = makeCurve(4);

    seqs.base = makeSeq('base', BASE_BPM, 5.2);
    seqs.bonus = makeSeq('bonus', BONUS_BPM, 7);
    setInterval(tick, TICK_MS);
    return true;
  }

  function startMusic() {
    if (!ctx || musicOn) return;
    musicOn = true;
    var t = tNow(0.06), other = seqs[curMode === 'base' ? 'bonus' : 'base'];
    if (other.active && !other.stopAt) fadeSeq(other, t, t + 0.3);
    startSeq(seqs[curMode], t, 0.25);
  }

  function stopMusic() {
    if (!ctx || !musicOn) return;
    musicOn = false;
    var t = ctx.currentTime;
    for (var key in seqs) if (seqs[key].active) fadeSeq(seqs[key], t, t + 0.4);
  }

  function setMode(mode) {
    if (mode !== 'base' && mode !== 'bonus') return;
    if (!ctx) { curMode = mode; return; }
    var t = tNow(0.03), beat = 60 / seqs[curMode].bpm;
    switchMode(mode, t, t + beat, t, beat);
  }

  function stopAntic(fade) {
    if (!antic) return;
    var a = antic; antic = null;
    clearTimeout(a.timer);
    if (a.rel) { a.rel(); a.rel = null; }   // let the main music come back up
    if (a.v.done) return;
    var now = ctx.currentTime;
    holdAt(a.grp.gain, now);
    a.grp.gain.linearRampToValueAtTime(0.0001, now + fade);
    for (var i = 0; i < a.v.sources.length; i++) {
      try { a.v.sources[i].stop(now + fade + 0.02); } catch (e) { /* ignore */ }
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

  // ---------- public: game feedback ----------
  function spinStart() {   // short wave whoosh: filtered noise that swells and rolls away
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    var g = gn(v, v.out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    var bp = filt(v, 'bandpass', 350, 0.8, g);
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + 0.18);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.46);
    noise(v, t, t + 0.5, bp);
    var lg = gn(v, v.out);                                   // body of the water
    lg.gain.setValueAtTime(0.0001, t);
    lg.gain.linearRampToValueAtTime(0.18, t + 0.12);
    lg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    noise(v, t, t + 0.42, filt(v, 'lowpass', 500, 0.7, lg));
    var sg = gn(v, v.out); envAD(sg.gain, t + 0.1, 0.06, 0.035, 0.2);   // spray at the crest
    noise(v, t + 0.1, t + 0.4, filt(v, 'highpass', 5000, 0.7, sg));
  }

  var PLOP = [62, 64, 67, 69, 71];   // D E G A B: G major pentatonic, one per reel
  function reelStop(i) {   // soft water plop on a wooden knock
    if (!ok()) return;
    i = Math.round(clamp(i, 0, 4));
    var v = sfxVoice(), t = tNow();
    var f = mf(PLOP[i]) * (1 + (Math.random() - 0.5) * 0.02);
    var g = gn(v, v.out); envAD(g.gain, t, 0.002, 0.15, 0.07);            // bubble: pitch rises like a drop
    osc(v, 'sine', f * 0.7, t, t + 0.1, g, f * 1.25, 0.05);
    var wg = gn(v, v.out); envAD(wg.gain, t, 0.002, 0.11, 0.06);          // soft wooden knock
    osc(v, 'triangle', f / 2, t, t + 0.09, filt(v, 'lowpass', 1200, 0.7, wg));
    var tg = gn(v, v.out); envAD(tg.gain, t, 0.002, 0.14, 0.08);          // low thud
    osc(v, 'sine', 110 * Math.pow(2, i / 12), t, t + 0.11, tg, 70, 0.06);
    var ng = gn(v, v.out); envAD(ng.gain, t + 0.02, 0.001, 0.03, 0.02);   // droplet
    noise(v, t + 0.02, t + 0.06, filt(v, 'bandpass', f * 3, 2, ng));
  }

  var SCATTER = [74, 76, 79, 83, 86];  // D5 E5 G5 B5 D6: G major, n=3 lands on the tonic G
  function scatterLand(n) {
    if (!ok()) return;
    n = Math.round(clamp(n, 1, 5));
    if (n < 2) return;                      // first SURF badge is silent; the chime starts at the 2nd
    var v = sfxVoice(), t = tNow(), f = mf(SCATTER[n - 1]);
    var peak = 0.26 + 0.03 * (n - 1);
    bell(v, t, f, peak, 0.9 + 0.15 * n);
    pan(v, t, f / 2, 0.5, peak * 0.35);
    if (n >= 3) {                           // arrival: sparkle and a low octave for weight
      bell(v, t + 0.06, f * 1.5, peak * 0.4, 0.6);
      bell(v, t + 0.12, f * 2, peak * 0.3, 0.5);
      var lg = gn(v, v.out); envAD(lg.gain, t, 0.004, 0.14, 1.2);
      osc(v, 'sine', f / 2, t, t + 1.25, lg);
    }
  }

  // Tension loop while the last reels spin after 2 bonus badges: the main music dips and a tense surf groove
  // plays until the last reel lands (anticipation(false)). A tremolo-picked guitar on the F#-C tritone over a
  // pulsing D pedal (D7: it wants to resolve but never does) rubbing up to Eb, a heartbeat kick, ticking hats
  // and a wave noise that keeps rising. Hard stop after 12 s in case nobody calls off.
  function anticipation(on) {
    if (!on) { if (ctx) stopAntic(0.25); return; }
    if (!ok() || antic) return;
    var v = sfxVoice(), t = tNow(), MAX = 12, end = t + MAX, step = 60 / 152 / 2;   // eighth notes at 152 bpm
    var pick = 60 / 152 / 6;                                                         // sextuplet tremolo picks
    var grp = gc(v, 1, v.out), rel = acquireDuck();
    send(v, grp, 0.35);
    // pulsing bass pedal: D2 D2 D2 Eb2
    var bg = gn(v, grp);
    var bo = osc(v, 'sawtooth', mf(38), t, end, filt(v, 'lowpass', 480, 4, bg));
    // tremolo-picked guitar: F#4 + C5, opening up over ~4 s
    var gg = gn(v, grp);
    var pk = v.add(ctx.createBiquadFilter());
    pk.type = 'peaking'; pk.frequency.value = 1400; pk.Q.value = 1.2; pk.gain.value = 5; pk.connect(gg);
    var glp = filt(v, 'lowpass', 900, 1.2, pk);
    glp.frequency.setValueAtTime(900, t); glp.frequency.exponentialRampToValueAtTime(3200, t + 4);
    osc(v, 'sawtooth', mf(66), t, end, glp, 0, 0, -6);
    osc(v, 'sawtooth', mf(72), t, end, glp, 0, 0, 6);
    osc(v, 'square', mf(66), t, end, gc(v, 0.25, glp));
    // rising wave noise with a slow swell
    var wg = gn(v, grp);
    wg.gain.setValueAtTime(0.0001, t); wg.gain.linearRampToValueAtTime(0.06, t + 6);
    var wsw = gc(v, 0.7, wg);
    osc(v, 'sine', 0.6, t, end, gc(v, 0.3, wsw.gain));
    var wbp = filt(v, 'bandpass', 250, 1.2, wsw);
    wbp.frequency.setValueAtTime(250, t); wbp.frequency.exponentialRampToValueAtTime(2600, t + 8);
    noise(v, t, end, wbp);
    // ticking hats and a heartbeat kick
    var hg = gn(v, grp);
    noise(v, t, end, filt(v, 'highpass', 7000, 0.7, hg));
    var hb = gn(v, grp);
    var ho = osc(v, 'sine', 60, t, end, filt(v, 'lowpass', 400, 0.7, hb));
    var i = 0, tp = t;
    while (tp < end - 0.05) {
      var onBeat = i % 2 === 0, prog = Math.min(1, (tp - t) / 4);
      bo.frequency.setValueAtTime(mf(i % 4 === 3 ? 39 : 38), tp);
      envAD(bg.gain, tp, 0.005, (onBeat ? 0.22 : 0.15) * (0.8 + 0.35 * prog), step * 0.8);
      envAD(hg.gain, tp, 0.001, onBeat ? 0.075 : 0.04, 0.035);
      if (i % 4 === 0) {
        ho.frequency.setValueAtTime(95, tp); ho.frequency.exponentialRampToValueAtTime(48, tp + 0.09);
        ho.frequency.setValueAtTime(85, tp + 0.16); ho.frequency.exponentialRampToValueAtTime(46, tp + 0.24);
        envAD(hb.gain, tp, 0.006, 0.26, 0.13); envAD(hb.gain, tp + 0.16, 0.006, 0.17, 0.12);
      }
      for (var p = 0; p < 3; p++) {
        var tq = tp + p * pick;
        if (tq >= end - 0.05) break;
        envAD(gg.gain, tq, 0.002, (p === 0 ? 0.06 : 0.046) * (0.35 + 0.65 * prog), pick * 0.9);
      }
      tp += step; i++;
    }
    grp.gain.setValueAtTime(1, end - 0.3); grp.gain.exponentialRampToValueAtTime(0.0001, end);
    antic = { v: v, grp: grp, rel: rel, timer: setTimeout(function () { stopAntic(0.3); }, MAX * 1000) };
  }

  var WILD = [55, 57, 59, 62, 64, 67, 69, 71, 74, 76];  // G major pentatonic ladder
  function wildLand(mult) {   // splashy rising glide; higher, longer and wetter for bigger multipliers
    if (!ok()) return;
    var p = clamp(log2(Math.max(1, +mult || 1)), 0, 7);
    var v = sfxVoice(), t = tNow();
    var f = mf(WILD[Math.min(WILD.length - 1, Math.round(p * 1.3))]);
    var dur = 0.25 + p * 0.05, gl = dur * 0.7;
    thump(v, t, 0.25);
    splash(v, t, 0.12 + 0.02 * p, 0.25 + 0.06 * p);
    var g = gn(v, v.out); envAD(g.gain, t, 0.01, 0.13 + 0.012 * p, dur);
    send(v, g, 0.5);
    var lp = filt(v, 'lowpass', 1600 * Math.pow(2, p * 0.4), 1.2, g);
    osc(v, 'triangle', f * 0.75, t, t + dur + 0.05, lp, f * 2, gl);
    osc(v, 'sawtooth', f * 0.75, t, t + dur + 0.05, gc(v, 0.35, lp), f * 2, gl, 6);
    if (p >= 2) pan(v, t + gl, f * 2, 0.4 + 0.05 * p, 0.12);
    if (p >= 4) { pan(v, t + gl + 0.04, f * 3, 0.4, 0.08); cymbal(v, t + gl, 0.07, 0.5); }
  }

  function win(x) {
    if (!ok()) return;
    x = +x;
    if (!(x > 0) || !isFinite(x)) return;
    if (x < 1) { neutralTick(); return; }   // honest design: a net loss never gets a celebration
    var s = log10(x), t = tNow();
    if (x < 5) {
      arp(t, 0, 3 + Math.floor(s * 3), 0.085 - 0.012 * s, 0.26, 0.25 + 0.35 * s);
      return;
    }
    if (x < 20) {
      var a = arp(t, Math.floor(s), Math.min(8, 5 + Math.floor((s - 0.7) * 5)), 0.07 - 0.008 * s, 0.24, 0.5);
      var v = sfxVoice();
      panChord(v, a.tEnd, 12 * Math.floor((a.lastMidi - 7) / 12) + 7, 0.5 + 0.3 * s, 0.08);
      cymbal(v, a.tEnd, 0.16, 1.2 + 0.3 * s);
      return;
    }
    bigWin(s, t);
  }

  function bigWin(s, t) {
    var L = Math.min(3.2, 1.4 + 0.55 * (s - 1.3));
    var v = sfxVoice();
    duckFor(L + 0.4);
    thump(v, t, 0.3);
    splash(v, t, 0.16, 0.6);
    cymbal(v, t, 0.18, 2 + 0.3 * s);
    gchord(v, t, [43, 50, 55, 59, 62, 67], L * 0.55, 0.26);
    var start = Math.min(2 + Math.floor(s - 1.3), 4);
    var cnt = Math.min(LADDER.length - start, 5 + Math.round(s * 1.5));
    for (var k = 0; k < cnt; k++) pan(v, t + 0.1 + k * 0.055, mf(LADDER[start + k]), 0.12, 0.14);
    var tf = t + 0.1 + cnt * 0.055 + 0.05;
    var ring = Math.max(0.8, L - (tf - t) + 0.8);
    var bells = [79, 83, 86, 91];
    for (var b = 0; b < bells.length; b++) bell(v, tf + b * 0.02, mf(bells[b]), 0.07, ring);
    if (s >= 2) {
      gchord(v, tf, [55, 59, 62, 67, 71], Math.max(0.4, L - (tf - t)), 0.2);
      cymbal(v, tf, 0.12, 1.6);
    }
  }

  var TICKS = [67, 69, 71, 74, 76, 79, 81, 83, 86, 88, 91, 93, 95];   // G major pentatonic, G4 up
  function coinTick(dest, t, midi, peak, accent) {
    var v = newVoice('sfx', dest), f = mf(midi);
    mar(v, v.out, t, f, peak * 0.9, 0.09);
    if (accent) {                                         // steel-drum shimmer every 4th tick
      var g = gn(v, v.out); envAD(g.gain, t, 0.002, peak * 0.3, 0.12);
      osc(v, 'sine', f * 2, t, t + 0.15, g, 0, 0, 4);
    }
  }
  function resolveChord(t, x) {
    var v = sfxVoice(), ns = [67, 71, 74, 79];
    for (var i = 0; i < ns.length; i++) pan(v, t + i * 0.015, mf(ns[i]), 1.3, 0.12);
    bell(v, t, mf(91), 0.05, 1.2);
    if (x >= 5) { cymbal(v, t, 0.12, 1.2); splash(v, t, 0.08, 0.5); }
    if (x >= 20) thump(v, t, 0.25);
  }

  function countUp(durationMs, x) {
    if (!ok()) return noop;
    var D = clamp((+durationMs || 0) / 1000, 0.2, 30);
    x = +x || 0;
    var s = x > 1 ? Math.min(log10(x), 3) : 0;
    var t0 = tNow(0.03), end = t0 + D, next = t0, done = false, n = 0;
    var i0 = Math.round(s * 2);                // bigger wins start higher on the ladder
    var grp = ctx.createGain(); grp.gain.value = 1; grp.connect(N.sfxBus);
    var releaseDuck = acquireDuck();
    var timer = null;

    function finish(at, chord) {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (chord && !muted) resolveChord(at, x);
      var ms = Math.max(0, (at - ctx.currentTime) * 1000) + 300;
      setTimeout(function () { releaseDuck(); try { grp.disconnect(); } catch (e) { /* ignore */ } }, ms);
    }
    function pump() {
      if (done) return;
      try {
        var lim = ctx.currentTime + 0.1;
        while (next < lim && next < end) {
          var p = (next - t0) / D;
          var idx = Math.min(TICKS.length - 1, i0 + Math.floor(p * 7.99));   // climbs ~1.5 octaves
          if (!muted) coinTick(grp, next, TICKS[idx],0.13 + 0.03 * p, (n & 3) === 0);
          n++;
          next += 0.075 - 0.028 * p;   // ticks speed up slightly
        }
        if (next >= end) finish(end, true);
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

  function bonusTrigger() {   // a wave builds, a guitar slides up and runs, then the wave crashes on a G chord
    if (!ok()) return;
    var v = sfxVoice(), t = tNow(0.02), T = 1.25, h = t + T;
    var rg = gn(v, v.out);                                   // wave building
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.linearRampToValueAtTime(0.22, h);
    rg.gain.linearRampToValueAtTime(0.0001, h + 0.06);
    var lp = filt(v, 'lowpass', 300, 1, rg);
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(3500, h);
    noise(v, t, h + 0.1, lp);
    var gv = gc(v, 1, v.out);                                // guitar: slide up D3 -> G4, then a pentatonic run
    send(v, gv, 0.6);
    pluck(v, gv, t + 0.3, mf(67), 0.42, 0.13, { from: mf(50), glide: 0.38, sus: 0.6 });
    var run = [62, 64, 67, 69, 71, 74, 76, 79];
    for (var k = 0; k < run.length; k++) pluck(v, gv, h - 0.48 + k * 0.06, mf(run[k]), 0.06, 0.09, { bright: true });
    thump(v, h, 0.4);                                        // the crash
    waveCrash(v, h, 0.3, 2.2);
    cymbal(v, h, 0.16, 1.8);
    var sv = sfxVoice();
    var g = gn(sv, sv.out); envAD(g.gain, h, 0.004, 0.22, 1.2);
    send(sv, g, 0.5);
    var slp = filt(sv, 'lowpass', 3500, 1, g);
    var dr = gc(sv, 0.4, shaper(sv, curveHard, slp));
    var power = [43, 50, 55, 62, 67];                        // G5 power chord
    for (var i = 0; i < power.length; i++) osc(sv, 'sawtooth', mf(power[i]), h, h + 1.3, dr);
    if (musicOn) switchMode('bonus', t, h, h, 0.01);
    else curMode = 'bonus';
  }

  function bonusSpinWin(x) {
    if (!ok()) return;
    x = +x;
    if (!(x > 0) || !isFinite(x)) return;
    if (x < 1) { neutralTick(); return; }
    var s = log10(x), t = tNow();
    arp(t, Math.min(1 + Math.floor(s), 4), Math.min(5, 2 + Math.floor(s * 2)), 0.06, 0.18, 0.2 + 0.2 * s);
    if (x >= 20) { var v = sfxVoice(); cymbal(v, t, 0.1, 0.8); }
  }

  function bonusEnd(x) {
    if (!ctx) return;
    x = +x || 0;
    var t = tNow(0.02), L = 0.8;
    if (ok()) {
      var s = x >= 1 ? Math.min(log10(x), 3.5) : 0, v = sfxVoice();
      if (x < 1) {
        wipe(v, t, 0.4);                                    // the ride is over: gentle wipe-out, no fanfare
        L = 1.2;
      } else {
        var gv = gc(v, 1, v.out); send(v, gv, 0.5);
        var tr = 0.11;                                       // triplet pickup D D D
        for (var k = 0; k < 3; k++) pluck(v, gv, t + k * tr, mf(62), 0.07, 0.14, { bright: true });
        var tm = t + 3 * tr, h1 = 0.5 + 0.2 * s;
        gchord(v, tm, [55, 59, 62, 67], h1, 0.28);
        thump(v, tm, 0.3);
        splash(v, tm, 0.1, 0.5);
        cymbal(v, tm, 0.14 + 0.02 * s, 1.2 + 0.3 * s);
        L = 3 * tr + h1 + 0.4;
        if (s >= 1) {                                        // x >= 10: climb to the octave
          var t2 = tm + h1;
          pluck(v, gv, t2, mf(62), 0.08, 0.14, { bright: true });
          pluck(v, gv, t2 + 0.1, mf(64), 0.08, 0.14, { bright: true });
          pluck(v, gv, t2 + 0.2, mf(66), 0.08, 0.14, { bright: true });
          var t3 = t2 + 0.3, h2 = 0.7 + 0.3 * s;
          gchord(v, t3, [67, 71, 74, 79], h2, 0.3);
          thump(v, t3, 0.32);
          cymbal(v, t3, 0.18, 1.8 + 0.3 * s);
          L = t3 - t + h2 + 0.5;
          if (s >= 2) {                                      // x >= 100: tom roll + steel-drum sparkle
            var v2 = sfxVoice();
            for (var r = 0; r < 10; r++) thump(v2, t3 + r * 0.07, 0.08 + 0.015 * r);
            for (var b = 0; b < 6; b++) pan(v2, t3 + 0.1 + b * 0.05, mf(LADDER[4 + b]), 0.1, 0.1);
          }
        }
      }
      duckFor(L);
    }
    if (musicOn && curMode === 'bonus') {
      var fs = t + L * 0.7, beat = 60 / seqs.base.bpm;
      switchMode('base', fs, fs + beat, fs, beat);
    } else if (!musicOn) {
      curMode = 'base';
    }
  }

  function bail() {
    if (!ok()) return;
    var v = sfxVoice(), t = tNow();
    wipe(v, t, 1);
  }

  function debug() {
    return {
      state: ctx ? ctx.state : 'none', mode: curMode, musicOn: musicOn, muted: muted,
      sfxVoices: voices.sfx.length, musicVoices: voices.music.length,
      created: stats.created, stolen: stats.stolen, ducking: duckCount
    };
  }

  root.MangoAudio = {
    init: safe(init, false),
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
    _debug: debug
  };
})(typeof window !== 'undefined' ? window : null);
