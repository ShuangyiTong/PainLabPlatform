/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  chart-worker.js — off-main-thread line renderer.

  Runs in a dedicated Web Worker. Owns one OffscreenCanvas per chart (handed
  over once from the main thread via transferControlToOffscreen) plus a
  per-series rolling buffer. The main thread only posts small batches of new
  [timestamp, value] samples; all buffering, scaling and WebGL drawing happen
  here, off the UI thread. The chart composites to screen automatically — we
  never post pixels back.

  Message protocol (main -> worker):
    {type:'create',  chartId, canvas, width, height, dpr,
                     series:[{color:[r,g,b,a]}], yMin, yMax, windowMs}
    {type:'push',    chartId, series, data:Float64Array([t,v,t,v,...])}  // buffer transferred
    {type:'resize',  chartId, width, height, dpr}
    {type:'active',  chartId, active:boolean}    // pause/resume drawing (data still buffers)
    {type:'range',   chartId, yMin, yMax}        // null/null => auto-scale
    {type:'destroy', chartId}
  (worker -> main):
    {type:'error', chartId, message}

  Notes:
   * Timestamps are stored as float64; clip-space coordinates are recomputed on
     the CPU every frame so we never upload raw epoch-millis as float32 (which
     would lose ~0.1 s of precision around year-2026 magnitudes).
   * Frames are event-driven: a frame is scheduled only when data/size/active
     changes, then coalesced to one draw per animation frame. An idle chart
     consumes no CPU.
*/

'use strict';

// requestAnimationFrame is available in a dedicated worker that drives an
// OffscreenCanvas; fall back to a timer just in case a runtime lacks it.
const raf = (typeof self.requestAnimationFrame === 'function')
  ? self.requestAnimationFrame.bind(self)
  : (cb) => setTimeout(() => cb(Date.now()), 16);

const VERT_SRC =
  'attribute vec2 a_pos;' +
  'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }';

const FRAG_SRC =
  'precision mediump float;' +
  'uniform vec4 u_color;' +
  'void main() { gl_FragColor = u_color; }';

const DEFAULT_COLOR = [0.30, 0.61, 0.80, 1.0];

const charts = new Map();   // chartId -> Chart
let rafId = 0;

function schedule() {
  if (!rafId) rafId = raf(tick);
}

function tick() {
  rafId = 0;
  for (const chart of charts.values()) {
    if (chart.active && chart.dirty) {
      try {
        chart.draw();
      } catch (e) {
        postMessage({ type: 'error', chartId: chart.id, message: String((e && e.message) || e) });
      }
    }
  }
  // No auto-reschedule: the next push/resize/activate re-arms the loop.
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function makeProgram(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

class Series {
  constructor(gl, color) {
    this.color = color || DEFAULT_COLOR;
    this.t = [];                       // timestamps (float64 ms)
    this.v = [];                       // values     (float64)
    this.glBuffer = gl.createBuffer();
    this.clip = new Float32Array(0);   // scratch clip-space coords, grown on demand
  }

  append(data) {                       // data: Float64Array [t,v,t,v,...]
    for (let i = 0; i + 1 < data.length; i += 2) {
      this.t.push(data[i]);
      this.v.push(data[i + 1]);
    }
  }

  // Drop points older than `cutoff`, keeping the last stale one so the trace
  // still enters from the left edge. Amortized O(1): only a few expire/frame.
  trim(cutoff) {
    let drop = 0;
    const n = this.t.length;
    while (drop < n && this.t[drop] < cutoff) drop++;
    if (drop > 1) {
      this.t.splice(0, drop - 1);
      this.v.splice(0, drop - 1);
    }
  }

  // Keep only the most recent `max` samples (index / strip-chart mode).
  trimCount(max) {
    const over = this.t.length - max;
    if (over > 0) {
      this.t.splice(0, over);
      this.v.splice(0, over);
    }
  }
}

class Chart {
  constructor(msg) {
    this.id = msg.chartId;
    this.canvas = msg.canvas;
    this.dpr = msg.dpr || 1;
    this.setSize(msg.width, msg.height, this.dpr);

    const gl = this.canvas.getContext('webgl', {
      antialias: true, alpha: true, premultipliedAlpha: true, depth: false,
    });
    if (!gl) throw new Error('WebGL unavailable in worker');
    this.gl = gl;
    this.program = makeProgram(gl);
    this.a_pos = gl.getAttribLocation(this.program, 'a_pos');
    this.u_color = gl.getUniformLocation(this.program, 'u_color');
    gl.clearColor(0, 0, 0, 0);         // transparent — CSS background shows through

    const seriesCfg = (msg.series && msg.series.length) ? msg.series : [{}];
    this.series = seriesCfg.map((s) => new Series(gl, s.color));

    this.yMin = (msg.yMin === undefined) ? null : msg.yMin;
    this.yMax = (msg.yMax === undefined) ? null : msg.yMax;
    this.windowMs = msg.windowMs || 10000;
    this.trueTime = !!msg.trueTime;         // x = real timestamp; default is index (strip chart)
    this.maxPoints = msg.maxPoints || 1000; // index-mode rolling window size, in samples
    this.active = true;
    this.dirty = false;
    this.lastT = 0;
  }

  setSize(cssW, cssH, dpr) {
    this.dpr = dpr || this.dpr;
    this.cssW = Math.max(1, cssW | 0);
    this.cssH = Math.max(1, cssH | 0);
    this.canvas.width = Math.max(1, Math.round(this.cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.cssH * this.dpr));
  }

  push(seriesIdx, data) {
    const s = this.series[seriesIdx];
    if (!s) return;
    s.append(data);
    // advance lastT to the newest timestamp in this batch
    for (let i = data.length - 2; i >= 0; i -= 2) {
      if (data[i] > this.lastT) { this.lastT = data[i]; break; }
    }
    // bound memory even while paused (draw() won't run to trim if hidden)
    if (this.trueTime) s.trim(this.lastT - this.windowMs);
    else s.trimCount(this.maxPoints);
    this.dirty = true;
  }

  draw() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Resolve y-range: fixed (from descriptor) or auto-scaled to visible data.
    let yMin = this.yMin, yMax = this.yMax;
    if (yMin === null || yMax === null) {
      let lo = Infinity, hi = -Infinity;
      for (const s of this.series) {
        for (let i = 0; i < s.v.length; i++) {
          const val = s.v[i];
          if (val < lo) lo = val;
          if (val > hi) hi = val;
        }
      }
      if (lo === Infinity) { lo = -1; hi = 1; }
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08;
      yMin = lo - pad; yMax = hi + pad;
    }
    const ySpan = (yMax - yMin) || 1;

    // x-axis: in true-time mode samples map by real timestamp across the rolling
    // window; otherwise by sample index (strip chart) with the newest sample
    // pinned to the right edge — evenly spaced, so it scrolls smoothly.
    const timeMode = this.trueTime;
    const xMin = this.lastT - this.windowMs;
    const xSpan = this.windowMs || 1;
    const denom = (this.maxPoints > 1) ? (this.maxPoints - 1) : 1;

    gl.useProgram(this.program);
    for (const s of this.series) {
      const n = s.v.length;
      if (n < 2) continue;
      if (s.clip.length < n * 2) s.clip = new Float32Array(n * 2);
      const clip = s.clip;
      for (let i = 0; i < n; i++) {
        clip[i * 2]     = timeMode
          ? ((s.t[i] - xMin) / xSpan) * 2 - 1
          : 1 - 2 * ((n - 1) - i) / denom;
        clip[i * 2 + 1] = ((s.v[i] - yMin) / ySpan) * 2 - 1;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, s.glBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, clip.subarray(0, n * 2), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.a_pos);
      gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4fv(this.u_color, s.color);
      gl.drawArrays(gl.LINE_STRIP, 0, n);
    }
    this.dirty = false;
  }

  destroy() {
    const gl = this.gl;
    for (const s of this.series) gl.deleteBuffer(s.glBuffer);
    gl.deleteProgram(this.program);
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg) return;
  const chart = (msg.type !== 'create') ? charts.get(msg.chartId) : null;

  switch (msg.type) {
    case 'create':
      if (charts.has(msg.chartId)) return;
      try {
        charts.set(msg.chartId, new Chart(msg));
        schedule();
      } catch (e) {
        postMessage({ type: 'error', chartId: msg.chartId, message: String((e && e.message) || e) });
      }
      break;

    case 'push':
      if (chart) {
        chart.push(msg.series | 0, msg.data);
        if (chart.active) schedule();
      }
      break;

    case 'resize':
      if (chart) {
        chart.setSize(msg.width, msg.height, msg.dpr);
        chart.dirty = true;
        if (chart.active) schedule();
      }
      break;

    case 'active':
      if (chart) {
        chart.active = !!msg.active;
        if (chart.active) { chart.dirty = true; schedule(); }
      }
      break;

    case 'range':
      if (chart) {
        chart.yMin = (msg.yMin === undefined) ? null : msg.yMin;
        chart.yMax = (msg.yMax === undefined) ? null : msg.yMax;
        chart.dirty = true;
        if (chart.active) schedule();
      }
      break;

    case 'destroy':
      if (chart) { chart.destroy(); charts.delete(msg.chartId); }
      break;
  }
};
