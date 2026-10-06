/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  panel-collapse.js — collapsing the left panels and the log panel to zero.

  Each splitter gets a small chevron button that shuts the panel beside it, and
  dragging a splitter past a threshold does the same thing. The minimums that
  used to live in index.css (.panel-left's min-width, .panel-right-bottom's
  min-height) moved here, because a CSS minimum clamps the rendered box no
  matter what the drag writes inline — there was no way to reach zero with them
  in place. Enforcing them in onDrag instead keeps a sane floor while leaving
  zero reachable, and puts the number in one place rather than two.

  Collapsed panels keep a real box in the layout tree — width/height zero, never
  display:none — so every selector and every append in renderer.js keeps working
  against a hidden panel exactly as it does against a visible one.

  Two kinds of panel, differing in one structural way worth knowing before
  reading on. The width panels — the three left panels and the utility panel on
  the right edge — are each the element their own splitter drags, so collapsing
  one is just a matter of writing its width; they share everything below. The
  log panel is not: the horizontal splitter drags .tab-area *above* it, and the
  log absorbs whatever height is left. Collapsing the log therefore means
  handing its space to .tab-area, which is what .log-sizing in index.css does.

  The split inside the utility panel is the odd one out: it does not collapse at
  all, and only borrows the clamping half of this file so its drag cannot push
  either half out of the panel.

  Exposed as the global `PanelCollapse`; the hooks are handed to
  jquery-resizable from index.html.
*/
(function () {
    // Minimums, in the units jquery-resizable hands to onDrag: content widths
    // for the left and utility panels, and for the log the height of the slot
    // left under .tab-area. That slot used to carry 18px of margin and 2px of
    // border on top of the panel itself; now that the log is full-bleed the two
    // are the same measurement. 30px is roughly the height of .log-header, so
    // the shallowest the log gets before collapsing is about its own title.
    const LEFT_MIN_WIDTH = 50;
    const UTILITY_MIN_WIDTH = 50;
    const LOG_MIN_SLOT = 30;

    // Floor for both halves of the utility panel's own vertical split. Neither
    // half collapses, so this is a plain clamp rather than a snap threshold.
    const UTILITY_SPLIT_MIN = 60;

    // What a panel re-opens to when it was shut by dragging rather than by its
    // button. A drag leaves the panel sitting at the minimum, and re-opening to
    // a sliver that narrow would be useless; the button path remembers the size
    // the panel actually had instead.
    const LEFT_OPEN_WIDTH = '250px';
    const UTILITY_OPEN_WIDTH = '250px';
    const LOG_OPEN_HEIGHT = '180px';

    // Matches the transitions in index.css. Only used for the fallback timer
    // below, so it just has to be no shorter than the real animation.
    const ANIM_MS = 180;

    // .main-area-body, not .main-area: the vertical stack the log belongs to is
    // the inner wrapper now that the utility panel shares .main-area with it.
    const mainBody = document.querySelector('.main-area-body');
    const tabArea = document.querySelector('.tab-area');
    const logPanel = document.querySelector('.panel-right-bottom');
    // Scoped to a direct child: the utility panel's own split bar carries the
    // same .splitter-horizontal class, and an unscoped lookup would be relying
    // on nothing more than document order to tell the two apart.
    const logSplitter = document.querySelector('.main-area-body > .splitter-horizontal');
    let logToggle = null;

    const utilityPanel = document.querySelector('.utility-panel-right');
    const utilitySplitter = document.querySelector('.splitter-utility');
    const utilitySplitBar = document.querySelector('.splitter-utility-h');

    function isCollapsed(el) {
        return el.classList.contains('collapsed');
    }

    // ---- Toggle buttons --------------------------------------------------

    function makeToggle(modifier) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'panel-toggle ' + modifier;

        // The splitter starts a drag on mousedown/touchstart, and the button
        // sits inside it — without this, pressing the button would toggle the
        // panel *and* begin resizing it.
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('touchstart', (e) => e.stopPropagation());
        return btn;
    }

    function syncToggle(btn, collapsed, showLabel, hideLabel) {
        const label = collapsed ? showLabel : hideLabel;
        btn.classList.toggle('is-collapsed', collapsed);   // flips the chevron
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.setAttribute('aria-label', label);
        btn.title = label;
    }

    // ---- Panels that collapse sideways -----------------------------------

    // The left panels and the utility panel differ only in which edge they sit
    // on, so one implementation serves both; each registers its own toggle
    // button and its own two numbers here. State is per element, which is what
    // keeps the three tabs independent of each other and of the utility panel.
    const widthPanels = new Map();   // panel -> { btn, minWidth, openWidth, ... }

    function syncWidthPanel(panel) {
        const spec = widthPanels.get(panel);
        if (spec) syncToggle(spec.btn, isCollapsed(panel), spec.showLabel, spec.hideLabel);
    }

    // reopenWidth overrides what expandWidthPanel() will restore later — see
    // LEFT_OPEN_WIDTH. Pass null to remember the width the panel has now.
    function collapseWidthPanel(panel, reopenWidth) {
        if (isCollapsed(panel)) return;
        panel.dataset.openWidth = reopenWidth || panel.style.width || '';

        // Hand the width back to the stylesheet: an inline width left over from
        // a drag would outrank the `width: 0` in the .collapsed rule. Both
        // statements land in the same task, so no frame is rendered in between
        // and the panel never flashes at its stylesheet width on the way shut.
        panel.style.width = '';
        panel.classList.add('collapsed');
        syncWidthPanel(panel);
    }

    // keepWidth is for the drag path: the library is about to write a width of
    // its own, so restoring the remembered one would only cause a flicker.
    function expandWidthPanel(panel, keepWidth) {
        if (!isCollapsed(panel)) return;
        panel.classList.remove('collapsed');
        if (!keepWidth) panel.style.width = panel.dataset.openWidth || '';
        delete panel.dataset.openWidth;
        syncWidthPanel(panel);
    }

    // Shared by both edges. The utility panel is dragged with
    // resizeWidthFrom 'left' (see index.html), so by the time a width reaches
    // this hook it means the same thing on either side.
    function onWidthDrag(e, $el, newWidth) {
        const panel = $el[0];
        const spec = widthPanels.get(panel);
        if (!spec) return true;

        if (newWidth < spec.minWidth) {
            collapseWidthPanel(panel, spec.openWidth);
            return false;   // veto: never write a width below the minimum
        }

        // Dragging back out past the threshold re-opens it, so the splitter
        // reaches every state the button does.
        expandWidthPanel(panel, true);
        return true;
    }

    function registerWidthPanel(panel, splitter, modifier, spec) {
        const btn = makeToggle(modifier);
        splitter.appendChild(btn);
        widthPanels.set(panel, Object.assign({ btn: btn }, spec));

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isCollapsed(panel)) expandWidthPanel(panel, false);
            else collapseWidthPanel(panel, null);
        });
        syncWidthPanel(panel);
    }

    // ---- Log panel -------------------------------------------------------

    function syncLog() {
        if (logToggle) syncToggle(logToggle, isCollapsed(logPanel), 'Show log', 'Hide log');
    }

    // Give the log's height back to flex. .tab-area is pinned to whatever it is
    // actually showing first, so the handover is invisible — and it stays
    // invisible even if the window was resized while the log was shut, which
    // the height .tab-area was last dragged to would not survive.
    function settleLog() {
        tabArea.style.height = tabArea.getBoundingClientRect().height + 'px';
        mainBody.classList.remove('log-sizing');
        logPanel.style.height = '';
    }

    // Runs fn once the collapse animation lands. The timer is not just a
    // safety net: during a drag the transition is switched off entirely (see
    // .log-dragging), so transitionend never fires at all.
    function afterAnimation(fn) {
        let done = false;

        function run() {
            if (done) return;
            done = true;
            logPanel.removeEventListener('transitionend', onEnd);
            fn();
        }

        function onEnd(ev) {
            // Margin and border animate alongside height; only the height
            // finishing means the panel has reached its final size.
            if (ev.target === logPanel && ev.propertyName === 'height') run();
        }

        logPanel.addEventListener('transitionend', onEnd);
        setTimeout(run, ANIM_MS + 60);
    }

    function collapseLog(reopenHeight) {
        if (isCollapsed(logPanel)) return;
        const height = logPanel.getBoundingClientRect().height;
        logPanel.dataset.openHeight = reopenHeight || height + 'px';

        // `height: auto` is not interpolable, so pin the height the panel has
        // right now and flush the style before asking for zero — otherwise the
        // browser only ever sees the end state and snaps to it. Adding
        // .log-sizing here changes no geometry (the log's flex basis becomes
        // the height just pinned), it only makes .tab-area the panel that grows
        // into the space as the log gives it up.
        logPanel.style.height = height + 'px';
        mainBody.classList.add('log-sizing');
        void logPanel.offsetHeight;

        logPanel.classList.add('collapsed');
        logPanel.style.height = '0px';
        syncLog();
    }

    // keepDragged is the drag path: the splitter is already writing .tab-area's
    // height, so animating the log to a remembered height would fight it.
    function expandLog(keepDragged) {
        if (!isCollapsed(logPanel)) return;
        logPanel.classList.remove('collapsed');

        if (keepDragged) {
            settleLog();
        } else {
            logPanel.style.height = logPanel.dataset.openHeight || LOG_OPEN_HEIGHT;
            afterAnimation(settleLog);
        }

        delete logPanel.dataset.openHeight;
        syncLog();
    }

    function onLogDragStart() {
        mainBody.classList.add('log-dragging');
    }

    function onLogDrag(e, $el, newWidth, newHeight) {
        // $el is .tab-area, not the log panel. What decides the log's fate is
        // the slot left underneath once the splitter has taken its own height.
        const maxTabHeight = mainBody.clientHeight - logSplitter.offsetHeight;
        const slot = maxTabHeight - newHeight;

        if (slot < LOG_MIN_SLOT) {
            collapseLog(LOG_OPEN_HEIGHT);
            // Deliberately not a blanket veto: .tab-area has to keep taking the
            // drag while the log is shut, because that is what lets dragging
            // back up re-open it from exactly where it closed. The clamp only
            // stops .tab-area being driven off the bottom of the window, which
            // would leave a dead zone on the way back.
            return newHeight <= maxTabHeight;
        }

        expandLog(true);
        return true;
    }

    function onLogDragEnd() {
        mainBody.classList.remove('log-dragging');
    }

    // ---- The utility panel's own vertical split --------------------------

    // #action-panel over #device-stats-panel, arranged like .tab-area over the
    // log: the top one takes the dragged height, the bottom one absorbs the
    // rest. Neither collapses — this hook exists only to hold both ends off
    // zero. Without the upper clamp the drag would push the bottom panel out of
    // the container and leave a dead zone on the way back, the same problem
    // onLogDrag guards against.
    function onUtilitySplitDrag(e, $el, newWidth, newHeight) {
        if (newHeight < UTILITY_SPLIT_MIN) return false;

        // clientHeight still counts the panel's own padding, which the two
        // sub-panels do not get to use.
        const styles = getComputedStyle(utilityPanel);
        const usable = utilityPanel.clientHeight
            - parseFloat(styles.paddingTop)
            - parseFloat(styles.paddingBottom)
            - utilitySplitBar.offsetHeight;

        return newHeight <= usable - UTILITY_SPLIT_MIN;
    }

    // ---- Wiring ----------------------------------------------------------

    // One per tab. The utility splitter also carries the .splitter class, but it
    // lives in .main-area rather than in any .panel-container, so this query
    // cannot reach it — and nor can jquery-resizable's own handle lookup, which
    // is likewise scoped to the panel's parent.
    Array.prototype.forEach.call(
        document.querySelectorAll('.panel-container'),
        function (container) {
            const panel = container.querySelector('.panel-left');
            const splitter = container.querySelector('.splitter');
            if (!panel || !splitter) return;

            registerWidthPanel(panel, splitter, 'panel-toggle-v', {
                minWidth: LEFT_MIN_WIDTH,
                openWidth: LEFT_OPEN_WIDTH,
                showLabel: 'Show panel',
                hideLabel: 'Hide panel'
            });
        }
    );

    if (utilityPanel && utilitySplitter) {
        registerWidthPanel(utilityPanel, utilitySplitter, 'panel-toggle-v-right', {
            minWidth: UTILITY_MIN_WIDTH,
            openWidth: UTILITY_OPEN_WIDTH,
            showLabel: 'Show utility panel',
            hideLabel: 'Hide utility panel'
        });
    }

    if (mainBody && tabArea && logPanel && logSplitter) {
        logToggle = makeToggle('panel-toggle-h');
        logSplitter.appendChild(logToggle);
        logToggle.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isCollapsed(logPanel)) expandLog(false);
            else collapseLog(null);
        });
        syncLog();
    }

    self.PanelCollapse = {
        onWidthDrag: onWidthDrag,
        onLogDragStart: onLogDragStart,
        onLogDrag: onLogDrag,
        onLogDragEnd: onLogDragEnd,
        onUtilitySplitDrag: onUtilitySplitDrag
    };
})();
