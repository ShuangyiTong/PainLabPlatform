/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  app-menu.js — the application menu, rendered as themed HTML.

  Replaces the native Electron popup that used to hang off the app title.
  Native menus are drawn by the OS and take no CSS at all, so the only way
  to make the menu match the rest of the UI (material tints, glass blur,
  per-theme accent) is to draw it ourselves. Styling lives in index.css
  under "Application Menu", and follows the same pattern as the asyncAlert
  modal: a plain surface by default, a frosted one under .glass themes.

  Structure mirrors an Electron menu template — { label, submenu, type,
  enabled, accelerator, run } — so the shape stays familiar. Two differences:
  `run` is a plain callback instead of `click`, and `checked` is a function,
  because the theme radios are evaluated each time the menu opens.

  Where the work happens:
    - Theme switching is entirely renderer-side (changeTheme in renderer.js).
    - Everything else is a main-process concern (dialogs, servers, zoom,
      devtools, fullscreen) and goes over the 'menu-action' channel.

  Keyboard shortcuts are NOT wired up here. They still come from the hidden
  native menu installed in main.js, which exists purely to own accelerators.
*/
(function () {
    const { ipcRenderer } = require('electron');
    const isMac = process.platform === 'darwin';

    // Shown right-aligned in the menu. These must match the accelerators the
    // hidden role menu registers in main.js — they are Electron's defaults
    // for those roles, listed here only so the menu can display them.
    const ACCEL = isMac ? {
        reload: '⌘R', forceReload: '⇧⌘R', devTools: '⌥⌘I',
        actualSize: '⌘0', zoomIn: '⌘+', zoomOut: '⌘−',
        fullScreen: '⌃⌘F'
    } : {
        reload: 'Ctrl+R', forceReload: 'Ctrl+Shift+R', devTools: 'Ctrl+Shift+I',
        actualSize: 'Ctrl+0', zoomIn: 'Ctrl++', zoomOut: 'Ctrl+-',
        fullScreen: 'F11'
    };

    function send(action, payload) {
        ipcRenderer.send('menu-action', action, payload);
    }

    // ---- Menu definition -------------------------------------------------

    function themeItems() {
        return Object.keys(THEMES).map((name) => ({
            // THEME_LABELS only covers the keys that don't capitalise well
            // (HUSL); everything else just gets its first letter raised.
            label: THEME_LABELS[name] || (name.charAt(0).toUpperCase() + name.slice(1)),
            type: 'radio',
            checked: () => currentThemeName === name,
            run: () => changeTheme(name)
        }));
    }

    // Async because the bound-server list lives in the main process, and it
    // has to be current every time the menu opens.
    async function buildTemplate() {
        let ips = [], port = '';
        try {
            ({ ips, port } = await ipcRenderer.invoke('get-listening-ports'));
        } catch (err) {
            console.log('could not read listening ports:', err.message);
        }

        const deletePortItems = ips.length === 0
            ? [{ label: '(no active servers)', enabled: false }]
            : ips.map((ip) => ({
                  label: ip + ':' + port,
                  run: () => send('delete-listening-port', ip)
              }));

        return [
            { label: 'Save File', run: () => send('save-all-data') },
            { type: 'separator' },
            {
                label: 'Options',
                submenu: [
                    { label: 'Theme', submenu: themeItems() },
                    { type: 'separator' },
                    { label: 'Create New Listening Port…', run: () => send('create-listening-port') },
                    { label: 'Delete Existing Listening Port', submenu: deletePortItems }
                ]
            },
            {
                label: 'View',
                submenu: [
                    { label: 'Reload', accelerator: ACCEL.reload, run: () => send('reload') },
                    { label: 'Force Reload', accelerator: ACCEL.forceReload, run: () => send('force-reload') },
                    { label: 'Toggle Developer Tools', accelerator: ACCEL.devTools, run: () => send('toggle-dev-tools') },
                    { type: 'separator' },
                    { label: 'Actual Size', accelerator: ACCEL.actualSize, run: () => send('zoom-reset') },
                    { label: 'Zoom In', accelerator: ACCEL.zoomIn, run: () => send('zoom-in') },
                    { label: 'Zoom Out', accelerator: ACCEL.zoomOut, run: () => send('zoom-out') },
                    { type: 'separator' },
                    { label: 'Toggle Full Screen', accelerator: ACCEL.fullScreen, run: () => send('toggle-fullscreen') }
                ]
            }
        ];
    }

    // ---- Rendering -------------------------------------------------------

    const GAP = 4;              // keep panels this far from the window edge
    let panels = [];            // open panels, index === nesting depth
    let overlay = null;
    let opening = false;        // guards the await in openMenu()
    let appTitle = null;

    function closeFrom(depth) {
        while (panels.length > depth) {
            const panel = panels.pop();
            if (panel.parentNode) panel.parentNode.removeChild(panel);
        }
    }

    function closeMenu() {
        closeFrom(0);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
        document.removeEventListener('keydown', onKey);
        if (appTitle) appTitle.classList.remove('app-title-open');
    }

    function onKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMenu();
        }
    }

    function buildPanel(items, depth) {
        const panel = document.createElement('div');
        panel.className = 'app-menu-panel';

        items.forEach((item) => {
            if (item.type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'app-menu-separator';
                panel.appendChild(sep);
                return;
            }

            const el = document.createElement('div');
            el.className = 'app-menu-item';
            const disabled = item.enabled === false;
            if (disabled) el.classList.add('disabled');
            if (item.submenu) el.classList.add('has-submenu');
            if (item.type === 'radio') {
                el.classList.add('radio');
                if (item.checked && item.checked()) el.classList.add('checked');
            }

            const label = document.createElement('span');
            label.className = 'app-menu-label';
            label.textContent = item.label;
            el.appendChild(label);

            if (item.accelerator) {
                const accel = document.createElement('span');
                accel.className = 'app-menu-accel';
                accel.textContent = item.accelerator;
                el.appendChild(accel);
            }
            if (item.submenu) {
                const arrow = document.createElement('span');
                arrow.className = 'app-menu-arrow';
                el.appendChild(arrow);
            }

            // Moving onto any item closes whatever was open below this level,
            // then opens this item's own submenu — the usual menu behaviour.
            el.addEventListener('mouseenter', () => {
                closeFrom(depth + 1);
                Array.prototype.forEach.call(
                    panel.querySelectorAll('.app-menu-item.open'),
                    (sibling) => sibling.classList.remove('open')
                );
                if (item.submenu && !disabled) {
                    el.classList.add('open');
                    openSubmenu(el, panel, item.submenu, depth + 1);
                }
            });

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (disabled || item.submenu) return;   // parents don't act
                closeMenu();
                if (item.run) item.run();
            });

            panel.appendChild(el);
        });

        return panel;
    }

    // Places a panel at (x, y), nudged back inside the window if it would
    // overflow. When it won't fit rightwards and `flipRightEdge` is given,
    // the panel flips to the other side of its parent — its right edge lands
    // on that coordinate — instead of being clamped on top of the parent.
    // The width is only known once the panel is in the document, which is
    // why the flip is resolved here rather than by the caller.
    function placePanel(panel, x, y, flipRightEdge) {
        document.body.appendChild(panel);
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;

        if (x + w > window.innerWidth - GAP) {
            x = (typeof flipRightEdge === 'number')
                ? flipRightEdge - w
                : window.innerWidth - w - GAP;
        }
        panel.style.left = Math.max(GAP, x) + 'px';
        panel.style.top = Math.max(GAP, Math.min(y, window.innerHeight - h - GAP)) + 'px';

        requestAnimationFrame(() => panel.classList.add('visible'));
    }

    function openSubmenu(itemEl, parentPanel, items, depth) {
        const panel = buildPanel(items, depth);
        const itemRect = itemEl.getBoundingClientRect();
        const panelRect = parentPanel.getBoundingClientRect();
        // Overlap the parent's border by a pixel so the two panels read as
        // connected, and line the first entry up with the item it came from.
        placePanel(panel, panelRect.right - 1, itemRect.top - 6, panelRect.left + 1);
        panels[depth] = panel;
    }

    async function openMenu() {
        if (opening) return;
        if (overlay) { closeMenu(); return; }   // second click closes it
        opening = true;

        let template;
        try {
            template = await buildTemplate();
        } finally {
            opening = false;
        }

        overlay = document.createElement('div');
        overlay.className = 'app-menu-overlay';
        // Click, not mousedown: the overlay sits above the app title, so the
        // same click that dismisses the menu can't also fall through and
        // immediately reopen it.
        overlay.addEventListener('click', closeMenu);
        overlay.addEventListener('contextmenu', closeMenu);
        document.body.appendChild(overlay);

        const rect = appTitle.getBoundingClientRect();
        const panel = buildPanel(template, 0);
        placePanel(panel, rect.left, rect.bottom + 2);
        panels[0] = panel;

        appTitle.classList.add('app-title-open');
        document.addEventListener('keydown', onKey);
    }

    // ---- Wiring ----------------------------------------------------------

    appTitle = document.querySelector('.title-bar .app-title');
    if (appTitle) appTitle.addEventListener('click', openMenu);

    // A resize (including a zoom change) invalidates every position we
    // measured, so just close rather than trying to re-anchor.
    window.addEventListener('resize', () => { if (overlay) closeMenu(); });
})();
