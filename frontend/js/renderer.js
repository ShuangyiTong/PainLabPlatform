/* 
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Apr 15, 2021
*/

const { ipcRenderer } = require('electron');

const Mutex = require('async-mutex').Mutex;
const bci = require('bcijs');
const FFT = require('fft-js').fft;
const FFTUtils = require('fft-js').util;
const library = require('./frontend/js/library-loader.js').createLibrary();

var current_selected_script;

var device_records = {};

/* ===== Log Panel ===== */
const LOG_MAX_LINES = 10000;
var logLineCount = 0;
var logContainer = null;

function appendLog(...args) {
    if (!logContainer) {
        logContainer = document.getElementById('log-output');
    }
    if (!logContainer) return;

    const line = document.createElement('div');
    line.className = 'log-line';

    const now = new Date();
    const ts = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0') + ':' +
               String(now.getSeconds()).padStart(2, '0') + '.' +
               String(now.getMilliseconds()).padStart(3, '0');

    const tsSpan = document.createElement('span');
    tsSpan.className = 'log-ts';
    tsSpan.textContent = ts;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = args.map(a => {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
    }).join(' ');

    line.appendChild(tsSpan);
    line.appendChild(msgSpan);
    logContainer.appendChild(line);
    logLineCount++;

    // Enforce max lines — trim from the top
    while (logLineCount > LOG_MAX_LINES) {
        logContainer.removeChild(logContainer.firstChild);
        logLineCount--;
    }

    // Auto-scroll to newest line
    logContainer.scrollTop = logContainer.scrollHeight;
}

function sendCommand(device_id, field, value) {
    ipcRenderer.send('control-data', [ device_id, { [field]: value }]);
}

function sendMultipleCommands(device_id, obj) {
    ipcRenderer.send('control-data', [ device_id, obj]);
}

function startLocalProgram(exec_path, args, need_shell=false) {
    ipcRenderer.send('start-local-program', [ exec_path, args, need_shell ]);
}

function getTupleValue(duplicates, id_prefix) {
    let ret_tuple = [];
    for (var i = 0; i < duplicates; i++) {
        ret_tuple.push($(`#${ id_prefix }-${ i }`).val());
    }

    if (ret_tuple.length == 1) {
        return ret_tuple[0];
    }

    return ret_tuple;
}

function makeVisualControlView(device_id, device_data_field, visual_control_style) {
    let ret_div = `<div style="center">`;
    let data_description = device_records[device_id].descriptor.data_to_control;

    let dup = 1;
    if (Array.isArray(data_description[device_data_field])) {
        dup = data_description[device_data_field][0];
    }

    if (visual_control_style == "static") {
        for (var i = 0; i < dup; i++)
            ret_div += `<input type='text' id="device-control${ device_id }-${ device_data_field }-${ i }"/>`;
        ret_div += `<input id="device-control${ device_id }-${ device_data_field }-submit" type="submit" value="Submit">`
        ret_div += `<script>$( "#device-control${ device_id }-${ device_data_field }-submit" ).click(function() {
                                sendCommand("${ device_id }",
                                            "${ device_data_field }",
                                            getTupleValue(${ dup }, "device-control${ device_id }-${ device_data_field }"));
                            });
                    </script>`
    } else if (Array.isArray(visual_control_style)) { // Since we don't have built-in ADT pattern matching in javascript, just match and unpack values manually
        if (visual_control_style[0] == "slider") {
            ret_div += `<input type="range" min="${ visual_control_style[1] }" max="${ visual_control_style[2] }" 
                         value="0" step="0.01" id="device-control${ device_id }-${ device_data_field }">`;
            ret_div += `Value: <input id="device-control${ device_id }-${ device_data_field }-display" type="text" value="0"/>`;
            ret_div += `<input id="device-control${ device_id }-${ device_data_field }-submit" type="submit" value="Submit">`;
            ret_div += `<script>
                            $( "#device-control${ device_id }-${ device_data_field }-submit" ).click(function() {
                                sendCommand("${ device_id }", "${ device_data_field }", 
                                    $("#device-control${ device_id }-${ device_data_field }").val());
                            });

                            $( "#device-control${ device_id }-${ device_data_field }" ).on("input", function() {
                                $( "#device-control${ device_id }-${ device_data_field }-display" ).val(this.value);
                            });

                            $( "#device-control${ device_id }-${ device_data_field }-display" ).on("input", function() {
                                $( "#device-control${ device_id }-${ device_data_field }" ).val(this.value);
                            });
                        </script>`
        }
    } else if (visual_control_style == "bool") { // note there is no bool value in our protocol, use integer all together
        ret_div += `<label class="switch">
        <input id="device-control${ device_id }-${ device_data_field }-box" type="checkbox">
        <span class="slider round"></span>
        </label>`
        ret_div += `<script>$( "#device-control${ device_id }-${ device_data_field }-box" ).change(function() {
            let val = 0;
            if (this.checked) {
                val = 1;
            }
            sendCommand("${ device_id }",
                        "${ device_data_field }",
                        val);});
            </script>`
    }

    ret_div += "</div>";
    return ret_div
}
var selected_devices = new Set();
var device_data_rate = {}; // resolved sample rate (Hz) per device, for unpacking packed frames

function toggleDetailLayout(device_id) {
    if (selected_devices.has(device_id)) {
        selected_devices.delete(device_id);
        $("#entry" + device_id).removeClass("device-select-entry");
        $("#device" + device_id + "-detail").slideToggle();
        if (window.ChartManager) ChartManager.setDeviceExpanded(device_id, false);
    } else {
        selected_devices.add(device_id);
        $("#entry" + device_id).addClass("device-select-entry");
        $("#device" + device_id + "-detail").slideToggle();
        if (window.ChartManager) ChartManager.setDeviceExpanded(device_id, true);
    }
}

function makeDetailLayout(device_id) {
    $("#entry" + device_id).addClass("device-select-entry");
    let ret_div = `<div id="device${ device_id }-detail">`;
    let report_description = device_records[device_id].descriptor.data_to_report;
    let control_description = device_records[device_id].descriptor.data_to_control;
    let visual_report_guideline = device_records[device_id].descriptor.visual_report;
    let visual_control_guideline = device_records[device_id].descriptor.visual_control;
    if (!visual_report_guideline) {
        return "No visual configuration provided, nothing to show here.";
    }
    for (var report_data_field in report_description) {
        if (report_data_field in visual_report_guideline) {
            let visual_style = visual_report_guideline[report_data_field];
            let data_field_readable_name 
                = report_data_field.split("_").map(str => str[0].toUpperCase() + str.slice(1)).join(" ");
            let dup = 1;
            if (Array.isArray(report_description[report_data_field])) {
                dup = report_description[report_data_field][0];
            }
            ret_div += `<p>${ data_field_readable_name }</p>`;
            if (visual_style == "line_chart") {
                ret_div += `<div class="line-chart">
                    <canvas id="device${ device_id }-${ report_data_field }" class="line-chart-canvas"></canvas>
                    <span class="line-chart-label line-chart-ymax"></span>
                    <span class="line-chart-label line-chart-ymin"></span>
                </div>`;
            } else if (visual_style == "static") {
                for (var i = 0; i < dup; i++)
                    ret_div += `Index-${ i }: <div id="device${ device_id }-${ report_data_field }-${ i }"></div>`;
            } else {
                ret_div += `<div>Unknown visual style: ${ visual_style } </div>`
            }

            // chceck visual control
            if (visual_control_guideline) {
                if (report_data_field in visual_control_guideline) {
                    let visual_control_style = visual_control_guideline[report_data_field];
                    ret_div += makeVisualControlView(device_id, report_data_field, visual_control_style);
                }
            }
        } else {
            continue;
        }
    }

    for (var control_data_field in control_description) {
        if (control_data_field in visual_control_guideline) {
            if (!(control_data_field in visual_report_guideline)) { // those already rendered with report field together
                let data_field_readable_name 
                    = control_data_field.split("_").map(str => str[0].toUpperCase() + str.slice(1)).join(" ");
                ret_div += `<p>${ data_field_readable_name }<\p>`
                ret_div += makeVisualControlView(device_id, control_data_field, visual_control_guideline[control_data_field]);
            }
        }
    }

    ret_div += `</div>`;

    return ret_div;
}

/* Resolve a device's sample rate (Hz) for reconstructing per-sample timestamps
   when unpacking packed frames. The rate lives in visual_report.data_rate; if it
   is missing we fall back to 1000 Hz and warn once. Cached per device so the
   warning fires only once and lookups stay cheap on the hot path. */
function getDataRate(device_id, visual_guideline) {
    let cached = device_data_rate[device_id];
    if (cached !== undefined) return cached;

    let rate = visual_guideline.data_rate;
    if (typeof rate === "number" && rate > 0) {
        device_data_rate[device_id] = rate;
    } else {
        device_data_rate[device_id] = 1000;
        appendLog(`Device ${ device_id }: visual_report.data_rate not specified — assuming 1000 Hz`);
    }
    return device_data_rate[device_id];
}

/* Pure data ingestion: pull new [timestamp, value] samples out of a dataframe
   and hand them to the off-thread chart renderer. No drawing happens here — the
   chart worker keeps the rolling buffer and draws on its own animation loop, and
   only while the chart is actually visible (see chart-manager.js). Static fields
   are still written straight to the DOM. */
function renderDataFrame(device_id, data_frame) {
    let record = device_records[device_id];
    if (!record || !record.descriptor) return;
    let data_description = record.descriptor.data_to_report || {};
    let visual_guideline = record.descriptor.visual_report;
    if (!visual_guideline) return;

    // Normalize to an array of frames (expand_packed sends a batch; else one).
    let frames = Array.isArray(data_frame) ? data_frame : [data_frame];

    for (var device_data_field in visual_guideline) {
        if (device_data_field == "data_rate" || device_data_field == "rolling_time"
            || device_data_field == "expand_packed" || device_data_field == "true_time") {
            continue;
        }
        let visual_style = visual_guideline[device_data_field];
        let dup = 1;
        if (Array.isArray(data_description[device_data_field])) {
            dup = data_description[device_data_field][0]; // multidimensional data
        }

        if (visual_style == "line_chart") {
            let chartId = `device${ device_id }-${ device_data_field }`;
            if (!window.ChartManager || !ChartManager.has(chartId)) continue;

            // Collect this frame-batch's new samples per series, post once each.
            let batches = new Array(dup);
            for (var b = 0; b < dup; b++) batches[b] = [];
            for (let df of frames) {
                for (var s = 0; s < dup; s++) {
                    let series_data = dup > 1 ? df[device_data_field][s] : df[device_data_field];
                    if (Array.isArray(series_data)) {
                        // Packed frame: the array is consecutive time-samples of this
                        // series. Reconstruct each sample's timestamp backwards from the
                        // frame time using the device's data_rate (Hz) — the N samples
                        // fill the N intervals of dt = 1000/data_rate ms ending at the
                        // frame timestamp (initial sample at df.timestamp - N*dt).
                        let N = series_data.length;
                        let dt = 1000 / getDataRate(device_id, visual_guideline); // ms per sample
                        let t0 = df.timestamp - N * dt;
                        for (let n = 0; n < N; n++) {
                            batches[s].push([t0 + n * dt, series_data[n]]);
                        }
                    } else {
                        batches[s].push([df.timestamp, series_data]);
                    }
                }
            }
            for (var k = 0; k < dup; k++) {
                if (batches[k].length) ChartManager.push(chartId, k, batches[k]);
            }
        } else if (visual_style == "static") {
            let df = frames[frames.length - 1]; // show the latest value(s)
            for (var i = 0; i < dup; i++) {
                let series_data = dup > 1 ? df[device_data_field][i] : df[device_data_field];
                $("#device" + device_id + "-" + device_data_field + "-" + i).html(series_data);
            }
        }
    }
}

/* Register every line_chart canvas of a device with the chart worker. Called
   once, right after the device's detail layout is inserted into the DOM. */
function registerDeviceCharts(device_id) {
    if (!window.ChartManager) return;
    let record = device_records[device_id];
    if (!record || !record.descriptor) return;
    let descriptor = record.descriptor;
    let report = descriptor.data_to_report || {};
    let visual = descriptor.visual_report || {};
    let ranges = descriptor.visual_value_range || {};

    let rollingTime = (typeof visual.rolling_time === "number" && visual.rolling_time > 0) ? visual.rolling_time : 10;
    let windowMs = rollingTime * 1000;
    // Index (strip-chart) is the default; opt into real-time x with true_time.
    let trueTime = (visual.true_time === true);

    for (var field in visual) {
        if (field == "data_rate" || field == "rolling_time"
            || field == "expand_packed" || field == "true_time") continue;
        if (visual[field] != "line_chart") continue;

        let canvas = document.getElementById(`device${ device_id }-${ field }`);
        if (!canvas) continue;

        let seriesCount = 1;
        if (Array.isArray(report[field])) seriesCount = report[field][0];

        let range = ranges[field];
        let yMin = (range && typeof range.min === "number") ? range.min : null;
        let yMax = (range && typeof range.max === "number") ? range.max : null;

        // Index mode needs a sample-count window, derived from the device rate;
        // time mode resolves data_rate lazily during ingestion instead.
        let maxPoints = trueTime ? 0 : Math.max(2, Math.round(rollingTime * getDataRate(device_id, visual)));

        ChartManager.create(canvas, {
            chartId: `device${ device_id }-${ field }`,
            deviceId: device_id,
            seriesCount: seriesCount,
            yMin: yMin,
            yMax: yMax,
            windowMs: windowMs,
            trueTime: trueTime,
            maxPoints: maxPoints
        });

        // Fill the static y-axis labels (left blank when auto-scaling).
        let wrap = canvas.parentElement;
        if (wrap) {
            let hi = wrap.querySelector(".line-chart-ymax");
            let lo = wrap.querySelector(".line-chart-ymin");
            if (hi) hi.textContent = (yMax === null ? "" : String(yMax));
            if (lo) lo.textContent = (yMin === null ? "" : String(yMin));
        }
    }
}

function makeEntry(device_id) {
    return `<div id="entry${ device_id }" class="device-entry" onclick="toggleDetailLayout(this.id.slice(5))">
    </div>`;
}

function makeDeviceEntryInfo(status, device_name) {
    let status_colour = 'green';
    if (status == 'Disconnected') {
        status_colour = 'red';
    }
    return `<div>
        <p style="color:${ status_colour };" class="no-vertical-margin">
            <i class="fas fa-plug"></i>
            ${ status }
        </p>
        <p>
        ${ device_name }
        </p>
    </div>`;
}

function switchTab(invoke_div, selected_tab) {
    $(".panel-container").each((i, obj) => {
        if (obj.id != selected_tab) {
            obj.style.display = "none";
        } else {
            obj.style.display = "";
        }
    });
    $(".view-tab").each((i, obj) => {
        if (obj.id != invoke_div) {
            obj.classList.remove('active-tab');
        } else {
            obj.classList.add('active-tab');
        }
    });
    // Drive the active-view lifecycle so hidden views can pause heavy work.
    if (window.ViewController) ViewController.activate(selected_tab);
}

const connect_sync = new Mutex();

ipcRenderer.on('connected', (event, arg) => {
    connect_sync
    .acquire()
    .then(function(release) {
        // TODO: add try/finally to avoid failure before release()
        let device_name = "Unknown";
        if (arg in device_records) {
            device_name = device_records[arg].descriptor.name;
        } else {
            entry = makeEntry(arg);
            $("#device-select-panel").append(entry);
            device_records[arg] = {};
        }
        entry_info = makeDeviceEntryInfo("Connected", device_name);
        $("#entry" + arg).html(entry_info);
        appendLog('Device ' + arg + ' connected');
        release();
    });
});

ipcRenderer.on('disconnected', (event, arg) => {
    entry_info = makeDeviceEntryInfo("Disconnected", device_records[arg].descriptor.name);
    $("#entry" + arg).html(entry_info);
    appendLog("Disconnected to " + arg);
});

ipcRenderer.on('new-descriptor', (event, arg) => {
    connect_sync
    .acquire()
    .then(function(release) {
        // TODO: add try/finally to avoid failure before release()
        let device_id = arg[0], device_descriptor = arg[1];
        entry_info = makeDeviceEntryInfo("Connected", device_descriptor.name);
        $("#entry" + device_id).html(entry_info);
        device_records[device_id].descriptor = device_descriptor;
        appendLog("Received descriptor: ", device_descriptor);
        selected_devices.add(device_id);
        $("#detail-display").append(makeDetailLayout(device_id));
        registerDeviceCharts(device_id); // hand the new line-chart canvases to the worker
        release();
    });
});

var actionFunction = (device_id, dataframe) => {};
var interactiveScope = {};
var runtime_display_settings = {};
var interactive_settings = {};
/* Split a script into [DSL header, runtime body] at its end-of-DSL marker.
   Shared by the saved scripts (EndofInteraction) and the action scripts
   (EndofAction) — the two DSLs differ, but they are delimited the same way. */
function sliceScriptAt(script, cutWord) {
    let cutPos = script.indexOf(cutWord);
    if (cutPos == -1) {
        return ["", script];
    }
    cutPos += cutWord.length;
    // End the header at the newline before the marker's line.
    const markerLineBreak = script.lastIndexOf('\n', cutPos - 1);
    const headerEnd = markerLineBreak === -1 ? cutPos : markerLineBreak;
    return [script.slice(0, headerEnd), script.slice(cutPos)];
}

function sliceScript(script) {
    return sliceScriptAt(script, "EndofInteraction");
}

function refreshInteraction() {
    updateRuntimeDisplay();
}

var actionScope = {};

/* Restyle one interactive button at runtime to cue the operator (e.g. green for
   the next expected action, red for abort, grey when not actionable). `prop` and
   `value` identify the updatable_params entry: `value` is that entry's hidden
   value (5th element), or "" for a free-text entry. `stateClass` is one of the
   .interact-btn-* classes defined in frontend/css/index.css ("" clears styling).
   The submit button's element id is recovered from the id-suffix map that
   decodeForInteractiveDSLDOM() registers in interactiveScope at render time. */
const INTERACTIVE_BTN_STATE_CLASSES = "interact-btn-go interact-btn-armed interact-btn-abort interact-btn-idle";
function setInteractiveButtonState(prop, value, stateClass) {
    let id_suffix = interactiveScope['__interactive_settings_id_suffix__' + prop + value];
    if (id_suffix === undefined) {
        appendLog("setInteractiveButtonState: no interactive entry matches '" + prop + "' / '" + value + "'");
        return;
    }
    let btn = $("#__interative__" + id_suffix + "-submit");
    btn.removeClass(INTERACTIVE_BTN_STATE_CLASSES);
    if (stateClass) {
        btn.addClass(stateClass);
    }
}

function decodeForInteractiveDSLDOM(interactiveDSL) {
    if (interactiveDSL == "") {
        return ["", ""];
    }
    jsonFromDSL = JSON.parse(interactiveDSL);

    runtime_display_settings = jsonFromDSL["display_params"];
    interactive_settings = jsonFromDSL["updatable_params"];

    runtime_DOM = "";
    interactive_DOM = "";

    for (const prop in runtime_display_settings) {
        let id_suffix = runtime_display_settings[prop].replace('.', '-');;
        runtime_DOM += `<div> ${ prop }: <span id="__runtime_display__${ id_suffix }"></span>`;
        runtime_DOM += `</div>`;
    }

    for (const prop in interactive_settings) {
        /* An interactive_settings entry look like this:
            "Description (human readable)": ["Variable name (key name in interactive_scope)", 
                                             "Function name to convert input data (string) to actual data stored in interactive_scope",
                                             (optional) "Button name string",
                                             (optional, but if included button name string must be included) "additional codeblock to execute",
                                             (optional, but if included additional codeblock must be included) "placeholder hidden textbox value" ]
            Example: "Start Thermal Stimulation": ["current_task", "String", "Start", "refreshInteraction();", "Thermal Stim"],
        */
        let id_suffix = crypto.randomUUID();
        let button_string = 2 < interactive_settings[prop].length ? interactive_settings[prop][2] : "Submit";
        interactive_DOM += `<div> ${ prop }:`;
        let additional_code_strings = 3 < interactive_settings[prop].length ? interactive_settings[prop][3] : "";
        if (4 < interactive_settings[prop].length) {
            interactive_DOM += `<input type='hidden' id="__interative__${ id_suffix }" value="${ interactive_settings[prop][4] }"/>`;
        } else {
            interactive_DOM += `<input type='text' id="__interative__${ id_suffix }"/>`;
        }
        interactive_DOM += `<input id="__interative__${ id_suffix }-submit" type="submit" value="${ button_string }">`
        interactive_DOM += `<script>
                            interactiveScope['__interactive_settings_id_suffix__' + "${ prop }" + $("#__interative__${ id_suffix }").val()] = "${ id_suffix }";
                            $( "#__interative__${ id_suffix }-submit" ).click(function() {
                            appendLog("Pressed button for interactive settings ${ prop } with value " + $("#__interative__${ id_suffix }").val());
                            sendCommand("log", "interactive_settings_" + "${ prop }", $("#__interative__${ id_suffix }").val());
                            interactiveScope[interactive_settings["${ prop }"][0]] = window[interactive_settings["${ prop }"][1]]($("#__interative__${ id_suffix }").val());
                            ${ additional_code_strings }
                            });
                            </script>`
        interactive_DOM += `</div>`;
    }

    return [runtime_DOM, interactive_DOM];
}

function runUserScript() {
    let script = codeMirrorEditor.getValue();
    let separatedScript = sliceScript(script);
    let interactiveDSL = separatedScript[0], runtimeScript = separatedScript[1];
    let decodedDOM = decodeForInteractiveDSLDOM(interactiveDSL);
    // Reset the interactive scope BEFORE injecting the interactive DOM: the <script>
    // tags in decodedDOM[1] register each button's id-suffix into interactiveScope
    // (see decodeForInteractiveDSLDOM), and those entries must survive into the user
    // script so it can recolour buttons via setInteractiveButtonState(). jQuery runs
    // inline <script> tags synchronously during .html(), i.e. before eval() below.
    interactiveScope = {};
    $("#runtime-display").html(decodedDOM[0]);
    $("#interact-display").html(decodedDOM[1]);
    $("#activated-script-name").html(current_selected_script);
    appendLog('Activating ' + current_selected_script + ' script');
    eval(runtimeScript);
    refreshInteraction();
}

function updateRuntimeDisplay() {
    for (const prop in runtime_display_settings) {
        let id_suffix = runtime_display_settings[prop].replace('.', '-');
        interactiveScope_properties = runtime_display_settings[prop].split(".").reverse();
        content = interactiveScope[interactiveScope_properties[0]];
        remaining_props = interactiveScope_properties.slice(1);
        for (const subprop in remaining_props) {
            content = interactiveScope[remaining_props[subprop]][content];
        }
        $(`#__runtime_display__${ id_suffix }`).html(content);
    }
}

function saveUserScript() {
    let script = codeMirrorEditor.getValue();
    ipcRenderer.send('save-script-content', [script_name, script]);
}

ipcRenderer.on('new-dataframe', (event, arg) => {
    let device_id = arg[0], dataframe = arg[1];
    actionFunction(device_id, dataframe);
    updateRuntimeDisplay();
    renderDataFrame(device_id, dataframe); // TODO: Need to dispatch this to separate thread to avoid performance drag from rendering
});

function makeScriptEntry(script_name) {
    return `<div id="script${ script_name }" onclick="requestSavedScript(this.id)" class="device-entry">
        ${ script_name }
    </div>`;
}

/* Replaces #script-list only — the "Select Scripts" header above it is static
   markup in index.html. Built as one string and inserted once, rather than
   appended entry by entry. */
function populateScriptList(script_list) {
    let panel_DOM = "";
    script_list.forEach(element => {
        panel_DOM += makeScriptEntry(element);
    });

    if (panel_DOM == "") {
        panel_DOM = `<div class="panel-empty-message">No scripts yet — add one to
                     <code>instance/saved_scripts</code>, then press refresh.</div>`;
    }
    $("#script-list").html(panel_DOM);
}

function requestSavedScriptList() {
    ipcRenderer.send('request-script-list');
}

/* The refresh button in the panel header. Only the list is rebuilt: the
   activated script and whatever is in the editor are left alone, since the
   operator may have unsaved edits open while a script is added on disk. */
function refreshSavedScriptList() {
    appendLog("Reloading scripts from instance/saved_scripts");
    requestSavedScriptList();
}

ipcRenderer.on('request-script-list', (event, arg) => {
    populateScriptList(arg);
});

function requestSavedScript(script_id) {
    script_name = script_id.slice(6);
    current_selected_script = script_name;
    ipcRenderer.send('request-script-content', script_name);
}

ipcRenderer.on('request-script-content', (event, arg) => {
    codeMirrorEditor.setValue(arg);
});

/* ===== Action Panel (utility panel, top) =====
   Action scripts (instance/action_scripts) are one-off operations — start a
   device streaming, fire a calibration pulse — rather than experiments. They
   live in the utility panel, which is outside the tab strip, so they stay
   reachable whichever tab is up, and they are loaded and parsed once at
   window load instead of being opened one at a time like the saved scripts.

   Each script is a JSON actionDSL header terminated by an EndofAction marker
   line, followed by the body that runs on the button press:

       {
           "name": "Start Monitoring",              // the button's label
           "parameters": {
               // Display name: [actionScope key, converter, required?]
               "Cathode": ["cathode", "String", "required"]
           }
       }
       // EndofAction
       sendCommand(SOME_DEVICE, "command", actionScope["cathode"]);

   A script that fails to parse is reported to the log panel and skipped; the
   rest of the panel still renders. */

var action_script_files = [];     // file names, in directory order
var action_script_defs = {};      // file name -> parsed definition, absent if it failed to parse
var action_entries = [];          // rendered definitions; the index is what the button passes back
var action_scripts_loading = false; // list requested, reply not back yet
var action_scripts_pending = 0;   // file reads still in flight

/* Resolve a converter name against the global scope, the way interactive_settings
   resolves theirs (window[name]), with dotted paths ("JSON.parse") supported as
   well. The result is bound to its owner so methods keep their receiver. Returns
   null when the name doesn't lead to a function. */
function resolveGlobalFunction(name) {
    let parts = String(name).split('.');
    let owner = window, target = window;
    for (let i = 0; i < parts.length; i++) {
        if (target === null || target === undefined) return null;
        owner = target;
        target = target[parts[i]];
    }
    return (typeof target === 'function') ? target.bind(owner) : null;
}

/* Throws on anything that isn't a well-formed action script — the caller turns
   that into a log line and moves on to the next file. */
function parseActionScript(content) {
    let separated = sliceScriptAt(content, "EndofAction");
    let actionDSL = separated[0], body = separated[1];

    if (actionDSL.trim() == "") {
        throw new Error("no actionDSL header found (is the '// EndofAction' marker line missing?)");
    }

    let jsonFromDSL = JSON.parse(actionDSL); // throws with the position of the offending character
    if (typeof jsonFromDSL.name != "string" || jsonFromDSL.name.trim() == "") {
        throw new Error('actionDSL must declare a non-empty "name" (it is the button label)');
    }

    let parameters = [];
    let declared = jsonFromDSL.parameters;
    if (declared !== undefined && declared !== null) {
        if (typeof declared != "object" || Array.isArray(declared)) {
            throw new Error('"parameters" must be an object of "Display name": [variable, converter, required?]');
        }
        for (const label in declared) {
            let spec = declared[label];
            if (!Array.isArray(spec) || spec.length < 2) {
                throw new Error(`parameter "${ label }" must be [variable, converter, required?]`);
            }
            if (typeof spec[0] != "string" || spec[0].trim() == "") {
                throw new Error(`parameter "${ label }": the actionScope variable name must be a non-empty string`);
            }
            if (typeof spec[1] != "string" || spec[1].trim() == "") {
                throw new Error(`parameter "${ label }": the conversion function name must be a non-empty string`);
            }
            // Anything other than "required" (or a literal true) is optional —
            // "optional" and an omitted third element both land here.
            parameters.push({
                label: label,
                variable: spec[0],
                converter: spec[1],
                required: spec[2] === true || String(spec[2]).toLowerCase() == "required"
            });
        }
    }

    return { name: jsonFromDSL.name, parameters: parameters, body: body };
}

/* The utility panel is narrow, so each parameter stacks its label over its box
   rather than sitting beside it. Required ones are marked with an asterisk.

   Element ids are built from the entry and parameter index, so nothing out of
   the script file reaches the markup: the label and the button label are left
   as empty nodes here and filled in by renderActionPanel() below. (This is why
   there is no crypto.randomUUID() suffix like decodeForInteractiveDSLDOM uses
   — that one has no index to key off, whereas idx is already the handle
   onActionButtonClicked() needs to find the definition in action_entries.) */
function makeActionEntry(idx, action) {
    let rows = "";
    action.parameters.forEach((param, i) => {
        rows += `<div class="action-param">
            <label for="action-${ idx }-param-${ i }"><span id="action-${ idx }-param-${ i }-label"></span>${
                param.required ? '<span class="action-param-required" title="Required">*</span>' : '' }</label>
            <input type="text" id="action-${ idx }-param-${ i }">
        </div>`;
    });

    return `<div class="action-entry" id="action-entry-${ idx }">
        ${ rows }
        <button class="action-run-button" id="action-${ idx }-run"
                onclick="onActionButtonClicked(${ idx })"></button>
    </div>`;
}

/* What to show when the list comes out empty. The three cases read very
   differently to an operator, so they get their own wording: the reads are
   still in flight, the directory holds nothing yet (here is how to put
   something in it), or files were found but not one of them parsed — in which
   case the reason for each is already sitting in the log panel. */
function actionPanelPlaceholder() {
    if (action_scripts_loading || action_scripts_pending > 0) {
        return "Loading action scripts…";
    }
    if (action_script_files.length == 0) {
        return `No actions yet — add a script to <code>instance/action_scripts</code>
                to put one here, then press refresh.`;
    }
    return `No script in <code>instance/action_scripts</code> could be loaded —
            see the log panel for what went wrong with each.`;
}

/* Rebuilt from scratch on every reply rather than appended to, so entries keep
   the directory's order however the reads happen to come back. Only #action-list
   is replaced — the panel header above it is static markup in index.html. */
function renderActionPanel() {
    action_entries = [];
    let panel_DOM = "";

    action_script_files.forEach(file => {
        let action = action_script_defs[file];
        if (!action) return; // never arrived, or failed to parse — already logged
        panel_DOM += makeActionEntry(action_entries.length, action);
        action_entries.push(action);
    });

    if (panel_DOM == "") {
        panel_DOM = `<div class="panel-empty-message">${ actionPanelPlaceholder() }</div>`;
    }
    $("#action-list").html(panel_DOM);

    /* Everything that comes out of a script file goes in as text, never as
       markup — .text()/.attr() escape whatever the DSL happens to contain, so a
       quote or an angle bracket in a name is just a character on screen. */
    action_entries.forEach((action, idx) => {
        action.parameters.forEach((param, i) => {
            $(`#action-${ idx }-param-${ i }-label`).text(param.label);
        });
        $(`#action-${ idx }-run`).text(action.name).attr("title", action.file);
    });
}

function requestActionScriptList() {
    action_scripts_loading = true;
    renderActionPanel(); // shows "Loading…" until the reply lands
    ipcRenderer.send('request-action-script-list');
}

/* The refresh button in the panel header. Everything the panel knows is thrown
   away and rebuilt from the directory, so a script added, edited or fixed while
   the app is running lands without a restart — which is the point, since a
   parse error is usually something the operator goes and corrects. */
function refreshActionScripts() {
    appendLog("Reloading action scripts from instance/action_scripts");
    action_script_files = [];
    action_script_defs = {};
    action_entries = [];
    action_scripts_pending = 0;
    requestActionScriptList(); // raises the loading flag and repaints
}

ipcRenderer.on('request-action-script-list', (event, arg) => {
    action_script_files = arg;
    action_script_defs = {};
    action_scripts_loading = false;
    action_scripts_pending = action_script_files.length;
    renderActionPanel(); // clears whatever was there; entries fill in as the reads return
    action_script_files.forEach(file => {
        ipcRenderer.send('request-action-script-content', file);
    });
});

ipcRenderer.on('request-action-script-content', (event, arg) => {
    let file = arg[0], content = arg[1], read_error = arg[2];
    if (action_scripts_pending > 0) action_scripts_pending--;

    if (content === null) {
        appendLog(`Action script ${ file }: cannot be read — ${ read_error }`);
    } else {
        try {
            let action = parseActionScript(content);
            action.file = file;
            action_script_defs[file] = action;
        } catch (parse_error) {
            appendLog(`Action script ${ file }: ${ parse_error.message }`);
        }
    }

    // Re-rendered on the failing replies too: the last read coming back is what
    // settles the placeholder on its final wording.
    renderActionPanel();
});

/* Reads the entry's inputs into a fresh actionScope and runs the body. Required
   parameters left blank abort the run; blank optional ones are left unset in
   actionScope, so the body can tell "not given" from an empty string. */
function onActionButtonClicked(idx) {
    let action = action_entries[idx];
    if (!action) return;

    let scope = {};
    for (let i = 0; i < action.parameters.length; i++) {
        let param = action.parameters[i];
        let raw = $(`#action-${ idx }-param-${ i }`).val();
        raw = (raw === undefined || raw === null) ? "" : raw;

        if (raw.trim() == "") {
            if (param.required) {
                reportActionError(action, `parameter "${ param.label }" is required`);
                return;
            }
            continue;
        }

        let convert = resolveGlobalFunction(param.converter);
        if (!convert) {
            reportActionError(action, `conversion function "${ param.converter }" for parameter "${ param.label }" is not defined`);
            return;
        }

        try {
            scope[param.variable] = convert(raw);
        } catch (convert_error) {
            reportActionError(action, `converting parameter "${ param.label }" with ${ param.converter }() failed — ${ convert_error.message }`);
            return;
        }
    }

    appendLog(`Running action "${ action.name }" (${ action.file }) with`, scope);
    sendMultipleCommands("log", { "action": action.name, "action_parameters": scope });
    actionScope = scope;
    runActionScript(action);
}

function reportActionError(action, message) {
    let full_message = `Action "${ action.name }" (${ action.file }): ${ message }`;
    appendLog(full_message);
    asyncAlert(full_message);
}

/* Kept as its own function, and with deliberately mangled local names, because
   the body is eval'd here: whatever locals are in scope at the eval shadow the
   globals of the same name for the script that runs. */
function runActionScript(__action_def) {
    try {
        eval(__action_def.body);
    } catch (__action_error) {
        appendLog(`Action "${ __action_def.name }" (${ __action_def.file }) failed: ${ __action_error.message }`);
        asyncAlert(`Action "${ __action_def.name }" failed:\n${ __action_error.message }`);
    } finally {
        // Every run starts from a clean scope — nothing carries over to the next
        // action, or to the next press of this one.
        actionScope = {};
    }
}

/* ===== Device Stats Panel (utility panel, bottom) =====
   Per-device throughput and control-queue depth, polled on a timer rather than
   pushed with the data frames: at a few hundred frames a second the numbers
   would cost more to deliver than they are worth, and one figure a second is
   all an operator can read anyway.

   The backend replies with cumulative totals and its own timestamp (see
   request-device-stats in backend/service.js); the rates are worked out here
   from the difference between two replies. That way a poll that fires late —
   a busy renderer, a throttled timer — divides by the time that actually
   elapsed instead of the interval it was supposed to be. */

const DEVICE_STATS_INTERVAL_MS = 1000;
var device_stats_last = null;      // previous reply, the baseline for the deltas
var device_stats_rendered = null;  // device ids currently built out in the DOM

function requestDeviceStats() {
    ipcRenderer.send('request-device-stats');
}

/* Skipped entirely while the utility panel is shut: nothing to read, so nothing
   worth computing. The baseline is dropped at the same time — on reopening, the
   first reply shows dashes for one cycle rather than a rate averaged across
   however long the panel was closed. */
function startDeviceStatsPolling() {
    setInterval(() => {
        let panel = document.getElementById('utility-panel');
        if (panel && panel.classList.contains('collapsed')) {
            device_stats_last = null;
            return;
        }
        requestDeviceStats();
    }, DEVICE_STATS_INTERVAL_MS);
}

ipcRenderer.on('request-device-stats', (event, arg) => {
    renderDeviceStats(arg);
});

function makeDeviceStatEntry(device_id) {
    return `<div class="device-stat-entry" id="device-stat-${ device_id }">
        <div class="device-stat-head">
            <span class="device-stat-name" id="device-stat-${ device_id }-name"></span>
            <span class="device-stat-status" id="device-stat-${ device_id }-status"></span>
        </div>
        <div class="device-stat-row"><span>In</span>
            <span class="device-stat-value" id="device-stat-${ device_id }-in"></span></div>
        <div class="device-stat-row"><span>Out</span>
            <span class="device-stat-value" id="device-stat-${ device_id }-out"></span></div>
        <div class="device-stat-row"><span>Queue</span>
            <span class="device-stat-value" id="device-stat-${ device_id }-queue"></span></div>
        <div class="device-stat-row device-stat-ping-row" id="device-stat-${ device_id }-ping-row"><span>Ping</span>
            <span class="device-stat-value" id="device-stat-${ device_id }-ping"></span>
            <span class="device-stat-spinner" id="device-stat-${ device_id }-ping-spinner"></span></div>
    </div>`;
}

/* Blank until a wait is long enough to be worth reading — under a poll interval
   it is just the round trip in progress, and a figure that appeared for one
   frame each time would be noise. */
function formatPingWait(wait_ms) {
    if (typeof wait_ms !== "number" || wait_ms < 1000) return "";
    return "waiting " + (wait_ms / 1000).toFixed(1) + " s";
}

/* The spinner is built once with the skeleton and shown or hidden, never
   re-inserted: replacing the element every second would restart its CSS
   animation on each poll and leave it stuttering in place. */
function updateDeviceStatPing(device_id, stat) {
    let row = $(`#device-stat-${ device_id }-ping-row`);
    row.toggleClass("is-active", stat.supports_ping === true);
    if (!stat.supports_ping) {
        return;
    }

    let waiting = (stat.ping_ms === null || stat.ping_ms === undefined);
    $(`#device-stat-${ device_id }-ping-spinner`).toggleClass("is-active", waiting);

    /* While waiting, how long for. A ping is never abandoned, so a spinner that
       keeps turning means one round trip that has genuinely not come back yet —
       and the only question worth answering then is how long it has been. */
    $(`#device-stat-${ device_id }-ping`).text(
        waiting ? formatPingWait(stat.ping_wait_ms)
                : stat.ping_ms.toFixed(stat.ping_ms >= 10 ? 1 : 2) + " ms");
}

/* Rates are only meaningful once there is something to compare against, and a
   disconnected device's totals stop moving, so its rate falls to zero on its
   own without needing a special case. */
function deviceStatRate(current, previous, field, elapsed_s) {
    if (!previous || !(field in previous) || elapsed_s <= 0) return null;
    let delta = current[field] - previous[field];
    if (delta < 0) return null; // counters only ever climb; treat a drop as no reading
    return delta / elapsed_s;
}

function formatRate(rate) {
    if (rate === null) return "—";
    return (rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)) + "/s";
}

function renderDeviceStats(snapshot) {
    let device_ids = Object.keys(snapshot.devices);

    if (device_ids.length == 0) {
        device_stats_rendered = null;
        device_stats_last = null;
        $("#device-stats-list").html(
            `<div class="panel-empty-message">No devices have connected yet.</div>`);
        return;
    }

    /* The skeleton is rebuilt only when the set of devices changes — a device
       connecting for the first time, or the list arriving at all. Every other
       second just writes new text into the spans, which is what keeps a
       once-a-second repaint off the profile. */
    let render_key = device_ids.join(" ");
    if (render_key !== device_stats_rendered) {
        let panel_DOM = "";
        device_ids.forEach(device_id => {
            panel_DOM += makeDeviceStatEntry(device_id);
        });
        $("#device-stats-list").html(panel_DOM);
        device_stats_rendered = render_key;
    }

    let elapsed_s = device_stats_last ? (snapshot.timestamp - device_stats_last.timestamp) / 1000 : 0;

    device_ids.forEach(device_id => {
        let stat = snapshot.devices[device_id];
        let previous = device_stats_last ? device_stats_last.devices[device_id] : null;

        // Written every tick rather than once with the skeleton: a reconnecting
        // device can register a new descriptor, and the name goes in as text
        // because it comes from the device.
        $(`#device-stat-${ device_id }-name`).text(stat.name);

        // Frames are protocol transmissions; a packed device carries many
        // samples in each, so the sample rate is shown beside it when the two
        // differ — otherwise "In" would read 10/s for a device streaming 1 kHz.
        let frame_rate = deviceStatRate(stat, previous, "frames_received", elapsed_s);
        let in_text = formatRate(frame_rate);
        if (frame_rate !== null && stat.samples_received !== stat.frames_received) {
            let sample_rate = deviceStatRate(stat, previous, "samples_received", elapsed_s);
            if (sample_rate !== null) {
                in_text += ` (${ formatRate(sample_rate).replace("/s", "") } smp/s)`;
            }
        }
        $(`#device-stat-${ device_id }-in`).text(in_text);
        $(`#device-stat-${ device_id }-out`).text(
            formatRate(deviceStatRate(stat, previous, "frames_sent", elapsed_s)));

        // A queue that is standing still because the device has not acked yet
        // reads differently from one that is simply busy.
        let queue_text = String(stat.pending_control);
        if (stat.awaiting_reply) queue_text += " (waiting)";
        $(`#device-stat-${ device_id }-queue`).text(queue_text);

        updateDeviceStatPing(device_id, stat);

        let status = $(`#device-stat-${ device_id }-status`);
        status.text(stat.connected ? "Connected" : "Disconnected");
        status.toggleClass("device-stat-connected", stat.connected);
        status.toggleClass("device-stat-disconnected", !stat.connected);
        $(`#device-stat-${ device_id }`).toggleClass("device-stat-offline", !stat.connected);
    });

    device_stats_last = snapshot;
}

/* ===== Local Program Management (device-manage tab) =====
   Callback bookkeeping for program lifecycle returns coming back from the
   main process. Only ONE start-local-program may be in flight at a time:
   start-program-return carries no request id, so serialising starts is what
   ties the returned ref handle to the program we just launched.
     start_program_callback — null when idle, else { on_success, on_error }
     close_program_callback — ref_handle -> function, called once that
                              program is confirmed killed                  */
var start_program_callback = null;
var close_program_callback = {};

/* Returns 0 on success, an error string when another start is in flight.
   on_error is optional: invoked with the error string if the spawn fails,
   so the caller can clean up any optimistic UI it created. */
function addStartProgramCallback(callback, on_error) {
    if (start_program_callback !== null) {
        return "Another program is currently being started, wait for it to finish first";
    }
    start_program_callback = { on_success: callback, on_error: on_error || null };
    return 0;
}

function addCloseProgramCallback(ref_handle, callback) {
    close_program_callback[ref_handle] = callback;
}

ipcRenderer.on('start-program-return', (event, arg) => {
    let pending = start_program_callback;
    start_program_callback = null; // free the slot before running callbacks
    if (typeof arg === 'string') { // error string from the backend
        appendLog('start-local-program failed: ' + arg);
        if (pending && pending.on_error) {
            pending.on_error(arg);
        }
        asyncAlert('Failed to start program:\n' + arg);
        return;
    }
    if (pending && pending.on_success) {
        pending.on_success(arg); // arg is the numerical ref handle
    }
});

ipcRenderer.on('close-program-return', (event, arg) => {
    if (typeof arg === 'string') { // error string from the backend
        appendLog('close-local-program failed: ' + arg);
        asyncAlert('Failed to close program:\n' + arg);
        return;
    }
    if (arg in close_program_callback) { // arg is the ref handle that was killed
        let cb = close_program_callback[arg];
        delete close_program_callback[arg];
        cb(arg);
    }
});

function listProgram() {
    ipcRenderer.send('list-program');
}

/* Full executable paths from the backend, indexed by the entry id suffix.
   Kept out of the DOM so Windows backslash paths never need HTML escaping. */
var local_program_list = [];

function programDisplayName(exec_path) {
    return exec_path.split(/[\\/]/).pop();
}

function makeProgramEntry(idx) {
    return `<div id="program${ idx }" class="device-entry program-entry">
        <span class="program-entry-name">${ programDisplayName(local_program_list[idx]) }</span>
        <button onclick="onProgramStartClicked(${ idx })">Start</button>
    </div>`;
}

function populateProgramList(program_list) {
    local_program_list = program_list;
    $("#program-select-panel").html("");
    local_program_list.forEach((element, idx) => {
        $("#program-select-panel").append(makeProgramEntry(idx));
    });
}

ipcRenderer.on('list-program-return', (event, arg) => {
    populateProgramList(arg);
});

function onProgramStartClicked(idx) {
    let exec_path = local_program_list[idx];
    asyncAlert(`Launch local program "${ programDisplayName(exec_path) }"?`,
               () => { launchLocalProgram(exec_path); });
}

var running_program_count = 0; // unique DOM ids for panel-right entries

function closeLocalProgram(ref_handle) {
    ipcRenderer.send('close-local-program', ref_handle);
}

function launchLocalProgram(exec_path) {
    let exec_name = programDisplayName(exec_path);
    let entry_id = `running-program-${ running_program_count++ }`;

    let err = addStartProgramCallback((ref_handle) => {
        // Program confirmed running: show the handle and arm a Close button.
        appendLog(`Program ${ exec_name } started (handle ${ ref_handle })`);
        let entry = $("#" + entry_id);
        entry.removeClass("program-starting").addClass("program-running");
        entry.find(".running-program-handle").text(ref_handle);
        entry.find(".running-program-status").text("Running");
        // What makes the entry selectable for the output panel: the click
        // handler reads the handle back off here, and entries without one
        // (still starting, or failed to start) are left inert.
        entry.attr("data-ref-handle", ref_handle);
        entry.append(`<button onclick="closeLocalProgram(${ ref_handle })">Close</button>`);

        addCloseProgramCallback(ref_handle, () => {
            // Program confirmed gone — either killed via Close or exited on
            // its own (both arrive through close-program-return for now).
            appendLog(`Program ${ exec_name } (handle ${ ref_handle }) stopped`);
            let closed_entry = $("#" + entry_id);
            closed_entry.removeClass("program-running").addClass("program-closed");
            closed_entry.find(".running-program-status").text("Stopped");
            closed_entry.find("button").remove();
            // Move the entry out of the running list into the stopped list.
            // appendTo moves the element itself, so the handle attribute and any
            // selection survive the move and the entry stays clickable.
            closed_entry.appendTo("#stopped-program-display");
            noteProgramStopped(ref_handle);
        });
    }, (err_msg) => {
        // Spawn failed: keep the entry as a visible record of the failure.
        // The modal itself is raised by the start-program-return listener.
        let failed_entry = $("#" + entry_id);
        failed_entry.removeClass("program-starting").addClass("program-failed");
        failed_entry.find(".running-program-status").text("Failed to start");
        failed_entry.appendTo("#stopped-program-display");
    });
    if (err !== 0) { // another start still in flight — nothing was registered
        appendLog('launchLocalProgram: ' + err);
        asyncAlert('Cannot start program:\n' + err);
        return;
    }

    $("#running-program-display").append(
        `<div id="${ entry_id }" class="running-program-entry program-starting">
            <span class="running-program-handle"></span>
            <span class="running-program-name">${ exec_name }</span>
            <span class="running-program-status">Starting...</span>
        </div>`);

    startLocalProgram(exec_path, []);
}

/* ===== Program Output Panel (device-manage tab) =====
   Shows the stdout/stderr the backend captured for one selected program.

   Fetched on demand and only on demand: selecting an entry pulls once, and
   after that nothing moves until Refresh is pressed. There is no timer here on
   purpose — a program printing at full tilt costs the renderer nothing while
   the operator isn't reading it, and the backend is buffering the output
   regardless (see attachOutputCapture in local-device.js), so a fetch is always
   just a copy of something already in memory.

   Two fetches can therefore be outstanding at once — clicking a second entry
   before the first reply lands, or pressing Refresh on top of a selection.
   Each request carries an id the backend echoes back, and only the reply to the
   newest request is rendered; the rest are dropped. Sequence numbers rather
   than a "one at a time" lock because a dropped or slow reply then costs an
   ignored message instead of wedging the panel. */

var selected_program_handle = null;    // handle whose output the panel is showing, null when none
var program_stdout_seq = 0;            // ever-increasing request id
var program_stdout_pending_seq = 0;    // id of the request whose reply we still want; 0 when idle

function requestProgramStdout(ref_handle) {
    program_stdout_pending_seq = ++program_stdout_seq;
    ipcRenderer.send('request-program-stdout', [ref_handle, program_stdout_pending_seq]);
}

function refreshProgramStdout() {
    if (selected_program_handle === null) return;
    $("#program-stdout-meta").text("Fetching…");
    requestProgramStdout(selected_program_handle);
}

/* Entries live in two containers and move between them when a program stops, so
   the handler is delegated off the document rather than bound per entry.
   Clicks that landed on the Close button are not selections. */
$(document).on('click', '.running-program-entry', function (event) {
    if ($(event.target).closest('button').length) return;
    let ref_handle = $(this).attr('data-ref-handle');
    if (ref_handle === undefined) return; // starting, or never started
    selectProgramForStdout(parseInt(ref_handle, 10), $(this));
});

function selectProgramForStdout(ref_handle, entry) {
    selected_program_handle = ref_handle;

    $(".running-program-entry").removeClass("program-selected");
    entry.addClass("program-selected");

    $("#program-stdout-refresh").prop("disabled", false);
    $("#program-stdout-subject").text(
        entry.find(".running-program-name").text() + "  ·  handle " + ref_handle);
    setProgramStdoutStale(false);
    $("#program-stdout-meta").text("Fetching…");
    $("#program-stdout-display").empty();

    requestProgramStdout(ref_handle);
}

/* A program that exits after its output was last fetched leaves whatever is on
   screen short of its final lines. Nothing is re-fetched for it — that would be
   the automatic updating this panel is built to avoid — so the header just says
   the view is behind and the operator refreshes if they care. */
function noteProgramStopped(ref_handle) {
    if (ref_handle !== selected_program_handle) return;
    setProgramStdoutStale(true);
}

function setProgramStdoutStale(stale) {
    $("#program-stdout-wrapper").toggleClass("stdout-stale", stale);
}

ipcRenderer.on('request-program-stdout', (event, arg) => {
    // Anything that isn't the reply to the newest request is a leftover from a
    // selection the operator has already moved past.
    if (arg.request_id !== program_stdout_pending_seq) return;
    program_stdout_pending_seq = 0;
    if (arg.ref_handle !== selected_program_handle) return;
    renderProgramStdout(arg);
});

function formatByteCount(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* How the program ended, from the exit status the backend recorded. A kill from
   the Close button reports a signal; a program that ended by itself reports a
   code, and a non-zero one is worth pointing at. */
function programExitDescription(reply) {
    if (reply.running) return "running";
    if (reply.exit_signal) return "killed (" + reply.exit_signal + ")";
    if (reply.exit_code === null) return "stopped";
    return reply.exit_code === 0 ? "exited normally" : "exited with code " + reply.exit_code;
}

function renderProgramStdout(reply) {
    let display = document.getElementById('program-stdout-display');
    let meta = document.getElementById('program-stdout-meta');
    if (!display || !meta) return;

    display.textContent = "";

    /* Whether this fetch actually caught up. A snapshot taken while the program
       was still running, of a program the panel has since watched exit, is
       short of its final lines and stays marked — reply.running is the
       backend's word for "there may be more coming", and the entry's class is
       the frontend's for "it has stopped". Clearing this unconditionally would
       drop the mark for a fetch that raced the program's last few writes. */
    setProgramStdoutStale(reply.running === true &&
        $(`.running-program-entry[data-ref-handle="${ reply.ref_handle }"]`)
            .hasClass("program-closed"));

    /* The backend keeps only the last few finished programs' output, so an old
       entry can outlive its log. That is a display state, not an error. */
    if (!reply.found) {
        meta.textContent = "";
        let gone = document.createElement('span');
        gone.className = 'program-stdout-empty';
        gone.textContent = "Output for this program is no longer kept — " +
            "only the most recent finished programs keep theirs.";
        display.appendChild(gone);
        return;
    }

    let meta_parts = [programExitDescription(reply), formatByteCount(reply.bytes) + " held"];
    if (reply.dropped_bytes > 0) {
        // Says plainly that this is a tail, so nobody reads the first line on
        // screen as the first line the program printed.
        meta_parts.push("earliest " + formatByteCount(reply.dropped_bytes) + " dropped");
    }
    meta.textContent = meta_parts.join("  ·  ");

    if (reply.segments.length === 0) {
        let empty = document.createElement('span');
        empty.className = 'program-stdout-empty';
        empty.textContent = reply.running
            ? "No output yet."
            : "This program produced no output.";
        display.appendChild(empty);
        return;
    }

    /* textContent, never innerHTML: this is arbitrary output from an external
       program and it lands in the same DOM as the rest of the app. */
    reply.segments.forEach((segment) => {
        let span = document.createElement('span');
        span.className = segment.stream === 'err' ? 'program-stdout-err' : 'program-stdout-out';
        span.textContent = segment.text;
        display.appendChild(span);
    });

    display.scrollTop = display.scrollHeight;
}

/* THEMES and GLASS_THEMES live in themes.js, loaded just before this file. */

/* The palette currently applied. app-menu.js reads this to tick the right
   entry in the Theme submenu. */
var currentThemeName = null;

function changeTheme(theme_name) {
    const theme = THEMES[theme_name];
    if (!theme) return;
    currentThemeName = theme_name;
    const root = document.documentElement;
    for (const [prop, value] of Object.entries(theme)) {
        root.style.setProperty(prop, value);
    }
    // Activate glassmorphism for Glass palettes
    if (GLASS_THEMES.has(theme_name)) {
        document.body.classList.add('glass');
    } else {
        document.body.classList.remove('glass');
    }
}

ipcRenderer.on('change-theme', (event, theme_name) => {
    changeTheme(theme_name);
});

changeTheme('icefire')

/* ===== Active-view lifecycle wiring =====
   The device-detail tab hosts the live charts: when it's the visible tab the
   chart worker renders, when it's hidden the worker pauses (data keeps flowing
   into its buffers, so charts are current the moment the tab is shown again).
   This is also what stops flotr2's old "target container must be visible" class
   of bug: we never draw into a hidden panel. */
if (window.ViewController) {
    ViewController.register('device-detail-tab', {
        onActivate:   () => { if (window.ChartManager) ChartManager.setTabActive(true); },
        onDeactivate: () => { if (window.ChartManager) ChartManager.setTabActive(false); },
    });
    ViewController.register('script-tab', {}); // no heavy work to gate (yet)
    ViewController.register('device-manage-tab', {}); // no heavy work to gate (yet)
    ViewController.activate('device-detail-tab'); // matches the default active tab
}
