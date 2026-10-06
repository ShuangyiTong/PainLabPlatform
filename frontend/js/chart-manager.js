/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  chart-manager.js — main-thread facade for the off-thread chart worker.

  Responsibilities:
    * spin up the single rendering Worker (lazily, on first chart),
    * hand each <canvas> to the worker once via transferControlToOffscreen(),
    * forward new samples as small transferable Float64 batches,
    * keep each chart's backing store in sync with its element (ResizeObserver),
    * gate rendering on visibility via a (tabActive AND deviceExpanded) policy,
      so hidden charts cost zero render time yet stay current for when shown.

  Exposed as the global `ChartManager` (this app has no module bundler).
*/
(function () {
  // Distinct, muted line colours (r,g,b,a in 0..1) for multi-series charts.
  const PALETTE = [
    [0.30, 0.61, 0.80, 1.0],  // blue
    [0.89, 0.45, 0.36, 1.0],  // coral
    [0.46, 0.72, 0.47, 1.0],  // green
    [0.55, 0.46, 0.78, 1.0],  // violet
    [0.93, 0.69, 0.27, 1.0],  // amber
  ];

  let worker = null;
  let workerInitFailed = false;
  let tabActive = true;        // is the charts' host tab the visible one?
  const charts = new Map();    // chartId -> { id, el, deviceId, expanded, active, ro }

  function log(message) {
    if (typeof appendLog === 'function') appendLog(message);
    else console.error(message);
  }

  // Lazily start the single render worker. Returns null (once) on failure so a
  // blocked/missing worker can never throw out into the caller — e.g. the
  // connect mutex in new-descriptor must always reach its release().
  function ensureWorker() {
    if (worker || workerInitFailed) return worker;
    try {
      worker = new Worker('frontend/js/chart-worker.js');
    } catch (e) {
      workerInitFailed = true;
      log('chart worker failed to start: ' + (e.message || e));
      return null;
    }
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'error') log('[chart ' + m.chartId + '] ' + m.message);
    };
    worker.onerror = (e) => log('[chart worker] ' + (e.message || e));
    return worker;
  }

  function measure(el) {
    return { w: el.clientWidth, h: el.clientHeight, dpr: self.devicePixelRatio || 1 };
  }

  function computeActive(c) { return tabActive && c.expanded; }

  // Recompute a chart's visibility; on a false->true edge, re-sync its size
  // (it may have changed while hidden) before resuming the worker's draws.
  function refresh(c) {
    const next = computeActive(c);
    if (next === c.active) return;
    c.active = next;
    if (next) {
      const m = measure(c.el);
      if (m.w > 0 && m.h > 0) {
        worker.postMessage({ type: 'resize', chartId: c.id, width: m.w, height: m.h, dpr: m.dpr });
      }
    }
    worker.postMessage({ type: 'active', chartId: c.id, active: next });
  }

  const ChartManager = {
    /* Register a chart bound to an existing <canvas>. `seriesCount` >= 1.
       `yMin`/`yMax` may be null/undefined to auto-scale. */
    create(el, opts) {
      if (!ensureWorker()) return;
      const chartId = opts.chartId;
      if (charts.has(chartId)) return;

      const m = measure(el);
      const width  = m.w > 0 ? m.w : 300;   // fallbacks if created while hidden;
      const height = m.h > 0 ? m.h : 120;   // ResizeObserver corrects once shown.

      const series = [];
      const seriesCount = opts.seriesCount || 1;
      for (let i = 0; i < seriesCount; i++) series.push({ color: PALETTE[i % PALETTE.length] });

      let off;
      try {
        off = el.transferControlToOffscreen();
      } catch (e) {
        log('transferControlToOffscreen failed for ' + chartId + ': ' + (e.message || e));
        return;
      }

      worker.postMessage({
        type: 'create', chartId, canvas: off,
        width, height, dpr: m.dpr, series,
        yMin: (opts.yMin === undefined ? null : opts.yMin),
        yMax: (opts.yMax === undefined ? null : opts.yMax),
        windowMs: opts.windowMs || 10000,
        trueTime: !!opts.trueTime,
        maxPoints: opts.maxPoints || 1000,
      }, [off]);

      const c = { id: chartId, el, deviceId: opts.deviceId, expanded: true, active: true };
      charts.set(chartId, c);

      // Track element resizes (splitter drags / window resize). Skip 0-size
      // (hidden) so we never shrink the backing store to nothing.
      const ro = new ResizeObserver(() => {
        if (!computeActive(c)) return;
        const mm = measure(el);
        if (mm.w > 0 && mm.h > 0) {
          worker.postMessage({ type: 'resize', chartId, width: mm.w, height: mm.h, dpr: mm.dpr });
        }
      });
      ro.observe(el);
      c.ro = ro;

      refresh(c);  // align active flag with current tab/expanded state
    },

    /* Append samples to one series. `pairs` is an Array of [timestamp, value]. */
    push(chartId, seriesIdx, pairs) {
      const c = charts.get(chartId);
      if (!c || !pairs || pairs.length === 0) return;
      const data = new Float64Array(pairs.length * 2);
      for (let i = 0; i < pairs.length; i++) {
        data[i * 2]     = pairs[i][0];
        data[i * 2 + 1] = pairs[i][1];
      }
      worker.postMessage({ type: 'push', chartId, series: seriesIdx, data }, [data.buffer]);
    },

    has(chartId) { return charts.has(chartId); },

    /* The whole charts tab became visible/hidden. */
    setTabActive(active) {
      tabActive = !!active;
      for (const c of charts.values()) refresh(c);
    },

    /* One device's detail accordion expanded/collapsed. */
    setDeviceExpanded(deviceId, expanded) {
      for (const c of charts.values()) {
        if (c.deviceId === deviceId) { c.expanded = !!expanded; refresh(c); }
      }
    },

    /* Tear down every chart for a device (e.g. if its layout is rebuilt). */
    destroyDevice(deviceId) {
      for (const [id, c] of charts) {
        if (c.deviceId === deviceId) {
          if (c.ro) c.ro.disconnect();
          if (worker) worker.postMessage({ type: 'destroy', chartId: id });
          charts.delete(id);
        }
      }
    },
  };

  self.ChartManager = ChartManager;
})();
