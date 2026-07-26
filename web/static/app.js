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
/* Two editors over one document, and markdown is the document.
 *
 * Rendered mode is TipTap, vendored as a single file in static/vendor. Writing
 * this by hand meant reimplementing selection, undo, paste and tables, and the
 * tables were where it showed: a hand-rolled surface can decorate markdown but
 * it cannot give you a cell to type in. TipTap brings a real document model,
 * resizable columns and proper keyboard handling; the toolbar and the styling
 * stay ours, so the themes still own how it looks.
 *
 * Markdown remains what is saved and printed. The converters below are the
 * only bridge, and they speak this printer's dialect rather than a general
 * one: a newline is a line break, because that is what the paper does. */
const EDITOR_MODE_KEY = 'tp.editorMode';

const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let tt = null;                       // the TipTap editor
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

function tableToHtml(rows, align = [], borders = '') {
  const head = rows[0] || [];
  const body = rows.slice(1);
  const width = Math.max(...rows.map((r) => r.length), 1);
  const attribute = (i) => (align[i] && align[i] !== 'left'
    ? ` data-align="${align[i]}" style="text-align:${align[i]}"` : '');
  const cells = (row, tag) => Array.from({ length: width }, (_v, i) =>
    `<${tag}${attribute(i)}>${inlineToHtml(row[i] || '') || '<br>'}</${tag}>`).join('');
  // A colgroup plus a fixed layout is what stops the columns jumping about
  // while a cell is being typed into; without it every keystroke re-measures
  // the whole table.
  const cols = Array.from({ length: width },
    () => `<col style="width:${(100 / width).toFixed(4)}%">`).join('');
  const flag = borders ? ` data-borders="${borders}" class="borders-${borders}"` : '';
  return `<table${flag}><colgroup>${cols}</colgroup><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${
    body.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table>`;
}

const cellAlignment = (cell) => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
};

function mdToHtml(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let borders = '';
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

    const directive = /^<!--\s*table\s+(.*?)\s*-->$/.exec(trimmed);
    if (directive) {
      borders = (/borders=(\w+)/.exec(directive[1]) || [])[1] || '';
      i += 1;
      continue;
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    const picture = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
    if (picture) {
      out.push(`<img src="${picture[2]}" alt="${escapeHtml(picture[1])}">`);
      i += 1;
      continue;
    }

    if (isTableLine(line)) {
      const rows = [];
      let align = [];
      while (i < lines.length && isTableLine(lines[i])) {
        if (isSeparatorRow(lines[i])) align = tableCells(lines[i]).map(cellAlignment);
        else rows.push(tableCells(lines[i]));
        i += 1;
      }
      out.push(tableToHtml(rows, align, borders));
      borders = '';
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
  if (name === 'IMG') {
    return [`![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`];
  }
  if (name === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.children).map(cellText));
    if (!rows.length) return [];
    // alignment rides in the separator row, where any other reader finds it;
    // the border treatment has no markdown syntax, so it goes in a directive
    const align = Array.from(node.querySelector('tr')?.children || [])
      .map((cell) => cell.dataset.align || 'left');
    const out = formatTable([rows[0], null, ...rows.slice(1)], align).split('\n');
    const borders = node.dataset.borders;
    return borders ? [`<!-- table borders=${borders} -->`, ...out] : out;
  }
  if (node.querySelector?.('img') && name !== 'IMG') {
    return Array.from(node.childNodes).flatMap(blockToMd);
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
  if (!isRendered() || !tt) return $('editor').value;
  const holder = document.createElement('div');
  holder.innerHTML = tt.getHTML();
  return htmlToMd(holder);
}

function setEditorMarkdown(md) {
  $('editor').value = md;
  if (tt) tt.commands.setContent(mdToHtml(md), false);
}

function setEditorMode(mode) {
  const shell = $('editorShell');
  const raw = mode === 'raw';
  const wasRaw = shell.classList.contains('raw');

  if (raw && !wasRaw) $('editor').value = editorMarkdown();
  if (!raw && wasRaw && tt) tt.commands.setContent(mdToHtml($('editor').value), false);

  shell.classList.toggle('raw', raw);
  $('modeRendered').setAttribute('aria-pressed', String(!raw));
  $('modeRaw').setAttribute('aria-pressed', String(raw));
  localStorage.setItem(EDITOR_MODE_KEY, raw ? 'raw' : 'rendered');
  if (raw) $('editor').focus();
  else tt?.commands.focus();
}

/* --------------------------------------------------------------- the editor */
/* Markdown has no syntax for how a table is ruled, so that lives on the node
 * and is written out as a directive comment; column alignment does have a
 * syntax, and rides in the separator row where any other reader will find it. */
function tableExtensions() {
  const { Table, TableCell, TableHeader } = window.TipTap;

  const withAlign = (base) => base.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        align: {
          default: null,
          parseHTML: (element) => element.dataset.align || null,
          renderHTML: (attributes) => (attributes.align
            ? { 'data-align': attributes.align, style: `text-align:${attributes.align}` }
            : {}),
        },
      };
    },
  });

  const table = Table.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        borders: {
          default: null,
          parseHTML: (element) => element.dataset.borders || null,
          renderHTML: (attributes) => (attributes.borders
            ? { 'data-borders': attributes.borders } : {}),
        },
      };
    },
  });

  return [table.configure({ resizable: true }), withAlign(TableCell), withAlign(TableHeader)];
}

function initRichEditor() {
  const { Editor, StarterKit, TableRow, Image, Link } = window.TipTap;

  tt = new Editor({
    element: $('rich'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      ...tableExtensions(),
      TableRow,
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
    ],
    content: '<p></p>',
    onUpdate: () => { schedulePreview(); positionTableTools(); },
    onSelectionUpdate: positionTableTools,
    onBlur: () => setTimeout(() => {
      if (!$('tableTools').contains(document.activeElement)) $('tableTools').hidden = true;
    }, 150),
  });
}

function initEditorModes() {
  initRichEditor();
  $('modeRendered').addEventListener('click', () => setEditorMode('rendered'));
  $('modeRaw').addEventListener('click', () => setEditorMode('raw'));
  setEditorMode(localStorage.getItem(EDITOR_MODE_KEY) === 'raw' ? 'raw' : 'rendered');
  initTableTools();
}

/* ---------------------------------------------------------------- pictures */
/* The browser has the file and the printer has the paper, so the picture goes
 * to the server, which keeps it by content hash and hands back a reference the
 * document can carry. The renderer dithers it at print time. */
async function insertImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await api('/api/images', { method: 'POST', body: JSON.stringify({ data }) });
      tt.chain().focus().setImage({ src: result.url, alt: file.name }).run();
      schedulePreview();
    } catch (error) {
      toast(`Could not add that image: ${error.message}`, true);
    }
  });
  input.click();
}

/* ------------------------------------------------------------ table controls */
const TABLE_TOOLS = {
  'row-after': () => tt.chain().focus().addRowAfter().run(),
  'col-after': () => tt.chain().focus().addColumnAfter().run(),
  'row-delete': () => tt.chain().focus().deleteRow().run(),
  'col-delete': () => tt.chain().focus().deleteColumn().run(),
  'align-left': () => setCellAlign('left'),
  'align-center': () => setCellAlign('center'),
  'align-right': () => setCellAlign('right'),
  borders: () => cycleBorders(),
  'table-delete': () => tt.chain().focus().deleteTable().run(),
};

/* Alignment is a property of the column, since that is all markdown can say,
 * so setting it on one cell sets it down the whole column. */
function setCellAlign(align) {
  const dom = tt.view.domAtPos(tt.state.selection.from).node;
  const cell = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest('td,th');
  const table = cell?.closest('table');
  if (!cell || !table) return;

  const column = Array.from(cell.parentElement.children).indexOf(cell);
  Array.from(table.querySelectorAll('tr')).forEach((row) => {
    const target = row.children[column];
    if (!target) return;
    target.dataset.align = align;
    target.style.textAlign = align;
  });
  // the DOM was edited under ProseMirror, so the document is re-read from it
  tt.commands.setContent(tt.view.dom.innerHTML, false);
  schedulePreview();
}

const BORDER_MODES = ['theme', 'all', 'none'];

function cycleBorders() {
  const table = currentTableElement();
  if (!table) return;
  const now = table.dataset.borders || 'theme';
  const next = BORDER_MODES[(BORDER_MODES.indexOf(now) + 1) % BORDER_MODES.length];
  if (next === 'theme') delete table.dataset.borders;
  else table.dataset.borders = next;
  table.classList.toggle('borders-all', next === 'all');
  table.classList.toggle('borders-none', next === 'none');
  tt.commands.setContent(tt.view.dom.innerHTML, false);
  toast(`Table borders: ${next}`);
  schedulePreview();
}

function currentTableElement() {
  if (!tt || !tt.isActive('table')) return null;
  const dom = tt.view.domAtPos(tt.state.selection.from).node;
  const element = dom.nodeType === 1 ? dom : dom.parentElement;
  return element?.closest('table') || null;
}

/* Docked to the top of the pane rather than floating over the table: anchored
 * to the table it covered whatever line sat above it, which is usually the one
 * being worked on. */
function positionTableTools() {
  const tools = $('tableTools');
  const table = isRendered() ? currentTableElement() : null;
  tools.hidden = !table;
}

function initTableTools() {
  $('tableTools').querySelectorAll('[data-table]').forEach((button) => {
    // mousedown, so the command runs before the caret is lost to the button
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      TABLE_TOOLS[button.dataset.table]?.();
      positionTableTools();
    });
  });
}

/* ---------------------------------------------------------- rich commands */
const RICH_ACTIONS = {
  h1: () => tt.chain().focus().toggleHeading({ level: 1 }).run(),
  h2: () => tt.chain().focus().toggleHeading({ level: 2 }).run(),
  h3: () => tt.chain().focus().toggleHeading({ level: 3 }).run(),
  bold: () => tt.chain().focus().toggleBold().run(),
  italic: () => tt.chain().focus().toggleItalic().run(),
  strike: () => tt.chain().focus().toggleStrike().run(),
  code: () => tt.chain().focus().toggleCode().run(),
  ul: () => tt.chain().focus().toggleBulletList().run(),
  ol: () => tt.chain().focus().toggleOrderedList().run(),
  quote: () => tt.chain().focus().toggleBlockquote().run(),
  rule: () => tt.chain().focus().setHorizontalRule().run(),
  codeblock: () => tt.chain().focus().toggleCodeBlock().run(),
  math: () => tt.chain().focus().toggleCode().run(),
  image: () => insertImage(),
  link: () => {
    const href = window.prompt('Link address', 'https://');
    if (!href) return;
    tt.chain().focus().extendMarkRange('link').setLink({ href }).run();
  },
  // a selected comma separated list becomes a real table, which is how this
  // data usually arrives
  table: () => {
    const { from, to } = tt.state.selection;
    const selected = tt.state.doc.textBetween(from, to, '\n').trim();
    const rows = selected
      ? selected.split('\n').map((line) => line.trim()).filter(Boolean).map(splitCells)
      : [];

    if (rows.length && (rows.length > 1 || rows[0].length > 1)) {
      tt.chain().focus().deleteSelection().insertContent(tableToHtml(rows)).run();
    } else {
      tt.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
    }
    schedulePreview();
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
function formatTable(rows, align = []) {
  const widths = [];
  rows.filter(Boolean).forEach((row) => {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).trim().length, 3);
    });
  });

  // ":---", "---:" and ":---:" are how markdown itself carries alignment, so
  // another reader of this file gets it too
  const marker = (width, index) => {
    const dashes = '-'.repeat(Math.max(1, width - (align[index] === 'center' ? 2 : 1)));
    if (align[index] === 'center') return `:${dashes}:`;
    if (align[index] === 'right') return `${dashes}:`;
    return '-'.repeat(width);
  };

  return rows.map((row) => {
    if (!row) return `| ${widths.map(marker).join(' | ')} |`;
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
