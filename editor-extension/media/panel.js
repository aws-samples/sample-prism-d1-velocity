// @ts-check
// PRISM panel. Draws the model the extension posts (src/panel-model.ts).
// Recorded text is inserted with textContent only; nothing from the model
// becomes markup, a URL or an attribute that the browser interprets.
'use strict';
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const loading = /** @type {HTMLElement} */ (document.getElementById('loading'));

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  /** @param {string} label @param {() => void} onClick @param {string} [cls] */
  function button(label, onClick, cls) {
    const b = /** @type {HTMLButtonElement} */ (el('button', cls || '', label));
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  const TONES = ['ok', 'warn', 'error', 'none'];
  const SEVERITIES = ['high', 'medium', 'low'];
  const STATUSES = ['ok', 'info', 'warn', 'missing', 'opted-out', 'in-use'];
  /** @param {string} v @param {string[]} allowed @param {string} dflt */
  const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

  /** @param {any[]} list */
  function drawCards(list) {
    const cards = el('section', 'cards');
    for (const c of list) {
      const card = el('div', 'card tone-' + pick(c.tone, TONES, 'none'));
      card.append(el('div', 'card-title', c.title), el('div', 'card-value', c.value), el('div', 'card-detail', c.detail));
      cards.append(card);
    }
    return cards;
  }

  /** @param {any[]} checklist */
  function drawChecklist(checklist) {
    const cs = el('section', 'block');
    cs.append(el('h2', '', 'Setup checklist'));
    cs.append(el('p', 'muted', 'Commands are copy-only: paste them into a terminal to run them yourself.'));
    let group = '';
    let ul = el('ul', 'checks');
    for (const c of checklist) {
      if (c.group !== group) {
        group = c.group;
        cs.append(el('h3', '', group));
        ul = el('ul', 'checks');
        cs.append(ul);
      }
      const li = el('li', 'check st-' + pick(c.status, STATUSES, 'info'));
      const row = el('div', 'check-top');
      row.append(el('span', 'dot'), el('span', 'check-label', c.label), el('span', 'status', c.status));
      li.append(row, el('div', 'check-detail muted', c.detail));
      if (c.fix) {
        const fix = el('div', 'fix');
        fix.append(el('code', '', c.fix), button('Copy', () => vscode.postMessage({ type: 'copy', key: c.key }), 'secondary small'));
        li.append(fix);
      }
      ul.append(li);
    }
    return cs;
  }

  /** @param {string} title @param {any[]} rows */
  function drawList(title, rows) {
    const s = el('section', 'block');
    s.append(el('h2', '', title));
    if (!rows.length) s.append(el('p', 'muted', 'No data yet.'));
    const ul = el('ul', 'rows');
    for (const r of rows) {
      const li = el('li', 'row');
      li.append(el('span', 'row-name', r.name), el('span', 'row-value muted', r.value));
      ul.append(li);
    }
    s.append(ul);
    return s;
  }

  /** No repo in this window: this machine's spend, setup and repos with codewatch. @param {any} m */
  function drawMachine(m) {
    app.replaceChildren();
    const head = el('header', 'head');
    const title = el('h1', '', 'PRISM');
    title.append(el('span', 'repo', 'this machine'));
    head.append(title);
    const actions = el('div', 'actions');
    actions.append(button('Refresh', () => vscode.postMessage({ type: 'refresh' }), 'secondary'));
    head.append(actions);
    app.append(head);
    app.append(el('p', 'muted', 'Updated ' + m.generatedAt + '. Open a repository folder to see its findings.'));
    app.append(drawCards(m.cards));

    const lists = el('div', 'lists');
    lists.append(drawList('Top models this month', m.topModels), drawList('Top projects this month', m.topProjects));
    app.append(lists);

    const rs = el('section', 'block');
    rs.append(el('h2', '', 'Repositories with codewatch'));
    if (m.reposNote) rs.append(el('p', 'muted', m.reposNote));
    if (!m.repos.length) rs.append(el('p', 'muted', 'No repository has codewatch yet.'));
    const ul = el('ul', 'checks');
    for (const r of m.repos) {
      const li = el('li', 'check repo-row tone-' + pick(r.tone, TONES, 'none'));
      const top = el('div', 'check-top');
      top.append(el('span', 'check-label', r.name), el('span', 'status', 'codewatch ' + r.status));
      top.append(button('Open folder', () => vscode.postMessage({ type: 'openFolder', path: r.path }), 'secondary small'));
      li.append(top, el('div', 'check-detail muted', r.when ? r.review + ' · ' + r.when : r.review));
      ul.append(li);
    }
    rs.append(ul);
    app.append(rs);

    app.append(drawChecklist(m.checklist));
    loading.hidden = true;
    app.hidden = false;
  }

  /** @param {any} m */
  function draw(m) {
    if (m.mode === 'machine') { drawMachine(m); return; }
    app.replaceChildren();

    const head = el('header', 'head');
    const title = el('h1', '', 'PRISM');
    title.append(el('span', 'repo', m.repo));
    head.append(title);
    const actions = el('div', 'actions');
    actions.append(button('Refresh', () => vscode.postMessage({ type: 'refresh' }), 'secondary'));
    if (m.hasReport) actions.append(button('Open review report', () => vscode.postMessage({ type: 'report' }), 'secondary'));
    if (m.codewatchOff) actions.append(button('Enable codewatch', () => vscode.postMessage({ type: 'enable' })));
    head.append(actions);
    app.append(head);
    app.append(el('p', 'muted', 'Updated ' + m.generatedAt));

    app.append(drawCards(m.cards));

    const fs = el('section', 'block');
    fs.append(el('h2', '', 'Codewatch findings (latest review)'));
    if (m.reviewNote) fs.append(el('p', 'note', m.reviewNote));
    if (!m.findings.length) fs.append(el('p', 'muted', 'No findings in the latest review.'));
    const list = el('ul', 'findings');
    for (const f of m.findings) {
      const li = el('li', 'finding sev-' + pick(f.severity, SEVERITIES, 'low'));
      const top = el('div', 'finding-top');
      top.append(el('span', 'badge', f.severity), el('span', 'cat', f.category));
      if (f.openable) {
        top.append(button(f.location, () => vscode.postMessage({ type: 'open', index: f.index }), 'link'));
      } else {
        top.append(el('span', 'loc muted', f.location + ' (file not in this checkout)'));
      }
      li.append(top, el('div', 'msg', f.message));
      list.append(li);
    }
    fs.append(list);
    if (m.findingsTruncated) fs.append(el('p', 'muted', 'More findings were recorded than prism-cli lists; run prism-cli codewatch report for all of them.'));
    app.append(fs);

    app.append(drawChecklist(m.checklist));

    loading.hidden = true;
    app.hidden = false;
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'model' && msg.model && typeof msg.model === 'object') draw(msg.model);
    if (msg && msg.type === 'status' && typeof msg.text === 'string') {
      loading.textContent = msg.text;
      loading.hidden = false;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
