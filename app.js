(function () {
  const forcedToday = new URLSearchParams(location.search).get('today');
  const today = () => forcedToday || Core.dateKey(new Date());
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = document.getElementById('app');

  // Phones can't pop out a floating counter; they get a Home Screen icon instead.
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isPhone = isIOS || /Android/.test(ua);
  const isHomeScreenApp = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let view = location.hash === '#dashboard' ? 'dashboard' : 'counter';
  let status = 'loading'; // loading | ok | noKey | badKey | offline
  const dash = { period: 'week', person: 'all', sort: { setter: { id: 'meetingsBooked', dir: -1 }, closer: { id: 'signedDeals', dir: -1 } } };
  let pipWindow = null;
  let lastDay = today();
  let lastLink = null; // { name, url } after adding someone or making a new link

  const metricsFor = (p) => [
    ...(p.roles.includes('setter') ? Core.SETTER_METRICS : []),
    ...(p.roles.includes('closer') ? Core.CLOSER_METRICS : []),
  ];
  const roleText = (roles) => roles.map((r) => (r === 'setter' ? 'Setter' : 'Closer')).join(' + ');

  function weekValues(p) {
    const [from, to] = Core.periodRange('week', today());
    return Core.sumRange(Store.counts()[p.id], from, to);
  }

  /* ---------- Counter card (used on the page and in the pop-out) ---------- */
  function cardHTML(p, inPip = false) {
    const values = weekValues(p);
    let html = `<div class="card-head"><span class="card-name"><span class="card-title">${esc(p.name)}</span><button class="i" data-act="info" aria-label="What each number means">i</button></span><span class="card-week">This week · ${Core.weekLabel(Core.weekStart(today()))}</span></div>`;
    let group = null;
    for (const m of metricsFor(p)) {
      if (m.group !== group) { group = m.group; html += `<div class="group">${group}</div>`; }
      const v = values[m.id] || 0;
      html += `<div class="row"><span class="lbl">${m.label}</span>
        <button class="tap" data-act="bump" data-m="${m.id}" data-d="-1" aria-label="Take one off ${m.label}" ${v ? '' : 'disabled'}>−</button>
        <span class="val" data-val="${m.id}">${v}</span>
        <button class="tap" data-act="bump" data-m="${m.id}" data-d="1" aria-label="Add one to ${m.label}">+</button></div>`;
    }
    // Only the pop-out gets this; the page already has the Dashboard tab up top.
    if (inPip) html += '<button class="card-dash" data-act="openDash">Team dashboard</button>';
    return `<div class="card">${html}</div>`;
  }

  function syncCounts() {
    const p = Store.current();
    if (!p) return;
    const values = weekValues(p);
    const docs = [document];
    if (pipWindow) docs.push(pipWindow.document);
    for (const doc of docs) {
      doc.querySelectorAll('[data-val]').forEach((el) => { el.textContent = values[el.dataset.val] || 0; });
      doc.querySelectorAll('.tap[data-d="-1"]').forEach((b) => { b.disabled = !values[b.dataset.m]; });
    }
  }

  function renderPip() {
    const p = Store.current();
    if (pipWindow && p) pipWindow.document.body.innerHTML = cardHTML(p, true);
  }

  async function popOut() {
    if (pipWindow) { pipWindow.focus(); return; }
    if (!('documentPictureInPicture' in window)) { toast('Pop out needs Chrome or Edge.'); return; }
    const source = app.querySelector('.card');
    try {
      // +44 leaves room for the Team dashboard button, which the page's card doesn't have.
      const win = await documentPictureInPicture.requestWindow({ width: 300, height: Math.ceil(source.offsetHeight) + 8 + 44 });
      const style = win.document.createElement('style');
      style.textContent = document.getElementById('css').textContent;
      win.document.head.append(style);
      win.document.title = 'Scorecard';
      win.document.body.className = 'pip';
      win.document.addEventListener('click', onClick);
      win.addEventListener('pagehide', () => { pipWindow = null; });
      pipWindow = win;
      renderPip();
    } catch (e) {
      toast('Could not pop out. Try again from Chrome or Edge.');
    }
  }

  function counterHTML(p) {
    let button = '<button class="primary" data-act="popout">Pop out</button>';
    let hint = 'documentPictureInPicture' in window
      ? 'Pop out keeps a small counter on top of your other windows.'
      : 'Pop out only works in Chrome or Edge on a computer. The counter works here either way.';
    if (isPhone) {
      button = isHomeScreenApp ? '' : '<button class="primary" data-act="homeScreen">Put it on my Home Screen</button>';
      hint = isHomeScreenApp ? '' : 'Then it opens like an app, already signed in.';
    }
    return `<div class="counter-page">
      ${cardHTML(p)}
      <div class="tools">
        ${button}
        <label><input type="checkbox" data-role="setter" ${p.roles.includes('setter') ? 'checked' : ''}> Setter</label>
        <label><input type="checkbox" data-role="closer" ${p.roles.includes('closer') ? 'checked' : ''}> Closer</label>
      </div>
      ${hint ? `<p class="hint">${hint}</p>` : ''}
    </div>`;
  }

  // Steps for the phone in hand. The key sits in the address bar only while this is open.
  function showHomeSteps() {
    const steps = isIOS && /CriOS/.test(ua)
      ? ['Tap the <b>Share</b> button in the address bar.', 'Tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.']
      : isIOS
        ? ['Tap the <b>Share</b> button (the square with an arrow). On newer iPhones it\'s under the <b>•••</b> button.', 'Tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.']
        : ['Tap the <b>⋮</b> menu at the top right of Chrome.', 'Tap <b>Add to Home screen</b> (or <b>Install app</b>), then <b>Add</b>.'];
    Store.showKeyInAddress(true);
    const dlg = document.createElement('dialog');
    dlg.id = 'home';
    dlg.className = 'info';
    dlg.setAttribute('aria-label', 'Put it on your Home Screen');
    dlg.innerHTML = `<div class="info-body"><div class="info-head"><h2>Put it on your Home Screen</h2>
        <button class="info-close" data-act="homeDone" aria-label="Close">×</button></div>
      <p class="info-item"><span>Do this from this screen so the icon opens already signed in.</span></p>
      <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <button class="primary home-done" data-act="homeDone">Done</button></div>`;
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeHomeSteps(dlg); });
    dlg.addEventListener('close', () => { if (dlg.isConnected) closeHomeSteps(dlg); }); // Escape key
    document.body.append(dlg);
    dlg.showModal();
  }

  // Takes the key back out of the address right away, not whenever the browser gets to it.
  function closeHomeSteps(dlg) {
    Store.showKeyInAddress(false);
    if (dlg.open) dlg.close();
    dlg.remove();
  }

  /* ---------- Dashboard ---------- */
  const fmtRate = (r) => (r === null ? '–' : Math.round(r * 100) + '%');

  function columns(role) {
    if (role === 'setter') return Core.SETTER_METRICS;
    return [...Core.CLOSER_METRICS, ...Core.CLOSER_RATES.map((r) => ({ ...r, isRate: true }))];
  }

  const cellValue = (col, values) => (col.isRate ? Core.rate(values, col) : values[col.id] || 0);
  const cellText = (col, values) => (col.isRate ? fmtRate(cellValue(col, values)) : cellValue(col, values));
  const cells = (cols, values) => cols.map((c) => `<td>${cellText(c, values)}</td>`).join('');

  function groupTotal(people, from, to) {
    const total = {};
    for (const p of people) Core.addInto(total, Core.sumRange(Store.counts()[p.id], from, to));
    return total;
  }

  function byPersonTable(role, people, from, to) {
    const cols = columns(role);
    const sort = dash.sort[role];
    const sortCol = cols.find((c) => c.id === sort.id);
    const rows = people.map((p) => ({ p, values: Core.sumRange(Store.counts()[p.id], from, to) }));
    rows.sort((a, b) => {
      const va = cellValue(sortCol, a.values) ?? -1, vb = cellValue(sortCol, b.values) ?? -1;
      return (va - vb) * sort.dir || a.p.name.localeCompare(b.p.name);
    });
    const head = cols.map((c) => {
      const active = c.id === sort.id;
      const aria = active ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none';
      return `<th aria-sort="${aria}"><button data-act="sort" data-role="${role}" data-col="${c.id}">${c.label}${active ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
    }).join('');
    const body = rows.map((r) => `<tr><td>${esc(r.p.name)}</td>${cells(cols, r.values)}</tr>`).join('');
    const foot = people.length > 1 ? `<tfoot><tr><td>Total</td>${cells(cols, groupTotal(people, from, to))}</tr></tfoot>` : '';
    return `<div class="tbl"><table><thead><tr><th>Person</th>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  function byWeekTable(role, people) {
    const t = today();
    const cols = columns(role);
    const scoped = {};
    for (const p of people) scoped[p.id] = Store.counts()[p.id] || {};
    const weeks = Core.weeksThrough(t, Core.firstDay(scoped));
    const current = Core.weekStart(t);
    const [mFrom, mTo] = Core.periodRange('mtd', t);
    const head = cols.map((c) => `<th>${c.label}</th>`).join('');
    const rows = weeks.map((w) => {
      const tag = w === current ? '<span class="tag">this week</span>' : '';
      return `<tr><td>${Core.weekLabel(w)}${tag}</td>${cells(cols, groupTotal(people, w, Core.addDays(w, 6)))}</tr>`;
    }).join('');
    const mtd = `<tr class="sum"><td>${Core.monthName(t)} month to date</td>${cells(cols, groupTotal(people, mFrom, mTo))}</tr>`;
    const all = `<tfoot><tr><td>All time</td>${cells(cols, groupTotal(people, '0000-01-01', '9999-12-31'))}</tr></tfoot>`;
    const crossing = weeks.some((w) => w < mFrom && Core.addDays(w, 6) >= mFrom);
    const note = crossing ? `<p class="note">Month to date only counts ${Core.monthName(t)} days, so it won't always equal the weeks above when a week crosses two months.</p>` : '';
    return `<div class="tbl"><table><thead><tr><th>Week</th>${head}</tr></thead><tbody>${mtd}${rows}</tbody>${all}</table></div>${note}`;
  }

  function roleBlock(role, title, people, from, to) {
    if (!people.length) return `<section class="panel"><h2>${title}</h2><p class="empty">Nobody here for this filter.</p></section>`;
    const total = groupTotal(people, from, to);
    const metrics = role === 'setter' ? Core.SETTER_METRICS : Core.CLOSER_METRICS;
    const tile = (label, value) => `<div class="tile"><div class="t">${label}</div><div class="n">${value}</div></div>`;
    const metricTiles = (list) => list.map((m) => tile(m.label, total[m.id] || 0)).join('');
    const tiles = role === 'setter'
      ? `<div class="tiles three">${metricTiles(metrics.filter((m) => m.group === 'Partners'))}</div>
         <div class="tiles">${metricTiles(metrics.filter((m) => m.group === 'Deals'))}</div>`
      : `<div class="tiles three">${metricTiles(metrics)}</div>
         <div class="tiles three">${Core.CLOSER_RATES.map((r) => tile(r.label, fmtRate(Core.rate(total, r)))).join('')}</div>`;
    return `<section class="panel"><h2>${title}</h2>
      ${tiles}
      <h3>By person</h3>${byPersonTable(role, people, from, to)}
      <h3>By week and month to date</h3>${byWeekTable(role, people)}
    </section>`;
  }

  function rangeLabel(from, to) {
    const t = today();
    if (dash.period === 'week') return `This week · ${Core.weekLabel(Core.weekStart(t))}`;
    if (dash.period === 'mtd') return from === t ? `Month to date · ${Core.short(t)}` : `Month to date · ${Core.short(from)}–${Core.parseKey(t).getDate()}`;
    const first = Core.firstDay(Store.counts());
    return first ? `All time · since ${Core.short(first)}` : 'All time';
  }

  function checkLine(setters, closers, from, to) {
    if (dash.person !== 'all' || !setters.length || !closers.length) return '';
    const sat = groupTotal(setters, from, to).meetingsSat || 0;
    const presented = groupTotal(closers, from, to).closerSat || 0;
    const gap = Math.abs(sat - presented);
    const verdict = gap === 0 ? 'They match.' : `${gap} apart, so check that everyone is logging.`;
    return `<div class="check"><strong>Meetings check:</strong> setters logged ${sat} sat, closers logged ${presented} presented. ${verdict}</div>`;
  }

  function dashboardHTML() {
    const people = Store.people();
    if (dash.person !== 'all' && !Store.person(dash.person)) dash.person = 'all';
    const scoped = people.filter((p) => dash.person === 'all' || p.id === dash.person);
    const setters = scoped.filter((p) => p.roles.includes('setter'));
    const closers = scoped.filter((p) => p.roles.includes('closer'));
    const [from, to] = Core.periodRange(dash.period, today());
    const periods = [['week', 'This week'], ['mtd', 'Month to date'], ['all', 'All time']];
    const options = [`<option value="all">Everyone</option>`, ...people.map((p) => `<option value="${esc(p.id)}" ${p.id === dash.person ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
    return `<div class="filters">
        <div class="seg" role="group" aria-label="Period">${periods.map(([k, l]) => `<button data-act="period" data-p="${k}" aria-pressed="${dash.period === k}">${l}</button>`).join('')}</div>
        <select id="personFilter" aria-label="Filter by person">${options}</select>
        <button class="ghost push" data-act="download">Download all numbers</button>
      </div>
      <p class="range">${rangeLabel(from, to)}</p>
      ${checkLine(setters, closers, from, to)}
      ${roleBlock('setter', 'Setters', setters, from, to)}
      ${roleBlock('closer', 'Closers', closers, from, to)}`;
  }

  // Every tap ever logged, one row per person, day and number, for a backup or a spreadsheet.
  function downloadCSV() {
    const labels = Object.fromEntries([...Core.SETTER_METRICS, ...Core.CLOSER_METRICS].map((m) => [m.id, m.label]));
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [];
    for (const p of Store.people()) {
      for (const [day, metrics] of Object.entries(Store.counts()[p.id] || {})) {
        for (const [m, n] of Object.entries(metrics)) rows.push([day, p.name, labels[m] || m, n]);
      }
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1].localeCompare(b[1])));
    const csv = [['Date', 'Person', 'Number', 'Count'], ...rows].map((r) => r.map(cell).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `Kept Scorecard ${today()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Team (managers only) ---------- */
  function linkBoxHTML() {
    if (!lastLink) return '';
    return `<div class="linkbox">
      <p><strong>Send this to ${esc(lastLink.name)}.</strong> It's their personal sign-in, so send it only to them. It won't be shown again, but you can always make a new one.</p>
      <input type="text" readonly value="${esc(lastLink.url)}" aria-label="Personal link" id="linkField">
      <div class="linkbtns">
        <button class="primary" data-act="copyMsg">Copy message</button>
        <button class="ghost" data-act="copyLink">Copy link only</button>
        <button class="link" data-act="hideLink">Done</button>
      </div>
    </div>`;
  }

  function teamHTML() {
    const me = Store.current();
    const rows = Store.people().map((p) => {
      const self = p.id === me.id;
      const actions = p.active
        ? `<button class="link" data-act="newLink" data-id="${esc(p.id)}">New link</button>${self ? '' : ` <button class="link" data-act="turnOff" data-id="${esc(p.id)}">Turn off</button>`}`
        : `<button class="link" data-act="newLink" data-id="${esc(p.id)}">Turn back on</button>`;
      return `<tr class="${p.active ? '' : 'off'}"><td>${esc(p.name)}${self ? ' <span class="tag">you</span>' : ''}</td><td>${roleText(p.roles)}</td><td>${p.isAdmin ? 'Yes' : ''}</td><td>${p.active ? 'On' : 'Off'}</td><td class="acts">${actions}</td></tr>`;
    }).join('');
    return `<section class="panel"><h2>Team</h2>
      <p class="lead">Add someone, then send them their personal link. Each link signs in one person. If a link gets lost or shared, make a new one and the old one stops working.</p>
      <form class="team-add" id="teamAdd">
        <input type="text" id="tName" placeholder="Name" aria-label="Name" maxlength="40" required>
        <label><input type="checkbox" id="tSetter" checked> Setter</label>
        <label><input type="checkbox" id="tCloser"> Closer</label>
        <label><input type="checkbox" id="tAdmin"> Can manage the team</label>
        <button class="primary" type="submit">Add and get link</button>
      </form>
      ${linkBoxHTML()}
      <div class="tbl"><table class="team"><thead><tr><th>Name</th><th>Role</th><th>Manager</th><th>Link</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">Turning someone off stops their link. Their past numbers stay in the totals.</p>
    </section>`;
  }

  function inviteText() {
    const first = lastLink.name.split(/\s+/)[0];
    return `Hi ${first}, here's your Kept Scorecard link: ${lastLink.url}\n\nOpen it in Chrome on your computer, then click Pop out to keep the counter on your screen. It's your personal sign-in, so keep it to yourself.`;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch (e) { const f = document.getElementById('linkField'); if (f) { f.select(); } toast('Select the link and copy it.'); }
  }

  /* ---------- What each number means ---------- */
  function infoHTML(roles) {
    const metrics = [
      ...(roles.includes('setter') ? Core.SETTER_METRICS : []),
      ...(roles.includes('closer') ? Core.CLOSER_METRICS : []),
    ];
    let body = '';
    let group = null;
    for (const m of metrics) {
      if (m.group !== group) { group = m.group; body += `<div class="info-group">${group}</div>`; }
      body += `<p class="info-item"><b>${m.label}</b><span>${esc(m.def)}</span></p>`;
    }
    const rule = roles.includes('setter') ? `<p class="info-rule">${esc(Core.DEALS_RULE)}</p>` : '';
    return `<div class="info-body"><div class="info-head"><h2>What each number means</h2>
      <button class="info-close" data-act="closeInfo" aria-label="Close">×</button></div>${body}${rule}</div>`;
  }

  // Opens in whichever window was clicked, so it works inside the pop-out too.
  function showInfo(doc, roles) {
    const open = doc.getElementById('info');
    if (open) open.remove();
    const dlg = doc.createElement('dialog');
    dlg.id = 'info';
    dlg.className = 'info';
    dlg.setAttribute('aria-label', 'What each number means');
    dlg.innerHTML = infoHTML(roles);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    doc.body.append(dlg);
    dlg.showModal();
  }

  /* ---------- Page frame ---------- */
  function gateHTML() {
    const text = {
      loading: 'Loading…',
      noKey: "Open the personal link Vez sent you to sign in. Don't have one yet? Ask Vez.",
      badKey: "This link doesn't work anymore. Ask Vez for a new one.",
      offline: "Can't reach the scorecard right now. Check your internet and try again.",
    }[status];
    const retry = status === 'offline' ? '<button class="primary" data-act="retry">Try again</button>' : '';
    return `<div class="signin"><h1>Kept Scorecard</h1><p>${text}</p>${retry}</div>`;
  }

  function render() {
    const p = status === 'ok' ? Store.current() : null;
    if (!p) { closePip(); app.innerHTML = `<div class="wrap">${gateHTML()}</div>`; return; }
    if (view === 'team' && !Store.isAdmin()) view = 'counter';
    const tabs = [['counter', 'Counter'], ['dashboard', 'Dashboard'], ...(Store.isAdmin() ? [['team', 'Team']] : [])];
    const main = view === 'counter' ? counterHTML(p) : view === 'dashboard' ? dashboardHTML() : teamHTML();
    app.innerHTML = `<div class="wrap">
      <header class="top"><span class="brand-wrap"><span class="brand">Kept Scorecard</span>${view === 'dashboard' ? '<button class="i" data-act="info" aria-label="What each number means">i</button>' : ''}</span>
        <div class="seg" role="group" aria-label="View">
          ${tabs.map(([k, l]) => `<button data-act="nav" data-v="${k}" aria-pressed="${view === k}">${l}</button>`).join('')}
        </div>
        <div class="who">${esc(p.name)} <button class="link" data-act="signout">Sign out</button></div>
      </header>
      <main>${main}</main></div>`;
  }

  function closePip() { if (pipWindow) { pipWindow.close(); pipWindow = null; } }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
    document.body.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  function setView(v) {
    view = v;
    history.replaceState(null, '', location.pathname + location.search + (view === 'dashboard' ? '#dashboard' : ''));
    render();
  }

  async function start() {
    status = 'loading';
    render();
    status = await Store.load();
    render();
  }

  /* ---------- Events ---------- */
  async function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const d = t.dataset;
    switch (d.act) {
      case 'bump': {
        const p = Store.current();
        if (p && Store.bump(p.id, d.m, Number(d.d), today())) { syncCounts(); if (view === 'dashboard') render(); }
        break;
      }
      case 'nav': setView(d.v); break;
      case 'signout':
        if (confirm("Sign out on this computer? You'll need your personal link to get back in.")) { closePip(); Store.signOut(); status = 'noKey'; render(); }
        break;
      case 'popout': popOut(); break;
      case 'homeScreen': showHomeSteps(); break;
      case 'homeDone': closeHomeSteps(t.closest('dialog')); break;
      case 'openDash': {
        // From the pop-out: show everyone's numbers in the main tab and bring it forward.
        dash.person = 'all';
        setView('dashboard');
        window.focus();
        t.textContent = 'Open in your Chrome tab';
        setTimeout(() => { if (t.isConnected) t.textContent = 'Team dashboard'; }, 2500);
        break;
      }
      case 'info': showInfo(t.ownerDocument, t.closest('.card') ? Store.current().roles : ['setter', 'closer']); break;
      case 'closeInfo': t.closest('dialog').close(); break;
      case 'period': dash.period = d.p; render(); break;
      case 'sort': {
        const s = dash.sort[d.role];
        if (s.id === d.col) s.dir *= -1; else { s.id = d.col; s.dir = -1; }
        render();
        break;
      }
      case 'download': downloadCSV(); break;
      case 'retry': start(); break;
      case 'newLink': {
        const p = Store.person(d.id);
        if (!p) break;
        if (p.active && !confirm(`Make a new link for ${p.name}? Their current link will stop working.`)) break;
        try { lastLink = { name: p.name, url: Store.linkFor(await Store.newLink(p.id)) }; render(); }
        catch (err) { toast("Couldn't make a link. Try again."); }
        break;
      }
      case 'turnOff': {
        const p = Store.person(d.id);
        if (!p || !confirm(`Turn off ${p.name}'s link? Their past numbers stay in the totals.`)) break;
        try { await Store.turnOff(p.id); if (lastLink && lastLink.name === p.name) lastLink = null; render(); }
        catch (err) { toast("Couldn't turn that off. Try again."); }
        break;
      }
      case 'copyMsg': if (lastLink) copy(inviteText()); break;
      case 'copyLink': if (lastLink) copy(lastLink.url); break;
      case 'hideLink': lastLink = null; render(); break;
    }
  }

  document.addEventListener('click', onClick);

  document.addEventListener('change', (e) => {
    if (e.target.id === 'personFilter') { dash.person = e.target.value; render(); return; }
    const role = e.target.dataset && e.target.dataset.role;
    if (!role) return;
    const p = Store.current();
    const roles = ['setter', 'closer'].filter((r) => (r === role ? e.target.checked : p.roles.includes(r)));
    if (!roles.length) { e.target.checked = true; toast('Everyone needs at least one role.'); return; }
    Store.setRoles(p.id, roles);
    render();
    renderPip();
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'teamAdd') return;
    e.preventDefault();
    const name = document.getElementById('tName').value.trim();
    const roles = [];
    if (document.getElementById('tSetter').checked) roles.push('setter');
    if (document.getElementById('tCloser').checked) roles.push('closer');
    const admin = document.getElementById('tAdmin').checked;
    if (!name) return;
    if (!roles.length) { toast('Pick setter, closer or both.'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const out = await Store.addPerson(name, roles, admin);
      lastLink = { name, url: Store.linkFor(out.key) };
      render();
    } catch (err) {
      btn.disabled = false;
      toast("Couldn't add them. Check the name and try again.");
    }
  });

  // Other people's taps show up on their own. Typing on the Team page is never interrupted.
  Store.on('change', () => {
    const typing = document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (!(view === 'team' && typing)) render();
    renderPip();
  });
  Store.on('error', (err) => {
    if (err.kind === 'badKey') { status = 'badKey'; Store.signOut(); render(); return; }
    toast(err.kind === 'offline' ? "That tap didn't save. Check your internet and tap again." : "That didn't save. Try again.");
  });

  const refresh = () => { if (status === 'ok' && document.visibilityState === 'visible') Store.refresh(); };
  setInterval(refresh, 30000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);

  // Rolls over on its own at midnight and on Monday, even if the page stays open.
  setInterval(() => {
    const now = today();
    if (now !== lastDay) { lastDay = now; render(); renderPip(); }
  }, 60000);

  Store.init();
  start();
})();
