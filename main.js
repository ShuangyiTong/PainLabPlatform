/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Apr 15, 2021
*/

const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

// Window and taskbar icon. This is the rasterised copy of
// assets/painlab-platform-icon.svg rather than the SVG itself: BrowserWindow's
// `icon` goes through nativeImage, which reads PNG and JPEG only. The title-bar
// icon in index.html does use the SVG, since that one is drawn by the renderer.
const APP_ICON = path.join(__dirname, 'assets', 'painlab-platform-icon.png');

let { env } = require('./backend/env.js');
const { dataHub } = require('./backend/data.js');
const {
    PORT,
    activeServers,
    createListeningServer,
    closeListeningServer,
} = require('./backend/server.js');
const { buildIPPromptHTML } = require('./backend/utilities.js');

require('./backend/service.js')

// ============================================================
//  IP prompt — small modal BrowserWindow because Electron
//  doesn't expose a native input dialog.
// ============================================================
function promptForIP() {
    return new Promise((resolve) => {
        const promptWin = new BrowserWindow({
            width: 400,
            height: 210,
            parent: env.winRef,
            modal: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            title: 'New Listening Port',
            icon: APP_ICON,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });
        promptWin.setMenu(null);
        promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildIPPromptHTML(PORT)));

        let resolved = false;
        const handler = (event, ip) => {
            if (resolved) return;
            resolved = true;
            ipcMain.removeListener('ip-prompt-result', handler);
            if (!promptWin.isDestroyed()) promptWin.destroy();
            resolve(ip);
        };
        ipcMain.on('ip-prompt-result', handler);

        promptWin.on('closed', () => {
            if (resolved) return;
            resolved = true;
            ipcMain.removeListener('ip-prompt-result', handler);
            resolve(null);
        });
    });
}

// ============================================================
//  Menu handlers — create / delete listening port
// ============================================================
function handleCreateNewPort() {
    promptForIP().then(ip => {
        if (!ip) return; // user cancelled
        createListeningServer(
            ip,
            () => {
                // Bound successfully. Each menu is rebuilt when its
                // title-bar button pops it, so the new port shows the
                // next time the Options menu is opened.
            },
            (errMsg) => {
                dialog.showMessageBox(env.winRef, {
                    type: 'error',
                    title: 'Could not create listening port',
                    message: `Failed to bind ${ip}:${PORT}`,
                    detail: errMsg
                });
            }
        );
    });
}

function handleDeletePort(ip) {
    const choice = dialog.showMessageBoxSync(env.winRef, {
        type: 'warning',
        title: 'Stop listening?',
        message: `Stop listening on ${ip}:${PORT}?`,
        detail: 'Existing connections on this address will be terminated. ' +
                'To resume, recreate the listener from the Options menu.',
        buttons: ['Cancel', 'Stop Listening'],
        defaultId: 0,
        cancelId: 0
    });
    if (choice !== 1) return;

    closeListeningServer(ip, () => {});
}

// ============================================================
//  Application menu
//
//  The visible menu is HTML, drawn by the renderer under the app title
//  (frontend/js/app-menu.js) so it can carry the app's theming — native
//  menus take no CSS. This file keeps the two halves the renderer can't
//  do itself: the 'menu-action' handlers below, and a hidden native menu
//  that exists only to own the keyboard accelerators.
// ============================================================

async function handleSaveAllData() {
    const cutoff = dataHub.flush(); // Capture this click before opening the dialog.
    const result = await dialog.showSaveDialog({ defaultPath: 'test',
        filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return;
    const exporter = new Worker(path.join(__dirname, 'tools', 'session.js'), {
        argv: [dataHub.sessionDir, result.filePath, String(await cutoff)],
    });
    const [code] = await once(exporter, 'exit');
    if (code !== 0) throw new Error('Session aggregation failed');
    await dialog.showMessageBox({ message: 'All device data saved.' });
}

// Installs a native application menu, then hides the menu bar so it never
// draws over the custom title bar. Nothing here is meant to be seen — it
// exists so the keyboard accelerators keep working. Shortcuts like
// Ctrl+Shift+Plus / Ctrl+- (zoom), Ctrl+0 (actual size), Ctrl+R (reload)
// and F11 (fullscreen) belong to menu items, so with no menu installed
// they stop existing; the HTML menu can't register them on its own.
//
// Only the accelerator-bearing roles live here. Save File and the port
// commands have no shortcuts, so they'd add nothing but a second copy of
// the menu structure to keep in sync with app-menu.js.
function installAcceleratorMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        }
    ]));
}

// Lets the renderer list the currently bound addresses when it builds the
// Options ▸ Delete Existing Listening Port submenu.
ipcMain.handle('get-listening-ports', () => ({
    ips: Object.keys(activeServers),
    port: PORT
}));

// Everything the HTML menu can't do from the renderer. Theme switching is
// absent on purpose — that one is entirely renderer-side.
ipcMain.on('menu-action', (event, action, payload) => {
    const win = env.winRef;
    if (!win || win.isDestroyed()) return;

    switch (action) {
        case 'save-all-data':         handleSaveAllData(); break;
        case 'create-listening-port': handleCreateNewPort(); break;
        case 'delete-listening-port': handleDeletePort(payload); break;

        case 'reload':          win.webContents.reload(); break;
        case 'force-reload':    win.webContents.reloadIgnoringCache(); break;
        case 'toggle-dev-tools': win.webContents.toggleDevTools(); break;

        // Deliberately mirrors what Electron's own zoom roles do — they step
        // webContents.zoomLevel by 0.5. The accelerators still come from
        // those roles via installAcceleratorMenu(), so anything else here
        // would make Ctrl+Plus and the menu's Zoom In disagree.
        case 'zoom-reset':      win.webContents.zoomLevel = 0; break;
        case 'zoom-in':         win.webContents.zoomLevel += 0.5; break;
        case 'zoom-out':        win.webContents.zoomLevel -= 0.5; break;

        case 'toggle-fullscreen': win.setFullScreen(!win.isFullScreen()); break;

        default: console.log('unknown menu action:', action);
    }
});

// The renderer re-measured the title bar (it grows and shrinks with page
// zoom); resize the native caption-button strip to match so the two stay
// aligned. Windows/Linux only — setTitleBarOverlay doesn't exist on macOS.
ipcMain.on('sync-titlebar-height', (event, height) => {
    const win = env.winRef;
    if (!win || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') return;
    if (!Number.isFinite(height) || height < 20 || height > 200) return;
    try {
        win.setTitleBarOverlay({ height: Math.round(height) });
    } catch (err) {
        // Non-fatal: the buttons just keep their previous height.
        console.log('setTitleBarOverlay failed:', err.message);
    }
});

function createWindow () {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    icon: APP_ICON,
    // Hide the native title bar so the custom one in index.html spans the
    // top. titleBarOverlay keeps the OS minimize/maximize/close buttons
    // (drawn top-right, over the web contents) so the window stays fully
    // resizable and snappable without reimplementing window controls.
    // Colours match the (non-themed) title-bar background/text.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#FAFAFA',
      symbolColor: '#4A4A4F',
      height: 40
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.on('close', function(e) {
    const choice = require('electron').dialog.showMessageBoxSync(this,
    {
        type: 'question',
        buttons: ['Yes, I can confirm I saved all the data, close it NOW', 'No'],
        noLink: true,
        defaultId: 1,
        cancelId: 1,
        title: 'Confirm',
        message: 'DID YOU SAVE THE DATA?'
    });
    if (choice === 1) {
      e.preventDefault();
    }
  });
  env.winRef = win;

  // Keep the menu bar itself off-screen — the visible menus are the
  // title-bar buttons. Not auto-hide: an auto-hidden bar still springs open
  // on Alt and would cover the custom title bar.
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  // The visible menu is HTML in the renderer; this installs the hidden
  // native one that carries the keyboard accelerators.
  installAcceleratorMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
