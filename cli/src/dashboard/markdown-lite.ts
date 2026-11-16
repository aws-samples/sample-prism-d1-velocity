/**
 * A small, safe markdown renderer for text that comes from AWS or a repo's own
 * docs (a threat model's system overview, a pentest overview): untrusted.
 *
 * Built only with createElement and text nodes, never innerHTML, and no
 * attributes at all. It keeps headings, paragraphs, lists, inline code, bold
 * and fenced code. Anything else is text: a link shows its text only, an
 * image its alt text, a table or a quote its lines as written, and HTML tags
 * appear as the characters they are. A JS string concatenated into page.ts's
 * script, like the other page modules; it needs only `document`.
 */
export const MARKDOWN_SCRIPT = `
/** Inline: \`code\` and **bold**; [text](url) and ![alt](src) become their text (a URL may hold one level of parentheses). Everything else is a text node. */
function mdInline(s) {
  const out = [];
  const re = /(\\x60[^\\x60]+\\x60)|(\\*\\*[^*]+\\*\\*)|(!?\\[([^\\]]*)\\]\\((?:[^()]|\\([^()]*\\))*\\))/g;
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push(document.createTextNode(s.slice(at, m.index)));
    if (m[1]) { const c = document.createElement('code'); c.textContent = m[1].slice(1, -1); out.push(c); }
    else if (m[2]) { const b = document.createElement('strong'); b.textContent = m[2].slice(2, -2); out.push(b); }
    else out.push(document.createTextNode(m[4]));
    at = re.lastIndex;
  }
  if (at < s.length) out.push(document.createTextNode(s.slice(at)));
  return out;
}

/**
 * Block level: # headings (shown one level under the card's own h2), - * + and 1. lists (nesting
 * flattened), \\x60\\x60\\x60 fences and | tables as preformatted text, blank lines between paragraphs.
 * Returns the nodes, in order; mdFirst() returns the first paragraph only.
 */
function mdBlocks(text, onlyFirst) {
  const nodes = [], lines = String(text || '').replace(/\\r\\n/g, '\\n').split('\\n');
  let para = [], list = null, pre = null, preKind = null;
  const add = (tag, kids) => { const n = document.createElement(tag); for (const k of kids) n.append(k); nodes.push(n); return n; };
  const flushPara = () => { if (para.length) add('p', mdInline(para.join(' '))); para = []; };
  const flushList = () => { list = null; };
  const flushPre = () => { if (pre !== null) { const n = add('pre', []); n.textContent = pre.join('\\n'); } pre = null; preKind = null; };
  for (const raw of lines) {
    if (onlyFirst && nodes.some((n) => n.nodeName === 'P')) break;
    const line = raw.replace(/\\s+$/, '');
    if (preKind === 'fence') { if (/^\\s*\\x60\\x60\\x60/.test(line)) flushPre(); else pre.push(raw); continue; }
    if (/^\\s*\\x60\\x60\\x60/.test(line)) { flushPara(); flushList(); flushPre(); pre = []; preKind = 'fence'; continue; }
    if (preKind === 'table' && !/^\\s*\\|/.test(line)) flushPre();
    if (/^\\s*\\|/.test(line)) { flushPara(); flushList(); if (preKind !== 'table') { pre = []; preKind = 'table'; } pre.push(line.trim()); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = /^\\s*(#{1,6})\\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); add('h' + Math.min(6, h[1].length + 2), mdInline(h[2].replace(/\\s+#+\\s*$/, ''))); continue; }
    const li = /^\\s*([-*+]|\\d+[.)])\\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = /\\d/.test(li[1]) ? 'OL' : 'UL';
      if (!list || list.nodeName !== tag) list = add(tag.toLowerCase(), []);
      const item = document.createElement('li');
      for (const k of mdInline(li[2])) item.append(k);
      list.append(item);
      continue;
    }
    flushList();
    para.push(line.trim().replace(/^>\\s?/, ''));
  }
  flushPara(); flushPre();
  return onlyFirst ? nodes.filter((n) => n.nodeName === 'P').slice(0, 1) : nodes;
}
`;
