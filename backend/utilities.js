/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>

  HTML templates / static assets that are too bulky to live inline in logic
  files. Each export is a pure function returning a string so we can still
  interpolate runtime values (e.g. port number) without resorting to magic
  placeholders.
*/

/**
 * HTML for the modal prompt that asks the user for a new listening IP.
 * Rendered inside its own BrowserWindow via a `data:` URL — keep this file
 * self-contained (no external CSS/JS references) because the data URL has
 * no base path.
 *
 * @param {number} port - TCP port the new server will listen on. Shown in
 *                        the dialog text only; the actual binding happens
 *                        in the main process.
 * @returns {string} Full HTML document.
 */
function buildIPPromptHTML(port) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: 'Segoe UI', sans-serif;
            margin: 0;
            padding: 22px;
            background: #F2F2F4;
            color: #1C1C1E;
        }
        label {
            display: block;
            margin-bottom: 10px;
            font-size: 12px;
            color: #4A4A4F;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }
        input {
            width: 100%;
            padding: 9px 12px;
            font-size: 14px;
            box-sizing: border-box;
            border: 1px solid #C7C7CC;
            border-radius: 5px;
            outline: none;
            font-family: 'Consolas', 'Menlo', monospace;
        }
        input:focus {
            border-color: rgb(223, 147, 148);
            box-shadow: 0 0 0 3px rgba(223, 147, 148, 0.25);
        }
        .hint {
            margin-top: 6px;
            font-size: 11px;
            color: #8A8A8F;
        }
        .actions {
            margin-top: 18px;
            text-align: right;
        }
        button {
            padding: 7px 16px;
            margin-left: 8px;
            border: 1px solid #C7C7CC;
            border-radius: 5px;
            background: white;
            cursor: pointer;
            font-size: 13px;
            font-family: inherit;
            font-weight: 600;
        }
        button:hover {
            border-color: rgba(223, 147, 148, 0.5);
        }
        button.primary {
            background: rgb(192, 132, 115);
            color: white;
            border-color: rgb(192, 132, 115);
        }
        button.primary:hover {
            background: rgb(170, 112, 95);
            border-color: rgb(170, 112, 95);
        }
    </style>
</head>
<body>
    <label>Enter IP address to listen on (port ${port})</label>
    <input id="ip" type="text" placeholder="e.g. 169.254.223.107" autofocus />
    <div class="hint">The server will bind to this address on TCP port ${port}.</div>
    <div class="actions">
        <button id="cancel">Cancel</button>
        <button id="ok" class="primary">Create</button>
    </div>
    <script>
        const { ipcRenderer } = require('electron');
        const input = document.getElementById('ip');
        const ok = () => { ipcRenderer.send('ip-prompt-result', (input.value || '').trim() || null); };
        const cancel = () => { ipcRenderer.send('ip-prompt-result', null); };
        document.getElementById('ok').onclick = ok;
        document.getElementById('cancel').onclick = cancel;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') ok();
            if (e.key === 'Escape') cancel();
        });
    </script>
</body>
</html>`;
}

exports.buildIPPromptHTML = buildIPPromptHTML;
