// The only file that talks to the team database. Screens read from a local copy
// (so taps feel instant) and every change is sent to the database right away.
(function () {
  const cfg = window.SCORECARD_CONFIG;
  const KEY_SLOT = 'keptScorecard.key';

  let key = null;
  let state = { me: null, people: [], counts: {} };
  let version = 0;       // bumps on every local change, so a slow refresh can't undo a fresh tap
  let inFlight = 0;
  let queue = Promise.resolve();
  const listeners = { change: [], error: [] };
  const emit = (type, arg) => listeners[type].forEach((fn) => fn(arg));

  function readKey() { try { return localStorage.getItem(KEY_SLOT); } catch (e) { return null; } }
  function writeKey(k) { try { if (k) localStorage.setItem(KEY_SLOT, k); else localStorage.removeItem(KEY_SLOT); } catch (e) { /* fine for this visit */ } }

  async function rpc(fn, args) {
    let res;
    try {
      res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.key },
        body: JSON.stringify(args),
      });
    } catch (e) {
      const err = new Error('offline'); err.kind = 'offline'; throw err;
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const msg = (body && body.message) || String(res.status);
      const err = new Error(msg);
      err.kind = msg === 'bad_key' ? 'badKey' : msg === 'not_admin' ? 'notAdmin' : 'server';
      throw err;
    }
    return body;
  }

  // Runs one write at a time, in tap order.
  function send(fn, args) {
    inFlight++;
    const p = queue.then(() => rpc(fn, args));
    queue = p.catch(() => {}).finally(() => { inFlight--; });
    return p;
  }

  function personCounts(id) { return (state.counts[id] = state.counts[id] || {}); }

  const Store = {
    // A personal link carries the key after #k=. Keep it on this device, then hide it from the address bar.
    init() {
      const m = location.hash.match(/^#k=([0-9a-f]{32})$/i);
      if (m) {
        writeKey(m[1].toLowerCase());
        history.replaceState(null, '', location.pathname + location.search);
      }
      key = readKey();
    },
    hasKey: () => !!key,

    // Returns 'ok', 'noKey', 'badKey' or 'offline'.
    async load() {
      if (!key) return 'noKey';
      try {
        state = await rpc('sc_data', { p_key: key });
        version++;
        return 'ok';
      } catch (e) {
        if (e.kind === 'badKey') { writeKey(null); key = null; return 'badKey'; }
        return 'offline';
      }
    },

    // Picks up everyone else's taps. Skipped while your own taps are still saving.
    async refresh() {
      if (!key || inFlight) return;
      const seen = version;
      let next;
      try { next = await rpc('sc_data', { p_key: key }); } catch (e) { if (e.kind === 'badKey') emit('error', e); return; }
      if (seen !== version || inFlight) return;
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      emit('change');
    },

    on(type, fn) { listeners[type].push(fn); },

    people: () => state.people,
    counts: () => state.counts,
    person: (id) => state.people.find((p) => p.id === id) || null,
    current: () => (state.me ? Store.person(state.me.id) || state.me : null),
    isAdmin: () => !!(state.me && state.me.isAdmin),

    // day is the day being shown (today, or up to 6 days back); today is the device's date.
    bump(id, metric, delta, day, today) {
      const changed = Core.bump(personCounts(id), metric, delta, day);
      if (!changed) return false;
      version++;
      send('sc_bump_day', { p_key: key, p_metric: metric, p_delta: delta, p_day: day, p_today: today }).catch(async (e) => {
        emit('error', e);
        if (await Store.load() === 'ok') emit('change');
      });
      return true;
    },

    setRoles(id, roles) {
      const p = Store.person(id);
      if (!p || !roles.length) return;
      p.roles = roles;
      if (state.me && state.me.id === id) state.me.roles = roles;
      version++;
      send('sc_set_roles', { p_key: key, p_roles: roles }).catch(async (e) => {
        emit('error', e);
        if (await Store.load() === 'ok') emit('change');
      });
    },

    // Forgets the key on this device only. Their personal link still works.
    signOut() { writeKey(null); key = null; state = { me: null, people: [], counts: {} }; },

    // Managers only. Each returns a fresh key, shown once.
    async addPerson(name, roles, admin) {
      const out = await send('sc_add_person', { p_key: key, p_name: name, p_roles: roles, p_admin: admin });
      await Store.load();
      return out;
    },
    async newLink(personId) {
      const k = await send('sc_new_link', { p_key: key, p_person: personId });
      await Store.load();
      return k;
    },
    async turnOff(personId) {
      await send('sc_turn_off', { p_key: key, p_person: personId });
      await Store.load();
    },

    linkFor(k) { return `${location.origin}${location.pathname}#k=${k}`; },

    // An iPhone Home Screen icon keeps its own separate sign-in, so the key has to be
    // in the address at the moment the icon is saved. Shown only while setting that up.
    showKeyInAddress(on) {
      history.replaceState(null, '', location.pathname + location.search + (on && key ? `#k=${key}` : ''));
    },
  };
  window.Store = Store;
})();
