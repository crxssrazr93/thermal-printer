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
    .replace(/==([^=]+)==/g, (_m, body) => `<mark>${body}</mark>`)
    .replace(/\+\+([^+]+)\+\+/g, (_m, body) => `<u>${body}</u>`)
    .replace(/\^([^^\s]+)\^/g, (_m, body) => `<sup>${body}</sup>`)
    .replace(/(?<!~)~([^~\s]+)~(?!~)/g, (_m, body) => `<sub>${body}</sub>`)
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

    // A deliberate blank line is content: it is a line of space on the paper
    // and an empty paragraph in the editor. Skipping it, which is what a
    // general markdown parser does, was why pressing Enter twice appeared to
    // do nothing.
    if (!trimmed) { out.push('<p></p>'); i += 1; continue; }

    const directive = /^<!--\s*table\s+(.*?)\s*-->$/.exec(trimmed);
    if (directive) {
      borders = (/borders=(\w+)/.exec(directive[1]) || [])[1] || '';
      i += 1;
      continue;
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    const picture = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/.exec(trimmed);
    if (picture) {
      const title = picture[3] ? ` title="${escapeHtml(picture[3])}"` : '';
      out.push(`<img src="${picture[2]}" alt="${escapeHtml(picture[1])}"${title}>`);
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

    // a task list is a bullet list whose items start with a box
    if (/^[-*+]\s+\[[ xX]\]\s/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+\[[ xX]\]\s/.test(lines[i].trim())) {
        const item = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i].trim());
        items.push(`<li data-type="taskItem" data-checked="${
          item[1].toLowerCase() === 'x'}"><p>${inlineToHtml(item[2])}</p></li>`);
        i += 1;
      }
      out.push(`<ul data-type="taskList">${items.join('')}</ul>`);
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
    // markdown proper has none of these; these are the spellings the wider
    // ecosystem settled on, and the renderer understands the same ones
    case 'MARK': return inner.trim() ? `==${inner.trim()}==` : '';
    case 'U': return inner.trim() ? `++${inner.trim()}++` : '';
    case 'SUP': return inner.trim() ? `^${inner.trim()}^` : '';
    case 'SUB': return inner.trim() ? `~${inner.trim()}~` : '';
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
  // an empty paragraph is a blank line, not nothing
  if (node.nodeName === 'P' && !node.textContent.trim() && !node.querySelector('img')) return [''];

  const name = node.nodeName;
  const inline = () => inlineToMd(node).split('\n').map((l) => l.trim());

  if (/^H[1-6]$/.test(name)) return [`${'#'.repeat(Number(name[1]))} ${inlineToMd(node).trim()}`];
  if (name === 'HR') return ['---'];
  if (name === 'PRE') return ['```', ...(node.textContent || '').split('\n'), '```'];
  if (name === 'BLOCKQUOTE') {
    return inline().filter((l, i, all) => l || i < all.length - 1).map((l) => `> ${l}`.trimEnd());
  }
  if (name === 'UL' && node.dataset.type === 'taskList') {
    return Array.from(node.children).map((li) =>
      `- [${li.dataset.checked === 'true' ? 'x' : ' '}] ${inlineToMd(li).trim()}`);
  }
  if (name === 'UL' || name === 'OL') {
    return Array.from(node.children).map((li, index) =>
      `${name === 'OL' ? `${index + 1}.` : '-'} ${inlineToMd(li).trim()}`);
  }
  if (name === 'IMG') {
    const title = node.getAttribute('title');
    const target = title
      ? `${node.getAttribute('src') || ''} "${title}"`
      : node.getAttribute('src') || '';
    return [`![${node.getAttribute('alt') || ''}](${target})`];
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
  // No inserted gaps: blank lines are the author's, and collapsing runs of
  // them would silently edit the document. Tables and fences parse without
  // needing one.
  return blocks.flat().join('\n').replace(/\s+$/, '');
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
  syncToolbarState();
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

/* Typing {{ offers the tokens that get filled in at print time. They are
 * inserted as plain text rather than as a node, so the document stays ordinary
 * markdown and a preset written by hand behaves identically. */
const TOKENS = [
  { id: '{{date}}', label: 'date' },
  { id: '{{time}}', label: 'time' },
  { id: '{{datetime}}', label: 'date and time' },
  { id: '{{weekday}}', label: 'weekday' },
];

function tokenSuggestion() {
  let list = null;
  let items = [];
  let active = 0;
  let range = null;

  const close = () => { list?.remove(); list = null; };

  const paint = () => {
    if (!list) return;
    list.innerHTML = '';
    items.forEach((item, index) => {
      const option = document.createElement('button');
      option.className = `token-option${index === active ? ' is-active' : ''}`;
      option.textContent = `${item.id}  ${item.label}`;
      option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(index); });
      list.append(option);
    });
  };

  const choose = (index) => {
    const item = items[index];
    if (!item || !range) return;
    tt.chain().focus().insertContentAt(range, item.id).run();
    close();
  };

  return {
    char: '{{',
    startOfLine: false,
    items: ({ query }) => TOKENS.filter((token) =>
      token.label.startsWith(query.toLowerCase()) || token.id.includes(query.toLowerCase())),
    render: () => ({
      onStart: (props) => {
        items = props.items; active = 0; range = props.range;
        list = document.createElement('div');
        list.className = 'token-menu';
        const box = props.clientRect?.();
        const shell = $('editorShell').getBoundingClientRect();
        if (box) {
          list.style.left = `${box.left - shell.left}px`;
          list.style.top = `${box.bottom - shell.top + 4}px`;
        }
        $('editorShell').append(list);
        paint();
      },
      onUpdate: (props) => { items = props.items; range = props.range; paint(); },
      onKeyDown: (props) => {
        if (!list) return false;
        if (props.event.key === 'ArrowDown') { active = (active + 1) % items.length; paint(); return true; }
        if (props.event.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; paint(); return true; }
        if (props.event.key === 'Enter') { choose(active); return true; }
        if (props.event.key === 'Escape') { close(); return true; }
        return false;
      },
      onExit: close,
    }),
  };
}

/* A picture can arrive by paste or by drop as well as through the button, and
 * all three take the same road: upload, then a markdown reference. */
function handleDroppedFiles(files) {
  const images = Array.from(files || []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return false;
  images.forEach((file) => uploadAndInsert(file));
  return true;
}

function initRichEditor() {
  const {
    Editor, StarterKit, TableRow, Image, Link, TaskList, TaskItem,
    CharacterCount, Placeholder, Mention,
    Underline, Highlight, Subscript, Superscript,
  } = window.TipTap;

  tt = new Editor({
    element: $('rich'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      ...tableExtensions(),
      TableRow,
      TaskList,
      TaskItem.configure({ nested: false }),
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
      Underline,
      Highlight,
      Subscript,
      Superscript,
      CharacterCount,
      Placeholder.configure({
        placeholder: 'Type here. Markdown works, and {{ offers the date tokens.',
      }),
      Mention.configure({
        renderText: ({ node }) => node.attrs.id,
        suggestion: tokenSuggestion(),
      }),
    ],
    editorProps: {
      handlePaste: (view, event) => handleDroppedFiles(event.clipboardData?.files),
      handleDrop: (view, event) => handleDroppedFiles(event.dataTransfer?.files),
    },
    content: '<p></p>',
    onUpdate: () => {
      schedulePreview();
      positionTableTools();
      positionImageTools();
      syncToolbarState();
      updateCounts();
    },
    onSelectionUpdate: () => {
      positionTableTools();
      positionImageTools();
      positionSelectionMenus();
      syncToolbarState();
    },
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
  initImageTools();
  tt.on('focus', positionSelectionMenus);
  tt.on('blur', () => {
    setTimeout(() => {
      const menu = $('floatingMenu');
      if (!menu.contains(document.activeElement)) menu.hidden = true;
    }, 150);
  });
  syncToolbarState();
}

/* ---------------------------------------------------------------- pictures */
/* The browser has the file and the printer has the paper, so the picture goes
 * to the server, which keeps it by content hash and hands back a reference the
 * document can carry. The renderer dithers it at print time. */
async function uploadAndInsert(file) {
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
}

function insertImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    if (input.files?.[0]) uploadAndInsert(input.files[0]);
  });
  input.click();
}

/* Characters and words are what a text editor counts; on a receipt printer the
 * number that matters is how much paper this will take, so that is estimated
 * from the rendered height the preview just reported. */
function updateCounts() {
  const counter = $('docCount');
  if (!counter || !tt?.storage.characterCount) return;
  const words = tt.storage.characterCount.words();
  const characters = tt.storage.characterCount.characters();
  counter.textContent = `${words} word${words === 1 ? '' : 's'} · ${characters} chars${
    lastPaperMm ? ` · ${lastPaperMm} mm` : ''}`;
}

let lastPaperMm = 0;

/* --------------------------------------------------------- menus in place */
/* Formatting where the selection is, and block choices on an empty line, so
 * the common moves do not need a trip to the toolbar. */
function positionSelectionMenus() {
  const floating = $('floatingMenu');
  if (!floating || !tt) return;

  const { state } = tt;
  const { empty, from } = state.selection;

  // An empty paragraph is an invitation to choose a block, which is worth a
  // menu. A selection is not: the toolbar is right there and already says
  // which of its toggles are on.
  const node = state.selection.$from.parent;
  const emptyBlock = node.type.name === 'paragraph' && node.content.size === 0;
  if (isRawMode() || !empty || !emptyBlock || tt.isActive('table')) {
    floating.hidden = true;
    return;
  }

  const shell = $('editorShell').getBoundingClientRect();
  const at = tt.view.coordsAtPos(from);
  floating.hidden = false;
  floating.style.left = `${Math.max(6, Math.min(at.left - shell.left,
    shell.width - floating.offsetWidth - 10))}px`;
  floating.style.top = `${Math.max(4, at.top - shell.top - 2)}px`;
}

const isRawMode = () => !isRendered();

/* ------------------------------------------------------------ image controls */
/* How a picture is reduced to one bit is the most consequential choice in
 * printing it, and the right answer depends on the picture: a hard threshold
 * for line art, error diffusion for a photograph, Atkinson when the paper is
 * mostly dark. It is a property of the image, so it rides in markdown's title
 * slot and stays with the document. */
let ditherModes = [];

async function loadDitherModes() {
  try {
    const data = await api('/api/dither');
    ditherModes = data.modes || [];
  } catch (error) {
    ditherModes = [];
  }
  const select = $('imageDither');
  const settings = $('defaultDither');
  [select, settings].forEach((element) => {
    if (!element) return;
    element.innerHTML = '';
    ditherModes.forEach(({ id, label }) => element.append(new Option(label, id)));
  });
  if (settings) settings.value = localStorage.getItem(DITHER_KEY) || 'floyd-steinberg';
}

const DITHER_KEY = 'tp.dither';
const currentDither = () => localStorage.getItem(DITHER_KEY) || 'floyd-steinberg';

/* Ask the document, not the DOM: a node selection is a fact about the editor
 * state, while the selected-node class is a rendering detail that is not
 * always there when the selection is set programmatically. */
const imageSelected = () => Boolean(tt && tt.isActive('image'));

function positionImageTools() {
  const tools = $('imageTools');
  if (!tools) return;
  const showing = isRendered() && imageSelected();
  tools.hidden = !showing;
  if (showing) {
    $('imageDither').value = tt.getAttributes('image').title || currentDither();
  }
}

function initImageTools() {
  const select = $('imageDither');
  if (!select) return;
  select.addEventListener('change', () => {
    if (!tt.isActive('image')) return;
    tt.chain().focus().updateAttributes('image', { title: select.value }).run();
    schedulePreview();
  });
  $('defaultDither')?.addEventListener('change', () => {
    localStorage.setItem(DITHER_KEY, $('defaultDither').value);
    refreshPreview();
  });
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
/* Every one of these that can be on or off is a toggle, and the toolbar says
 * which: pressing Bold inside bold text takes it off again, and H1 on a
 * heading turns it back into a paragraph. The ones with no "off" state
 * (insert a table, a rule, a picture) simply never light up. */
const ACTIVE_STATE = {
  h1: () => tt.isActive('heading', { level: 1 }),
  h2: () => tt.isActive('heading', { level: 2 }),
  h3: () => tt.isActive('heading', { level: 3 }),
  bold: () => tt.isActive('bold'),
  italic: () => tt.isActive('italic'),
  strike: () => tt.isActive('strike'),
  code: () => tt.isActive('code'),
  ul: () => tt.isActive('bulletList'),
  ol: () => tt.isActive('orderedList'),
  quote: () => tt.isActive('blockquote'),
  codeblock: () => tt.isActive('codeBlock'),
  link: () => tt.isActive('link'),
  table: () => tt.isActive('table'),
  math: () => tt.isActive('code'),
  tasks: () => tt.isActive('taskList'),
  underline: () => tt.isActive('underline'),
  highlight: () => tt.isActive('highlight'),
  sup: () => tt.isActive('superscript'),
  sub: () => tt.isActive('subscript'),
};

function syncToolbarState() {
  const rendered = isRendered() && tt;
  document.querySelectorAll('.tool[data-md]').forEach((button) => {
    const check = ACTIVE_STATE[button.dataset.md];
    const on = Boolean(rendered && check && check());
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

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
  tasks: () => tt.chain().focus().toggleTaskList().run(),
  underline: () => tt.chain().focus().toggleUnderline().run(),
  highlight: () => tt.chain().focus().toggleHighlight().run(),
  sup: () => tt.chain().focus().toggleSuperscript().run(),
  sub: () => tt.chain().focus().toggleSubscript().run(),
  link: () => {
    // pressing it on an existing link takes the link off, which is what a
    // toggle in a toolbar is expected to do
    if (tt.isActive('link')) {
      tt.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
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
        RICH_ACTIONS[action]?.();
        schedulePreview();
        syncToolbarState();
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
  // the theme sets the page, the user sets how pictures are screened onto it
  return {
    style: { ...(print.style || {}), image_dither: currentDither() },
    line_spacing: print.line_spacing,
  };
}

const ORIENTATION_KEY = 'tp.orientation';
const LENGTH_KEY = 'tp.pageLength';

function renderOptions() {
  return {
    font: currentFont(),
    size: Number($('fontSize').value) || 16,
    darkness: Number($('darkness').value) || 1,
    orientation: $('orientation')?.value || 'portrait',
    page_length: Number($('pageLength')?.value) || 1200,
    ...themeStyle(),
  };
}

function initOrientation() {
  const direction = $('orientation');
  const length = $('pageLength');
  if (!direction || !length) return;

  direction.value = localStorage.getItem(ORIENTATION_KEY) || 'portrait';
  length.value = localStorage.getItem(LENGTH_KEY) || '1200';

  direction.addEventListener('change', () => {
    localStorage.setItem(ORIENTATION_KEY, direction.value);
    refreshPreview();
  });
  length.addEventListener('change', () => {
    localStorage.setItem(LENGTH_KEY, length.value);
    refreshPreview();
  });
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
  initOrientation();
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
    await Promise.all([loadFonts(), loadDitherModes(), loadPresets(), loadTodos()]);
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
