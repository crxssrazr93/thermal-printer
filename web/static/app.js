/* Thermal Printer - browser front end
 *
 * The server owns the hardware and the renderer, so this file is only ever
 * doing three things: editing text, asking the server to re-render it, and
 * posting it to the printer. The preview is a PNG produced by the same code
 * path that drives the print head, not a CSS imitation of it.
 */

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = response.headers.get('Content-Type') || '';
  const body = type.includes('json') ? await response.json() : await response.blob();
  if (!response.ok && type.includes('json')) throw new Error(body.message || 'Request failed');
  return body;
};

const state = {
  presets: [],
  todos: [],
  activePresetId: null,
  printer: {},
};

/* ------------------------------------------------------------------ toast */
let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function status(message) { $('statusMsg').textContent = message; }

/* ------------------------------------------------------------------ theme */
const THEME_KEY = 'tp.theme';
const MODE_KEY = 'tp.mode';

function applyTheme(theme, mode) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  $('themeLabel').textContent = `Theme ${theme}`;
  $('modeLabel').textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
  document.querySelectorAll('.theme-item[data-theme]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.theme === theme));
  });
  localStorage.setItem(THEME_KEY, theme);
  localStorage.setItem(MODE_KEY, mode);
}

function initTheme() {
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(
    localStorage.getItem(THEME_KEY) || '1',
    localStorage.getItem(MODE_KEY) || (prefersLight ? 'light' : 'dark')
  );

  const toggle = $('themeToggle');
  const menu = $('themeMenu');

  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden ? open() : close();
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { close(); toggle.focus(); }
  });

  menu.querySelectorAll('.theme-item[data-theme]').forEach((item) => {
    item.addEventListener('click', () => {
      applyTheme(item.dataset.theme, document.documentElement.dataset.mode);
      close();
    });
  });
  $('modeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
    applyTheme(document.documentElement.dataset.theme, next);
  });
}

/* ------------------------------------------------------------------- tabs */
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });
}

function showView(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  if (name === 'compose') $('editor').focus();
}

/* --------------------------------------------------------------- markdown */
/* Mirrors the desktop toolbar: wrap a selection, prefix whole lines, or drop
 * in a skeleton with the placeholder selected so typing replaces it. */
const editor = () => $('editor');

function replaceRange(start, end, text, selStart, selEnd) {
  const el = editor();
  el.setRangeText(text, start, end, 'end');
  if (selStart !== undefined) el.setSelectionRange(selStart, selEnd ?? selStart);
  el.focus();
  schedulePreview();
}

function wrap(prefix, suffix, placeholder) {
  const el = editor();
  const { selectionStart: a, selectionEnd: b } = el;
  const body = el.value.slice(a, b);
  if (body) {
    replaceRange(a, b, `${prefix}${body}${suffix}`, a, a + prefix.length + body.length + suffix.length);
  } else {
    replaceRange(a, b, `${prefix}${placeholder}${suffix}`, a + prefix.length, a + prefix.length + placeholder.length);
  }
}

const BLOCK_MARKER = /^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;

function prefixLines(marker, numbered = false) {
  const el = editor();
  const value = el.value;
  const startLine = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let endLine = value.indexOf('\n', el.selectionEnd);
  if (endLine === -1) endLine = value.length;

  const lines = value.slice(startLine, endLine).split('\n');
  // reapplying the same marker removes it, so one button toggles a list
  const allMarked = lines.every((line, i) => line.startsWith(numbered ? `${i + 1}. ` : marker));

  const next = lines.map((line, i) => {
    const applied = numbered ? `${i + 1}. ` : marker;
    if (allMarked) return line.slice(applied.length);
    return applied + line.replace(BLOCK_MARKER, '');
  }).join('\n');

  replaceRange(startLine, endLine, next, startLine, startLine + next.length);
}

function insertBlock(text) {
  const el = editor();
  const value = el.value;
  const lineStart = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', el.selectionStart);
  if (lineEnd === -1) lineEnd = value.length;
  const current = value.slice(lineStart, lineEnd);

  // only open a new line when the current one already has something on it
  const at = current.trim() ? lineEnd : lineStart;
  const payload = current.trim() ? `\n${text}` : text;
  replaceRange(at, at, payload, at + payload.length);
}

const MD_ACTIONS = {
  h1: () => prefixLines('# '),
  h2: () => prefixLines('## '),
  h3: () => prefixLines('### '),
  bold: () => wrap('**', '**', 'bold'),
  italic: () => wrap('*', '*', 'italic'),
  strike: () => wrap('~~', '~~', 'strike'),
  code: () => wrap('`', '`', 'code'),
  ul: () => prefixLines('- '),
  ol: () => prefixLines('1. ', true),
  quote: () => prefixLines('> '),
  link: () => wrap('[', '](https://)', 'text'),
  table: () => insertBlock('| Item | Qty |\n|---|---|\n| tea | 2 |\n| jam | 1 |'),
  codeblock: () => insertBlock('```\ncode\n```'),
  rule: () => insertBlock('---'),
  math: () => wrap('$', '$', 'x^2'),
};

function initToolbar() {
  document.querySelectorAll('.tool[data-md]').forEach((button) => {
    button.addEventListener('click', () => MD_ACTIONS[button.dataset.md]?.());
  });
}

/* ---------------------------------------------------------------- preview */
let previewTimer = null;
let previewUrl = null;

function renderOptions() {
  return {
    size: Number($('fontSize').value) || 24,
    darkness: Number($('darkness').value) || 1,
  };
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 260);
}

async function refreshPreview() {
  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: editor().value, options: renderOptions() }),
    });
    if (!response.ok) throw new Error('render failed');
    const blob = await response.blob();
    // revoke the previous object URL or every keystroke leaks a bitmap
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const img = $('preview');
    img.src = previewUrl;
    img.onload = () => {
      $('previewMeta').textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
    };
  } catch (error) {
    $('previewMeta').textContent = 'preview failed';
  }
}

/* -------------------------------------------------------------- connection */
async function refreshState() {
  const data = await api('/api/state');
  state.printer = data;

  const select = $('profileSelect');
  select.innerHTML = '';
  if (!data.profiles.length) {
    select.append(new Option('No saved devices', ''));
  }
  data.profiles.forEach((profile) => {
    const option = new Option(`${profile.name} (${profile.transport})`, profile.name);
    option.selected = profile.name === data.activeProfile;
    select.append(option);
  });

  $('connState').classList.toggle('on', data.connected);
  $('connText').textContent = data.connected ? 'Connected' : 'Disconnected';
  $('connectBtn').textContent = data.connected ? 'Disconnect' : 'Connect';
  $('statusProfile').textContent = data.activeProfile || 'no device';
  $('statusWidth').textContent = `${data.width} px - ${data.dpi} dpi - tear ${data.tearGapMm} mm`;
  $('tearGap').value = data.tearGapMm;

  const capability = $('newCapability');
  if (capability && !capability.options.length) {
    Object.entries(data.capabilityProfiles || {}).forEach(([key, label]) => {
      capability.append(new Option(label, key));
    });
  }

  renderDevices(data.profiles);
}

function initConnection() {
  $('connectBtn').addEventListener('click', async () => {
    const button = $('connectBtn');
    button.disabled = true;
    try {
      if (state.printer.connected) {
        await api('/api/disconnect', { method: 'POST' });
        toast('Disconnected');
      } else {
        const name = $('profileSelect').value;
        if (!name) { toast('Add a device in Settings first', true); return; }
        await api('/api/connect', { method: 'POST', body: JSON.stringify({ profile: name }) });
        toast('Connected');
      }
      await refreshState();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ print */
async function printText(text, label = 'Printed') {
  if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
  const button = $('printBtn');
  button.disabled = true;
  status('Printing...');
  try {
    const result = await api('/api/print', {
      method: 'POST',
      body: JSON.stringify({ text, options: renderOptions() }),
    });
    toast(label);
    status(result.message || 'Ready');
  } catch (error) {
    toast(error.message, true);
    status('Print failed');
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------------------------------------------- presets */
async function loadPresets() {
  const data = await api('/api/presets');
  state.presets = data.presets || [];
  renderPresets();
}

function renderPresets() {
  const list = $('presetList');
  list.innerHTML = '';
  $('presetCount').textContent = `${state.presets.length} saved`;

  if (!state.presets.length) {
    list.innerHTML = '<li class="empty">No presets yet. Write something in Compose and hit "Save as preset".</li>';
    return;
  }

  state.presets
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .forEach((preset) => {
      const lines = (preset.text || '').split('\n').filter(Boolean).length;
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div>
          <div class="name"></div>
          <div class="sub">${lines} line${lines === 1 ? '' : 's'}</div>
        </div>
        <span class="spacer"></span>
        <button class="iconbtn" data-act="open">Open</button>
        <button class="iconbtn" data-act="print">Print</button>
        <button class="iconbtn del" data-act="delete">Delete</button>`;
      li.querySelector('.name').textContent = preset.name;

      li.querySelector('[data-act="open"]').addEventListener('click', () => openPreset(preset));
      li.querySelector('[data-act="print"]').addEventListener('click', () =>
        printText(preset.text, `Printed "${preset.name}"`));
      li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        await api(`/api/presets/${preset.id}`, { method: 'DELETE' });
        if (state.activePresetId === preset.id) {
          state.activePresetId = null;
          $('presetLabel').textContent = 'Untitled';
        }
        await loadPresets();
        toast('Preset deleted');
      });

      list.append(li);
    });
}

function openPreset(preset) {
  editor().value = preset.text || '';
  state.activePresetId = preset.id;
  $('presetLabel').textContent = preset.name;
  showView('compose');
  refreshPreview();
  toast(`Opened "${preset.name}"`);
}

async function savePreset() {
  const existing = state.presets.find((p) => p.id === state.activePresetId);
  const name = prompt('Preset name', existing ? existing.name : '');
  if (name === null) return;
  if (!name.trim()) { toast('A preset needs a name', true); return; }

  // same name overwrites, so saving twice does not litter the list
  const byName = state.presets.find(
    (p) => p.name.toLowerCase() === name.trim().toLowerCase()
  );

  const result = await api('/api/presets', {
    method: 'POST',
    body: JSON.stringify({ id: byName ? byName.id : undefined, name, text: editor().value }),
  });
  state.presets = result.presets;
  state.activePresetId = result.preset.id;
  $('presetLabel').textContent = result.preset.name;
  renderPresets();
  toast(`Saved "${result.preset.name}"`);
}

/* ------------------------------------------------------------------ todos */
async function loadTodos() {
  const data = await api('/api/todos');
  state.todos = data.todos || [];
  renderTodos();
}

function renderTodos() {
  const list = $('todoList');
  list.innerHTML = '';
  const open = state.todos.filter((t) => !t.done).length;
  $('todoCount').textContent = `${open} open`;

  if (!state.todos.length) {
    list.innerHTML = '<li class="empty">Nothing here yet.</li>';
    return;
  }

  state.todos.forEach((todo) => {
    const li = document.createElement('li');
    li.className = `item${todo.done ? ' done' : ''}`;
    li.innerHTML = `
      <input type="checkbox" ${todo.done ? 'checked' : ''} aria-label="Done">
      <div class="name"></div>
      <span class="spacer"></span>
      <button class="iconbtn del" data-act="delete">Delete</button>`;
    li.querySelector('.name').textContent = todo.text;

    li.querySelector('input').addEventListener('change', async (event) => {
      const data = await api(`/api/todos/${todo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: event.target.checked }),
      });
      state.todos = data.todos;
      renderTodos();
    });
    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const data = await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
      state.todos = data.todos;
      renderTodos();
    });

    list.append(li);
  });
}

function todosAsMarkdown() {
  const open = state.todos.filter((t) => !t.done);
  const done = state.todos.filter((t) => t.done);
  const date = new Date().toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
  const lines = [`# To-do`, date, ''];
  open.forEach((t) => lines.push(`- ${t.text}`));
  if (done.length) {
    lines.push('', '> done');
    done.forEach((t) => lines.push(`- ~~${t.text}~~`));
  }
  return lines.join('\n');
}

function initTodos() {
  $('todoForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('todoInput');
    const text = input.value.trim();
    if (!text) return;
    const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ text }) });
    state.todos = data.todos;
    input.value = '';
    renderTodos();
  });

  $('clearDoneBtn').addEventListener('click', async () => {
    const data = await api('/api/todos/clear-done', { method: 'POST' });
    state.todos = data.todos;
    renderTodos();
    toast('Cleared completed items');
  });

  $('printTodosBtn').addEventListener('click', () => {
    if (!state.todos.length) { toast('Nothing to print', true); return; }
    printText(todosAsMarkdown(), 'Printed to-do list');
  });
}

/* --------------------------------------------------------------- settings */
function renderDevices(profiles) {
  const list = $('deviceList');
  if (!list) return;
  list.innerHTML = '';

  if (!profiles.length) {
    list.innerHTML = '<li class="empty">No devices saved yet.</li>';
    return;
  }

  profiles.forEach((profile) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="sub"></div>
      </div>
      <span class="spacer"></span>
      <button class="iconbtn del" data-act="delete">Remove</button>`;
    li.querySelector('.name').textContent = profile.name;
    li.querySelector('.sub').textContent =
      `${profile.transport} - ${profile.address} - tear ${profile.tearGapMm} mm`;

    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      await api(`/api/profiles/${encodeURIComponent(profile.name)}`, { method: 'DELETE' });
      await refreshState();
      toast('Device removed');
    });

    list.append(li);
  });
}

async function scanDevices() {
  const button = $('scanBtn');
  button.disabled = true;
  button.textContent = 'Scanning';
  try {
    const data = await api(`/api/devices?transport=${encodeURIComponent($('newTransport').value)}`);
    const select = $('newDevice');
    select.innerHTML = '';
    if (!data.devices.length) {
      select.append(new Option('Nothing found', ''));
    }
    data.devices.forEach((device) => select.append(new Option(device.label, device.value)));
    if (data.devices.length && !$('newName').value.trim()) {
      $('newName').value = data.devices[0].label.split(' (')[0];
    }
    toast(`${data.devices.length} device(s) found`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Scan';
  }
}

function initSettings() {
  $('scanBtn').addEventListener('click', scanDevices);
  $('newTransport').addEventListener('change', scanDevices);

  $('addDeviceBtn').addEventListener('click', async () => {
    try {
      await api('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: $('newName').value,
          transport: $('newTransport').value,
          address: $('newDevice').value,
          capabilityProfile: $('newCapability').value,
        }),
      });
      await refreshState();
      toast('Device saved');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('saveTearBtn').addEventListener('click', async () => {
    await api('/api/tear-gap', { method: 'POST', body: JSON.stringify({ mm: $('tearGap').value }) });
    await refreshState();
    toast('Tear gap saved');
  });

  $('fontSize').addEventListener('change', refreshPreview);
  $('darkness').addEventListener('change', refreshPreview);
}

/* ------------------------------------------------------------------- boot */
function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'p') { event.preventDefault(); printText(editor().value); }
    if (event.key === 's') { event.preventDefault(); savePreset(); }
  });
}

async function boot() {
  initTheme();
  initTabs();
  initToolbar();
  initConnection();
  initTodos();
  initSettings();
  initShortcuts();

  editor().addEventListener('input', schedulePreview);
  $('printBtn').addEventListener('click', () => printText(editor().value));
  $('savePresetBtn').addEventListener('click', savePreset);

  try {
    await refreshState();
    await Promise.all([loadPresets(), loadTodos()]);
  } catch (error) {
    toast(`Could not reach the server: ${error.message}`, true);
  }

  if (!editor().value) {
    editor().value = '# Groceries\nMilk and eggs.\n- bread\n- butter\n> dont forget the receipt';
  }
  refreshPreview();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
