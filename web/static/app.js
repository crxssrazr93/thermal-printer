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
/* Themes are data. The server merges the built-in manifest with anything in
 * ~/.local/share/thermal-printer/themes, and this file only ever reads that
 * list: it links the stylesheet, builds the menu entry and takes the print
 * font from it. Adding a theme therefore never means editing this file. */
const THEME_KEY = 'tp.theme';
const MODE_KEY = 'tp.mode';

let themes = [];

const themeById = (id) => themes.find((theme) => theme.id === id);

async function loadThemes() {
  try {
    const data = await api('/api/themes');
    themes = data.themes || [];
  } catch (error) {
    themes = [];
  }
  if (!themes.length) {
    // the four built-ins are linked statically, so the UI still works if the
    // manifest is missing or unreadable
    themes = ['1', '2', '3', '4'].map((id) => ({ id, name: `Theme ${id}`, print: {} }));
  }

  themes.forEach((theme) => {
    if (!theme.href || document.querySelector(`link[href="${theme.href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = theme.href;
    document.head.append(link);
  });

  buildThemeMenu();
}

function buildThemeMenu() {
  const menu = $('themeMenu');
  menu.querySelectorAll('.theme-item[data-theme]').forEach((item) => item.remove());
  const separator = menu.querySelector('.theme-sep');

  themes.forEach((theme) => {
    const item = document.createElement('button');
    item.className = 'theme-item';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.theme = theme.id;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const [a, b] = theme.swatch || [];
    if (a) swatch.style.background = `linear-gradient(135deg,${a} 50%,${b || a} 50%)`;

    item.append(swatch, document.createTextNode(theme.name || `Theme ${theme.id}`));
    item.addEventListener('click', () => {
      applyTheme(theme.id, document.documentElement.dataset.mode);
      menu.hidden = true;
      $('themeToggle').setAttribute('aria-expanded', 'false');
    });
    menu.insertBefore(item, separator);
  });
}

function applyTheme(theme, mode) {
  const root = document.documentElement;
  const entry = themeById(theme) || themes[0] || { id: theme };
  theme = entry.id;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  $('themeLabel').textContent = entry.name || `Theme ${theme}`;

  const [a, b] = entry.swatch || [];
  const swatch = $('themeToggle').querySelector('.swatch');
  if (a && swatch) swatch.style.background = `linear-gradient(135deg,${a} 50%,${b || a} 50%)`;
  $('modeLabel').textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
  document.querySelectorAll('.theme-item[data-theme]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.theme === theme));
  });
  localStorage.setItem(THEME_KEY, theme);
  localStorage.setItem(MODE_KEY, mode);
  applyThemePrintDefaults(theme);
}

function initTheme() {
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(
    themeById(saved) ? saved : (themes[0] && themes[0].id) || '1',
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
  if (name === 'todos') refreshTodoPreview();
}

/* --------------------------------------------------------------- markdown */
/* Mirrors the desktop toolbar: wrap a selection, prefix whole lines, or drop
 * in a skeleton with the placeholder selected so typing replaces it. */
/* Indirection so the same helpers can drive the compose textarea or the one
 * in the preset editor; withPresetTextarea swaps this for one action. */
let editorTarget = () => $('editor');
const editor = () => editorTarget();

function replaceRange(start, end, text, selStart, selEnd) {
  const el = editor();
  el.setRangeText(text, start, end, 'end');
  if (selStart !== undefined) el.setSelectionRange(selStart, selEnd ?? selStart);
  el.focus();
  // setRangeText fires no input event, so the preview has to be told
  if (el.id === 'editor') schedulePreview();
}

/* --------------------------------------------------------- rendered editor */
/* Two editors over one document, and markdown is the document. Rendered mode
 * is a real rich surface, so a heading is a heading and a table is a table you
 * can type into rather than a row of pipes. Raw mode is the markdown itself.
 * Switching between them converts, and whichever is showing, markdown is what
 * gets previewed, printed and saved. */
const EDITOR_MODE_KEY = 'tp.editorMode';

const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const rich = () => $('rich');
const isRendered = () => !$('editorShell').classList.contains('raw');

/* ------------------------------------------------------- markdown to html */
function inlineToHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) =>
      `<a href="${href}">${label}</a>`)
    .replace(/~~([^~]+)~~/g, (_m, body) => `<del>${body}</del>`)
    .replace(/(?<!\w)(?:\*\*|__)(?=\S)([\s\S]*?\S)(?:\*\*|__)(?!\w)/g,
      (_m, body) => `<strong>${body}</strong>`)
    .replace(/(?<![\w*_])[*_]([^*_\s][^*_]*?)[*_](?![\w*_])/g,
      (_m, body) => `<em>${body}</em>`);
}

function tableToHtml(rows) {
  const head = rows[0] || [];
  const body = rows.slice(1);
  const width = Math.max(...rows.map((r) => r.length), 1);
  const cells = (row, tag) => Array.from({ length: width }, (_v, i) =>
    `<${tag}>${inlineToHtml(row[i] || '') || '<br>'}</${tag}>`).join('');
  // A colgroup plus a fixed layout is what stops the columns jumping about
  // while a cell is being typed into; without it every keystroke re-measures
  // the whole table.
  const cols = Array.from({ length: width },
    () => `<col style="width:${(100 / width).toFixed(4)}%">`).join('');
  return `<table><colgroup>${cols}</colgroup><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${
    body.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table>`;
}

/* Column widths are a view concern, not part of the document: markdown has no
 * place to keep them, so they live for as long as the table is on screen and
 * a drag never changes what gets printed. */
function decorateTables() {
  rich().querySelectorAll('table').forEach((table) => {
    const width = table.querySelector('tr')?.children.length || 0;
    if (!width) return;

    let group = table.querySelector('colgroup');
    if (!group || group.children.length !== width) {
      group?.remove();
      group = document.createElement('colgroup');
      for (let i = 0; i < width; i += 1) {
        const col = document.createElement('col');
        col.style.width = `${(100 / width).toFixed(4)}%`;
        group.append(col);
      }
      table.prepend(group);
    }

    Array.from(table.querySelectorAll('th')).forEach((th, index) => {
      if (index >= width - 1 || th.querySelector('.col-grip')) return;
      const grip = document.createElement('span');
      grip.className = 'col-grip';
      grip.contentEditable = 'false';
      grip.setAttribute('aria-hidden', 'true');
      th.append(grip);
    });
  });
}

function initColumnResize() {
  let drag = null;

  rich().addEventListener('mousedown', (event) => {
    const grip = event.target.closest?.('.col-grip');
    if (!grip) return;
    event.preventDefault();

    const cell = grip.parentElement;
    const table = cell.closest('table');
    const index = cellIndex(cell);
    const cols = Array.from(table.querySelectorAll('col'));
    const widths = Array.from(table.querySelectorAll('th')).map((th) => th.offsetWidth);
    cols.forEach((col, i) => { col.style.width = `${widths[i]}px`; });

    drag = { table, cols, index, startX: event.clientX, a: widths[index], b: widths[index + 1] };
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (event) => {
    if (!drag) return;
    // the pair of columns either side of the grip trade width, so the table
    // itself never changes size
    const delta = Math.max(-drag.a + 44, Math.min(drag.b - 44, event.clientX - drag.startX));
    drag.cols[drag.index].style.width = `${drag.a + delta}px`;
    drag.cols[drag.index + 1].style.width = `${drag.b - delta}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = '';
  });
}

function mdToHtml(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }

    if (!trimmed) { i += 1; continue; }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    if (isTableLine(line)) {
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) {
        if (!isSeparatorRow(lines[i])) rows.push(tableCells(lines[i]));
        i += 1;
      }
      out.push(tableToHtml(rows));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inlineToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${quoted.map(inlineToHtml).join('<br>')}</blockquote>`);
      continue;
    }

    const bullet = /^[-*+]\s+/;
    const numbered = /^\d+[.)]\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const items = [];
      const marker = ordered ? numbered : bullet;
      while (i < lines.length && marker.test(lines[i].trim())) {
        items.push(inlineToHtml(lines[i].trim().replace(marker, '')));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
      continue;
    }

    // one paragraph per typed line, the same rule the printer follows
    out.push(`<p>${inlineToHtml(trimmed)}</p>`);
    i += 1;
  }

  return out.join('') || '<p><br></p>';
}

/* ------------------------------------------------------- html to markdown */
function inlineToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const inner = Array.from(node.childNodes).map(inlineToMd).join('');
  switch (node.nodeName) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': return inner.trim() ? `**${inner.trim()}**` : '';
    case 'EM': case 'I': return inner.trim() ? `*${inner.trim()}*` : '';
    case 'DEL': case 'S': case 'STRIKE': return inner.trim() ? `~~${inner.trim()}~~` : '';
    case 'CODE': return inner.trim() ? `\`${inner.trim()}\`` : '';
    case 'A': return `[${inner}](${node.getAttribute('href') || ''})`;
    default: return inner;
  }
}

const cellText = (cell) => inlineToMd(cell).replace(/\n/g, ' ').trim();

function blockToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue.trim();
    return text ? [text] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];

  const name = node.nodeName;
  const inline = () => inlineToMd(node).split('\n').map((l) => l.trim());

  if (/^H[1-6]$/.test(name)) return [`${'#'.repeat(Number(name[1]))} ${inlineToMd(node).trim()}`];
  if (name === 'HR') return ['---'];
  if (name === 'PRE') return ['```', ...(node.textContent || '').split('\n'), '```'];
  if (name === 'BLOCKQUOTE') {
    return inline().filter((l, i, all) => l || i < all.length - 1).map((l) => `> ${l}`.trimEnd());
  }
  if (name === 'UL' || name === 'OL') {
    return Array.from(node.children).map((li, index) =>
      `${name === 'OL' ? `${index + 1}.` : '-'} ${inlineToMd(li).trim()}`);
  }
  if (name === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.children).map(cellText));
    if (!rows.length) return [];
    return formatTable([rows[0], null, ...rows.slice(1)]).split('\n');
  }
  if (name === 'DIV' && node.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,div,p')) {
    // Chrome sometimes nests blocks inside a wrapper div; walk into it
    return Array.from(node.childNodes).flatMap(blockToMd);
  }
  return inline();
}

function htmlToMd(root) {
  const blocks = Array.from(root.childNodes).map(blockToMd).filter((b) => b.length);
  const out = [];
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    // tables and code fences need a blank line before them to parse back
    const needsGap = previous && (block[0].startsWith('|') || block[0] === '```'
      || previous[0].startsWith('|') || previous[previous.length - 1] === '```');
    if (needsGap) out.push('');
    out.push(...block);
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* -------------------------------------------------------------- the document */
/* One accessor for the text, whichever surface is in front. */
function editorMarkdown() {
  return isRendered() ? htmlToMd(rich()) : $('editor').value;
}

function setEditorMarkdown(md) {
  $('editor').value = md;
  rich().innerHTML = mdToHtml(md);
  decorateTables();
}

function setEditorMode(mode) {
  const shell = $('editorShell');
  const raw = mode === 'raw';
  const wasRaw = shell.classList.contains('raw');

  if (raw && !wasRaw) $('editor').value = htmlToMd(rich());
  if (!raw && wasRaw) { rich().innerHTML = mdToHtml($('editor').value); decorateTables(); }

  shell.classList.toggle('raw', raw);
  $('modeRendered').setAttribute('aria-pressed', String(!raw));
  $('modeRaw').setAttribute('aria-pressed', String(raw));
  localStorage.setItem(EDITOR_MODE_KEY, raw ? 'raw' : 'rendered');
  (raw ? $('editor') : rich()).focus();
}

function initEditorModes() {
  $('modeRendered').addEventListener('click', () => setEditorMode('rendered'));
  $('modeRaw').addEventListener('click', () => setEditorMode('raw'));

  document.execCommand('defaultParagraphSeparator', false, 'p');

  rich().addEventListener('input', () => { decorateTables(); schedulePreview(); });
  // Tab walks the cells of a table rather than leaving the editor, which is
  // the one thing that makes a table in a document usable
  rich().addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const cell = selectionCell();
    if (!cell) return;
    event.preventDefault();
    moveCell(cell, event.shiftKey ? -1 : 1);
  });

  setEditorMode(localStorage.getItem(EDITOR_MODE_KEY) === 'raw' ? 'raw' : 'rendered');
  initTableTools();
  initColumnResize();
}

/* ------------------------------------------------------------ table editing */
function selectionCell() {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).startContainer;
  while (node && node !== rich()) {
    if (node.nodeType === Node.ELEMENT_NODE && /^T[DH]$/.test(node.nodeName)) return node;
    node = node.parentNode;
  }
  return null;
}

function caretInto(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function moveCell(cell, step) {
  const table = cell.closest('table');
  const cells = Array.from(table.querySelectorAll('th,td'));
  const next = cells[cells.indexOf(cell) + step];
  if (next) { caretInto(next); return; }
  if (step > 0) { addTableRow(table); caretInto(table.querySelector('tbody tr:last-child td')); }
}

/* --------------------------------------------------- table row and column */
function cellIndex(cell) {
  return Array.from(cell.parentElement.children).indexOf(cell);
}

function insertColumn(table, at) {
  Array.from(table.querySelectorAll('tr')).forEach((row) => {
    const isHead = row.children[0] && row.children[0].nodeName === 'TH';
    const cell = document.createElement(isHead ? 'th' : 'td');
    cell.innerHTML = '<br>';
    const reference = row.children[at + 1];
    if (reference) row.insertBefore(cell, reference);
    else row.append(cell);
  });
}

function deleteColumn(table, at) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows[0].children.length <= 1) { table.remove(); return; }
  rows.forEach((row) => row.children[at]?.remove());
}

const TABLE_TOOLS = {
  'row-after': (cell, table) => {
    const row = addTableRow(table, cell.closest('tr'));
    caretInto(row.children[cellIndex(cell)] || row.children[0]);
  },
  'col-after': (cell, table) => {
    const at = cellIndex(cell);
    insertColumn(table, at);
    decorateTables();
    caretInto(cell.parentElement.children[at + 1]);
  },
  'row-delete': (cell, table) => {
    const row = cell.closest('tr');
    // the header carries the column names, so removing it takes the table
    if (row.parentElement.nodeName === 'THEAD' || table.querySelectorAll('tr').length <= 1) {
      table.remove();
      return;
    }
    row.remove();
  },
  'col-delete': (cell, table) => { deleteColumn(table, cellIndex(cell)); decorateTables(); },
};

/* The caret leaves the table the moment a button takes focus, so the cell it
 * was in is remembered on the way out. */
let lastCell = null;

function positionTableTools() {
  const tools = $('tableTools');
  const cell = selectionCell() || (document.activeElement === rich() ? lastCell : lastCell);
  const table = cell && rich().contains(cell) ? cell.closest('table') : null;

  if (!table || !isRendered()) { tools.hidden = true; return; }
  lastCell = cell;

  const shell = $('editorShell').getBoundingClientRect();
  const box = table.getBoundingClientRect();
  tools.hidden = false;
  tools.style.left = `${Math.max(6, box.left - shell.left)}px`;
  tools.style.top = `${Math.max(4, box.top - shell.top - tools.offsetHeight - 6)}px`;
}

function initTableTools() {
  const tools = $('tableTools');
  tools.querySelectorAll('[data-table]').forEach((button) => {
    // mousedown, so the action runs before the caret is lost to the button
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const cell = selectionCell() || lastCell;
      const table = cell && cell.closest('table');
      if (!table) return;
      TABLE_TOOLS[button.dataset.table]?.(cell, table);
      schedulePreview();
      positionTableTools();
    });
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === rich()) positionTableTools();
  });
  rich().addEventListener('click', positionTableTools);
  rich().addEventListener('blur', () => {
    // keep them up while a control is being clicked, hide otherwise
    setTimeout(() => {
      if (!$('tableTools').contains(document.activeElement)) $('tableTools').hidden = true;
    }, 150);
  });
}

function addTableRow(table, after) {
  const width = table.querySelector('tr').children.length;
  const body = table.querySelector('tbody') || table;
  const row = document.createElement('tr');
  for (let i = 0; i < width; i += 1) {
    const cell = document.createElement('td');
    cell.innerHTML = '<br>';
    row.append(cell);
  }
  if (after && after.parentElement === body) after.after(row);
  else body.append(row);
  schedulePreview();
  return row;
}

function insertRichTable(rows) {
  const html = tableToHtml(rows && rows.length ? rows : [['Item', 'Qty'], ['tea', '2'], ['jam', '1']]);
  document.execCommand('insertHTML', false, `${html}<p><br></p>`);
  decorateTables();
  const table = rich().querySelector('table:not([data-seen])');
  if (table) {
    table.setAttribute('data-seen', '1');
    caretInto(table.querySelector('th'));
  }
  schedulePreview();
}

/* ---------------------------------------------------------- rich commands */
function wrapSelection(tag) {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const element = document.createElement(tag);
  element.append(range.extractContents());
  range.insertNode(element);
  schedulePreview();
}

const RICH_ACTIONS = {
  h1: () => document.execCommand('formatBlock', false, 'h1'),
  h2: () => document.execCommand('formatBlock', false, 'h2'),
  h3: () => document.execCommand('formatBlock', false, 'h3'),
  bold: () => document.execCommand('bold'),
  italic: () => document.execCommand('italic'),
  strike: () => document.execCommand('strikeThrough'),
  code: () => wrapSelection('code'),
  ul: () => document.execCommand('insertUnorderedList'),
  ol: () => document.execCommand('insertOrderedList'),
  quote: () => document.execCommand('formatBlock', false, 'blockquote'),
  rule: () => document.execCommand('insertHorizontalRule'),
  codeblock: () => document.execCommand('formatBlock', false, 'pre'),
  math: () => wrapSelection('code'),
  link: () => {
    const href = window.prompt('Link address', 'https://');
    if (!href) return;
    const selection = window.getSelection();
    if (selection.isCollapsed) document.execCommand('insertHTML', false, `<a href="${href}">${href}</a>`);
    else document.execCommand('createLink', false, href);
  },
  // a selected comma separated list becomes a real table, which is how this
  // data usually arrives
  table: () => {
    const selected = window.getSelection().toString().trim();
    const rows = selected
      ? selected.split('\n').map((line) => line.trim()).filter(Boolean).map(splitCells)
      : null;
    insertRichTable(rows && rows.length && (rows.length > 1 || rows[0].length > 1) ? rows : null);
  },
};


const isWrapped = (text, prefix, suffix) =>
  text.length >= prefix.length + suffix.length &&
  text.startsWith(prefix) && text.endsWith(suffix);

/* Find the marked-up span the caret is sitting inside, so pressing the button
 * again with no selection removes the markers rather than nesting new ones. */
function enclosingSpan(value, caret, prefix, suffix) {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = value.indexOf('\n', caret);
  if (lineEnd === -1) lineEnd = value.length;

  const open = value.lastIndexOf(prefix, caret - 1);
  if (open < lineStart) return null;

  const close = value.indexOf(suffix, Math.max(open + prefix.length, caret));
  if (close === -1 || close + suffix.length > lineEnd) return null;

  // a single "*" sitting next to another is part of "**", a different marker
  if (prefix.length === 1 &&
      (value[open - 1] === prefix || value[open + 1] === prefix ||
       value[close - 1] === suffix || value[close + 1] === suffix)) {
    return null;
  }
  return { start: open, end: close + suffix.length };
}

/* Inline emphasis. Applying it twice takes it off again, and the behaviour
 * follows what is selected: nothing, part of a line, or several lines. */
function toggleWrap(prefix, suffix, placeholder) {
  const el = editor();
  const value = el.value;
  const a = el.selectionStart;
  const b = el.selectionEnd;

  // --- no selection: unwrap where the caret is, else drop in a placeholder
  if (a === b) {
    const span = enclosingSpan(value, a, prefix, suffix);
    if (span) {
      const inner = value.slice(span.start + prefix.length, span.end - suffix.length);
      replaceRange(span.start, span.end, inner, span.start, span.start + inner.length);
    } else {
      replaceRange(a, b, `${prefix}${placeholder}${suffix}`,
        a + prefix.length, a + prefix.length + placeholder.length);
    }
    return;
  }

  const selected = value.slice(a, b);

  // --- several lines: emphasis does not survive a newline in markdown, so
  //     each line is marked on its own, and indentation is left alone.
  //     The range snaps out to whole lines first, since a drag that stops
  //     mid-word would otherwise emphasise half of it.
  if (selected.includes('\n')) {
    const start = value.lastIndexOf('\n', a - 1) + 1;
    let end = value.indexOf('\n', b);
    if (end === -1) end = value.length;

    const lines = value.slice(start, end).split('\n');
    const filled = lines.filter((line) => line.trim());
    const allWrapped = filled.length > 0 &&
      filled.every((line) => isWrapped(line.trim(), prefix, suffix));

    const next = lines.map((line) => {
      const body = line.trim();
      if (!body) return line;
      const indent = line.slice(0, line.indexOf(body));
      return indent + (allWrapped
        ? body.slice(prefix.length, body.length - suffix.length)
        : `${prefix}${body}${suffix}`);
    }).join('\n');

    replaceRange(start, end, next, start, start + next.length);
    return;
  }

  // --- the selection itself carries the markers
  if (isWrapped(selected, prefix, suffix)) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    replaceRange(a, b, inner, a, a + inner.length);
    return;
  }

  // --- the markers sit just outside the selection
  if (value.slice(a - prefix.length, a) === prefix &&
      value.slice(b, b + suffix.length) === suffix) {
    const start = a - prefix.length;
    replaceRange(start, b + suffix.length, selected, start, start + selected.length);
    return;
  }

  replaceRange(a, b, `${prefix}${selected}${suffix}`,
    a, a + prefix.length + selected.length + suffix.length);
}

/* Not a toggle: the closing half carries the url, so there is nothing
 * symmetrical to detect and removing it would silently drop the target. */
function insertLink() {
  const el = editor();
  const { selectionStart: a, selectionEnd: b } = el;
  const label = el.value.slice(a, b) || 'text';
  const text = `[${label}](https://)`;
  // leave the url selected, since that is what still needs typing
  const urlAt = a + label.length + 3;
  replaceRange(a, b, text, urlAt, urlAt + 8);
}

/* Split one line into cells. Commas, tabs and semicolons all count as
 * separators, and quotes protect a comma that belongs to the value. */
function splitCells(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (const char of line) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === ',' || char === '\t' || char === ';')) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/* Turn a pasted comma or tab separated list into a markdown table, so the
 * usual way this data arrives does not have to be retyped by hand. */
function listToTable(text) {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map(splitCells);
  if (!rows.length) return null;

  const width = Math.max(...rows.map((r) => r.length));
  // a single cell is just a word; there is no table to build from it
  if (width < 2 && rows.length < 2) return null;

  const padded = rows.map((row) => {
    const cells = row.slice();
    while (cells.length < width) cells.push('');
    return cells;
  });

  // one line of values reads as headings, so leave an empty row to type into
  const header = padded[0];
  const body = padded.length > 1 ? padded.slice(1) : [new Array(width).fill(' ')];

  return formatTable([header, null, ...body]);
}

/* Markdown tables are only as readable as their columns are straight, so a
 * table is written back out padded to its widest cell. In a monospace editor
 * that is what turns pipes and dashes into something you can actually read as
 * a grid: the source stays plain markdown, and it lines up. A null row is the
 * header separator, whose dashes are drawn to the same measured width. */
function formatTable(rows) {
  const widths = [];
  rows.filter(Boolean).forEach((row) => {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).trim().length, 3);
    });
  });

  return rows.map((row) => {
    if (!row) return `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
    return `| ${widths.map((w, i) => String(row[i] ?? '').trim().padEnd(w)).join(' | ')} |`;
  }).join('\n');
}

const isTableLine = (line) => /^\s*\|/.test(line) && line.trim().endsWith('|');
const isSeparatorRow = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/* Re-align every table in the document. Cheap enough to run on each edit, and
 * it keeps a table straight while it is being typed into rather than only at
 * the moment it is inserted. */
function realignTables(text) {
  const lines = text.split('\n');
  const out = [];
  let block = [];

  const flush = () => {
    if (!block.length) return;
    if (block.length > 1) {
      const rows = block.map((line) => (isSeparatorRow(line) ? null : tableCells(line)));
      out.push(...formatTable(rows).split('\n'));
    } else {
      out.push(...block);
    }
    block = [];
  };

  lines.forEach((line) => {
    if (isTableLine(line)) { block.push(line); return; }
    flush();
    out.push(line);
  });
  flush();
  return out.join('\n');
}

/* Applied on a pause rather than on every keystroke, since re-padding under
 * the caret while someone is mid-word would fight their typing. */
function alignTablesInEditor() {
  const el = $('editor');
  const next = realignTables(el.value);
  if (next === el.value) return;

  // keep the caret on the same cell by counting pipes rather than characters,
  // which move as the padding changes
  const before = el.value.slice(0, el.selectionStart);
  const pipes = (before.match(/\|/g) || []).length;
  const lineIndex = before.split('\n').length - 1;

  el.value = next;
  const lines = next.split('\n');
  if (lineIndex < lines.length) {
    let offset = lines.slice(0, lineIndex).reduce((n, l) => n + l.length + 1, 0);
    const line = lines[lineIndex];
    let seen = (next.slice(0, offset).match(/\|/g) || []).length;
    let at = 0;
    while (at < line.length && seen < pipes) {
      if (line[at] === '|') seen += 1;
      at += 1;
    }
    el.setSelectionRange(offset + at, offset + at);
  }
  schedulePreview();
}

function insertTable() {
  const el = editor();
  const { selectionStart: a, selectionEnd: b } = el;
  const selected = el.value.slice(a, b).trim();

  if (selected) {
    const table = listToTable(selected);
    if (table) {
      replaceRange(a, b, table, a, a + table.length);
      return;
    }
  }
  insertBlock(formatTable([['Item', 'Qty'], null, ['tea', '2'], ['jam', '1']]));
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
  bold: () => toggleWrap('**', '**', 'bold'),
  italic: () => toggleWrap('*', '*', 'italic'),
  strike: () => toggleWrap('~~', '~~', 'strike'),
  code: () => toggleWrap('`', '`', 'code'),
  ul: () => prefixLines('- '),
  ol: () => prefixLines('1. ', true),
  quote: () => prefixLines('> '),
  link: () => insertLink(),
  table: () => insertTable(),
  codeblock: () => insertBlock('```\ncode\n```'),
  rule: () => insertBlock('---'),
  math: () => toggleWrap('$', '$', 'x^2'),
};

/* The toolbar drives whichever surface is in front: rich commands on the
 * rendered document, text manipulation on the markdown source. The preset
 * editor always has a plain textarea, so it always takes the text path. */
function initToolbar() {
  document.querySelectorAll('.tool[data-md]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.md;
      if (isRendered()) {
        rich().focus();
        RICH_ACTIONS[action]?.();
        schedulePreview();
        return;
      }
      MD_ACTIONS[action]?.();
    });
  });
}

/* ---------------------------------------------------------------- preview */
/* Three panes want previews (compose, to-dos, the preset editor) and they all
 * render the same way, so one function serves all of them. Each keeps its own
 * object URL so revoking one cannot blank another. */
const previewUrls = {};

/* Each theme carries its own printing voice, not just its own chrome: the font
 * is what the paper actually looks like, so a theme that leaves it alone is
 * only ever skin-deep. The pairing lives in the theme manifest next to the
 * stylesheet, which is what makes a user theme able to bring its own. */
const themePrint = (id) => (themeById(id) || {}).print || {};

const FONT_KEY = 'tp.font';
const SIZE_KEY = 'tp.size';
const FONT_PINNED = 'tp.fontPinned';

function currentFont() {
  return $('fontFamily').value || localStorage.getItem(FONT_KEY) || 'DejaVuSansMono';
}

/* A theme sets the page as well as the screen: its manifest carries the print
 * font and a small set of typographic choices (heading treatment, rules,
 * bullet, spacing) that the server's renderer honours. Font and size can be
 * overridden per preset or by hand; the setting stays with the theme. */
function themeStyle() {
  const print = themePrint(document.documentElement.dataset.theme);
  return { style: print.style || {}, line_spacing: print.line_spacing };
}

function renderOptions() {
  return {
    font: currentFont(),
    size: Number($('fontSize').value) || 24,
    darkness: Number($('darkness').value) || 1,
    ...themeStyle(),
  };
}

/* presets store their own font and size but not the setting, which follows
 * whichever theme is in use when they print */
const withThemeStyle = (options) => ({ ...(options || {}), ...themeStyle() });

/* keep the Settings pane and the compose toolbar showing the same thing */
function setPrintFont(font, size, { pin = false } = {}) {
  [['fontFamily', font], ['fontQuick', font],
   ['fontSize', size], ['sizeQuick', size]].forEach(([id, value]) => {
    if ($(id) && value !== undefined && value !== null) $(id).value = value;
  });
  if (font) localStorage.setItem(FONT_KEY, font);
  if (size) localStorage.setItem(SIZE_KEY, size);
  if (pin) localStorage.setItem(FONT_PINNED, '1');
  refreshPreview();
}

/* Applied on theme change unless the font was chosen by hand, since silently
 * overriding a deliberate choice is worse than a theme looking less distinct. */
function applyThemePrintDefaults(theme) {
  if (localStorage.getItem(FONT_PINNED) === '1') return;
  const preset = themePrint(theme);
  if (!preset || !fontList.length) return;
  const font = fontList.includes(preset.font) ? preset.font : currentFont();
  setPrintFont(font, preset.size);
}

let fontList = [];

async function loadFonts() {
  const data = await api('/api/fonts');
  fontList = data.fonts || [];

  ['fontFamily', 'fontQuick', 'presetFont'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    select.innerHTML = '';
    fontList.forEach((name) => select.append(new Option(name, name)));
  });

  const theme = document.documentElement.dataset.theme;
  const pinned = localStorage.getItem(FONT_PINNED) === '1';
  const saved = localStorage.getItem(FONT_KEY);
  const savedSize = Number(localStorage.getItem(SIZE_KEY)) || undefined;

  if (pinned && saved && fontList.includes(saved)) {
    setPrintFont(saved, savedSize || 24);
  } else {
    const preset = themePrint(theme);
    const font = fontList.includes(preset.font) ? preset.font
      : (fontList.includes('DejaVuSansMono') ? 'DejaVuSansMono' : fontList[0]);
    setPrintFont(font, preset.size || 24);
  }
}

function initFontControls() {
  const pinAndRender = (font, size) => setPrintFont(font, size, { pin: true });

  $('fontFamily').addEventListener('change', () =>
    pinAndRender($('fontFamily').value, undefined));
  $('fontQuick').addEventListener('change', () =>
    pinAndRender($('fontQuick').value, undefined));
  $('fontSize').addEventListener('change', () =>
    pinAndRender(undefined, Number($('fontSize').value)));
  $('sizeQuick').addEventListener('change', () =>
    pinAndRender(undefined, Number($('sizeQuick').value)));
}

async function renderInto(key, text, img, meta, options) {
  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, options: options ? withThemeStyle(options) : renderOptions() }),
    });
    if (!response.ok) throw new Error('render failed');
    const blob = await response.blob();
    // revoke the previous URL or every keystroke leaks a bitmap
    if (previewUrls[key]) URL.revokeObjectURL(previewUrls[key]);
    previewUrls[key] = URL.createObjectURL(blob);
    img.src = previewUrls[key];
    img.onload = () => { meta.textContent = `${img.naturalWidth} x ${img.naturalHeight}`; };
  } catch (error) {
    meta.textContent = 'preview failed';
  }
}

/* debounce per pane so typing in one does not cancel another's refresh */
const timers = {};
function debounce(key, fn, wait = 260) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, wait);
}

const refreshPreview = () => renderInto('compose', editorMarkdown(), $('preview'), $('previewMeta'));
const schedulePreview = () => debounce('compose', refreshPreview);

const refreshTodoPreview = () =>
  renderInto('todos', todosAsMarkdown(), $('todoPreview'), $('todoPreviewMeta'));
const scheduleTodoPreview = () => debounce('todos', refreshTodoPreview);

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
async function printText(text, label = 'Printed', options) {
  if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
  const button = $('printBtn');
  button.disabled = true;
  status('Printing...');
  try {
    const result = await api('/api/print', {
      method: 'POST',
      body: JSON.stringify({ text, options: options ? withThemeStyle(options) : renderOptions() }),
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
    list.innerHTML = '<li class="empty">No presets yet. Use "New preset", or write something in Compose and hit "Save as preset".</li>';
    return;
  }

  state.presets
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .forEach((preset) => {
      const lines = (preset.text || '').split('\n').filter(Boolean).length;
      const bits = [`${lines} line${lines === 1 ? '' : 's'}`];
      if (preset.description) bits.unshift(preset.description);
      if (preset.options?.size) bits.push(`${preset.options.size}px`);

      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div>
          <div class="name"></div>
          <div class="sub"></div>
        </div>
        <span class="spacer"></span>
        <button class="iconbtn" data-act="open">Open</button>
        <button class="iconbtn" data-act="edit">Edit</button>
        <button class="iconbtn" data-act="print">Print</button>`;
      li.querySelector('.name').textContent = preset.name;
      li.querySelector('.sub').textContent = bits.join(' · ');

      li.querySelector('[data-act="open"]').addEventListener('click', () => openPreset(preset));
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openPresetEditor(preset));
      li.querySelector('[data-act="print"]').addEventListener('click', () =>
        printText(preset.text, `Printed "${preset.name}"`, preset.options));

      list.append(li);
    });

  renderQuickPresets();
}

/* The same presets, reachable without leaving Compose. */
function renderQuickPresets() {
  const list = $('quickPresets');
  if (!list) return;
  list.innerHTML = '';
  $('quickCount').textContent = `${state.presets.length} saved`;

  if (!state.presets.length) {
    list.innerHTML = '<li class="empty">Nothing saved yet</li>';
    return;
  }

  state.presets
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 8)
    .forEach((preset) => {
      const lines = (preset.text || '').split('\n').filter(Boolean).length;
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = '<div class="name"></div><span class="spacer"></span><span class="sub"></span>';
      li.querySelector('.name').textContent = preset.name;
      li.querySelector('.sub').textContent = lines;
      li.addEventListener('click', () => openPreset(preset));
      list.append(li);
    });
}

function openPreset(preset) {
  setEditorMarkdown(preset.text || '');
  state.activePresetId = preset.id;
  $('presetLabel').textContent = preset.name;
  // a preset carries the settings it was designed against
  if (preset.options?.font || preset.options?.size) {
    setPrintFont(preset.options.font, preset.options.size, { pin: true });
  }
  if (preset.options?.darkness) $('darkness').value = preset.options.darkness;
  showView('compose');
  refreshPreview();
  toast(`Opened "${preset.name}"`);
}

/* --------------------------------------------------------- preset editor */
let editingPreset = null;

function openPresetEditor(preset) {
  editingPreset = preset || null;
  $('presetModalTitle').textContent = preset ? 'Edit preset' : 'New preset';
  $('presetName').value = preset?.name || '';
  $('presetDesc').value = preset?.description || '';
  $('presetText').value = preset?.text ?? editor().value;
  $('presetFont').value = preset?.options?.font || currentFont();
  $('presetSize').value = preset?.options?.size || $('fontSize').value || 24;
  $('presetDarkness').value = preset?.options?.darkness || $('darkness').value || 1;

  $('presetDelete').hidden = !preset;
  $('presetDuplicate').hidden = !preset;

  $('presetModal').hidden = false;
  $('presetName').focus();
  refreshPresetPreview();
}

function closePresetEditor() {
  $('presetModal').hidden = true;
  editingPreset = null;
}

function presetEditorOptions() {
  return {
    font: $('presetFont').value || currentFont(),
    size: Number($('presetSize').value) || 24,
    darkness: Number($('presetDarkness').value) || 1,
  };
}

const refreshPresetPreview = () => renderInto(
  'preset', $('presetText').value, $('presetPreview'), $('presetPreviewMeta'),
  presetEditorOptions()
);

async function submitPreset() {
  const name = $('presetName').value.trim();
  if (!name) { toast('A preset needs a name', true); $('presetName').focus(); return; }

  // a new preset that reuses an existing name updates it rather than making a
  // second entry that is impossible to tell apart in the list
  const clash = state.presets.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== editingPreset?.id
  );
  if (clash && !confirm(`"${clash.name}" already exists. Overwrite it?`)) return;

  const result = await api('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      id: editingPreset?.id || clash?.id,
      name,
      description: $('presetDesc').value,
      text: $('presetText').value,
      options: presetEditorOptions(),
    }),
  });

  state.presets = result.presets;
  renderPresets();
  closePresetEditor();
  toast(`Saved "${result.preset.name}"`);
}

function initPresetEditor() {
  $('newPresetBtn').addEventListener('click', () => openPresetEditor(null));
  $('presetCancel').addEventListener('click', closePresetEditor);
  $('presetClose').addEventListener('click', closePresetEditor);

  $('presetModal').addEventListener('click', (event) => {
    if (event.target === $('presetModal')) closePresetEditor();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('presetModal').hidden) closePresetEditor();
  });

  $('presetSave').addEventListener('click', submitPreset);

  $('presetDelete').addEventListener('click', async () => {
    if (!editingPreset) return;
    if (!confirm(`Delete "${editingPreset.name}"?`)) return;
    await api(`/api/presets/${editingPreset.id}`, { method: 'DELETE' });
    if (state.activePresetId === editingPreset.id) {
      state.activePresetId = null;
      $('presetLabel').textContent = 'Untitled';
    }
    closePresetEditor();
    await loadPresets();
    toast('Preset deleted');
  });

  $('presetDuplicate').addEventListener('click', () => {
    // drop the id so saving creates a second entry
    editingPreset = null;
    $('presetModalTitle').textContent = 'New preset';
    $('presetName').value = `${$('presetName').value} copy`;
    $('presetDelete').hidden = true;
    $('presetDuplicate').hidden = true;
    $('presetName').select();
  });

  ['presetText', 'presetFont', 'presetSize', 'presetDarkness'].forEach((id) => {
    $(id).addEventListener('input', () => debounce('preset', refreshPresetPreview));
  });

  // markdown buttons and token inserts inside the modal
  document.querySelectorAll('.tool[data-pmd]').forEach((button) => {
    button.addEventListener('click', () => {
      withPresetTextarea(() => MD_ACTIONS[button.dataset.pmd]?.());
    });
  });
  document.querySelectorAll('.tool[data-token]').forEach((button) => {
    button.addEventListener('click', () => {
      const area = $('presetText');
      const at = area.selectionStart;
      area.setRangeText(button.dataset.token, at, area.selectionEnd, 'end');
      area.focus();
      refreshPresetPreview();
    });
  });
}

/* The markdown helpers act on whatever editor() returns, so point it at the
 * modal's textarea for the duration of one action rather than duplicating
 * every wrap and prefix routine. */
function withPresetTextarea(action) {
  const original = editorTarget;
  editorTarget = () => $('presetText');
  try { action(); } finally { editorTarget = original; }
  refreshPresetPreview();
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

  scheduleTodoPreview();

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

const TODO_TITLE_KEY = 'tp.todoTitle';
const TODO_DATE_KEY = 'tp.todoDate';

function todosAsMarkdown() {
  const open = state.todos.filter((t) => !t.done);
  const done = state.todos.filter((t) => t.done);

  const title = ($('todoTitle').value || '').trim();
  const lines = [];
  if (title) lines.push(`# ${title}`);

  if ($('todoDate').checked) {
    lines.push(new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }));
  }
  if (lines.length) lines.push('');

  if (!open.length && !done.length) lines.push('_nothing to do_');
  open.forEach((t) => lines.push(`- ${t.text}`));

  if (done.length) {
    lines.push('', '> done');
    done.forEach((t) => lines.push(`- ~~${t.text}~~`));
  }
  return lines.join('\n');
}

function initTodos() {
  $('todoTitle').value = localStorage.getItem(TODO_TITLE_KEY) ?? 'To-do';
  $('todoDate').checked = localStorage.getItem(TODO_DATE_KEY) !== 'false';

  $('todoTitle').addEventListener('input', () => {
    localStorage.setItem(TODO_TITLE_KEY, $('todoTitle').value);
    scheduleTodoPreview();
  });
  $('todoDate').addEventListener('change', () => {
    localStorage.setItem(TODO_DATE_KEY, String($('todoDate').checked));
    refreshTodoPreview();
  });

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

  $('todoToPresetBtn').addEventListener('click', () => {
    openPresetEditor(null);
    $('presetName').value = $('todoTitle').value || 'To-do';
    $('presetText').value = todosAsMarkdown()
      // keep it a live template rather than freezing today's date into it
      .replace(/^[A-Z][a-z]{2},? .*\d{2}:\d{2}$/m, '{{datetime}}');
    refreshPresetPreview();
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
    if (event.key === 'p') { event.preventDefault(); printText(editorMarkdown()); }
    if (event.key === 's') { event.preventDefault(); openPresetEditor(null); }
  });
}

async function boot() {
  await loadThemes();
  initTheme();
  initTabs();
  initEditorModes();
  initToolbar();
  initConnection();
  initTodos();
  initSettings();
  initFontControls();
  initPresetEditor();
  initShortcuts();

  editor().addEventListener('input', () => {
    schedulePreview();
    debounce('align', alignTablesInEditor, 800);
  });
  $('printBtn').addEventListener('click', () => printText(editorMarkdown()));
  $('savePresetBtn').addEventListener('click', () => openPresetEditor(null));

  try {
    await refreshState();
    await Promise.all([loadFonts(), loadPresets(), loadTodos()]);
  } catch (error) {
    toast(`Could not reach the server: ${error.message}`, true);
  }

  if (!editorMarkdown()) {
    setEditorMarkdown('# Groceries\nMilk and eggs.\n- bread\n- butter\n> dont forget the receipt');
  }
  refreshPreview();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
