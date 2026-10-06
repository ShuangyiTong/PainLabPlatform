/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  view-controller.js — minimal active-view lifecycle.

  Tabs are switched by toggling `display` (see switchTab in renderer.js). This
  controller adds the missing piece: an explicit notion of which view is
  "active", with onActivate/onDeactivate hooks. Heavy per-view work (chart
  rendering, polling, timers) registers here so it can be switched off while a
  view is hidden and back on when it is shown — without each subsystem having
  to know how tab switching works.

  Exposed as the global `ViewController`.

  Usage:
    ViewController.register('device-detail-tab', {
      onActivate:   () => ChartManager.setTabActive(true),
      onDeactivate: () => ChartManager.setTabActive(false),
    });
    ViewController.activate('device-detail-tab');   // called from switchTab()
*/
(function () {
  const views = new Map();   // viewId -> { onActivate?, onDeactivate? }
  let current = null;

  const ViewController = {
    register(viewId, hooks) {
      views.set(viewId, hooks || {});
    },

    activate(viewId) {
      if (viewId === current) return;
      const prev = current && views.get(current);
      if (prev && prev.onDeactivate) prev.onDeactivate();
      current = viewId;
      const next = views.get(viewId);
      if (next && next.onActivate) next.onActivate();
    },

    current() { return current; },
  };

  self.ViewController = ViewController;
})();
