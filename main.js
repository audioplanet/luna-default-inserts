// Default Inserts: DOM wiring. Connects to LUNA, keeps the settings, follows the focused
// session and watches it for new tracks and buses. The engine work is in logic.js.

const $ = (id) => document.getElementById(id);
const L = AddOnLogic;
let luna;
let session;
let stopWatch = null;
let settings = L.emptySettings();

// ---- settings: kept per install, so they apply to every session ----

function loadSettings() {
  try {
    settings = L.parseSettings(localStorage.getItem(L.STORAGE_KEY));
  } catch {
    settings = L.emptySettings();
  }
}

function saveSettings() {
  try {
    localStorage.setItem(L.STORAGE_KEY, JSON.stringify(settings));
  } catch {
    log('Could not save settings; they last until the window closes.', true);
  }
}

// ---- activity log ----

function log(text, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  line.textContent = `${time}  ${text}`;
  $('log').prepend(line);
  while ($('log').childElementCount > 100) $('log').lastChild.remove();
}

function logResult(ch, kind, r) {
  const name = ch.name.value ?? ch.id;
  if (r.added.length) log(`${name}: added ${r.added.join(', ')}`);
  for (const f of r.failed) log(`${name}: could not add ${f.name} (${f.error})`, true);
}

// ---- UI ----

function renderEnabled() {
  const b = $('enabled');
  b.textContent = settings.enabled ? 'On' : 'Off';
  b.classList.toggle('on', settings.enabled);
}

function renderLists() {
  const root = $('lists');
  root.innerHTML = '';
  for (const kind of L.KINDS) root.appendChild(renderKind(kind));
}

function renderKind(kind) {
  const sec = document.createElement('section');
  sec.innerHTML = `<h2></h2><div class="items"></div><div class="add"><input type="search" placeholder="Add a plugin…" autocomplete="off"><div class="results" hidden></div></div>`;
  sec.querySelector('h2').textContent = L.KIND_LABELS[kind];
  const items = sec.querySelector('.items');
  const list = settings.lists[kind];
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing added';
    items.appendChild(e);
  }
  list.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'plugin';
    row.innerHTML = `<span class="n"></span><button class="up" title="Move up">↑</button><button class="down" title="Move down">↓</button><button class="rm" title="Remove">✕</button>`;
    row.querySelector('.n').textContent = p.name;
    row.querySelector('.up').disabled = i === 0;
    row.querySelector('.down').disabled = i === list.length - 1;
    row.querySelector('.up').onclick = () => move(kind, i, -1);
    row.querySelector('.down').onclick = () => move(kind, i, 1);
    row.querySelector('.rm').onclick = () => {
      list.splice(i, 1);
      saveSettings();
      renderLists();
    };
    items.appendChild(row);
  });
  wirePicker(kind, sec.querySelector('input'), sec.querySelector('.results'));
  return sec;
}

function move(kind, i, by) {
  const list = settings.lists[kind];
  [list[i], list[i + by]] = [list[i + by], list[i]];
  saveSettings();
  renderLists();
}

/** A search box that lists the effect plugins LUNA would accept in an insert slot. */
function wirePicker(kind, input, results) {
  let seq = 0;
  let rows = [];
  let sel = -1;
  const close = () => {
    results.hidden = true;
    sel = -1;
  };
  const choose = (row) => {
    const list = settings.lists[kind];
    if (!list.some((p) => p.id === row.pluginId)) list.push({ id: row.pluginId, name: L.label(row) });
    saveSettings();
    renderLists();
  };
  const paint = () => {
    results.innerHTML = '';
    rows.forEach((r, i) => {
      const d = document.createElement('div');
      d.textContent = L.label(r);
      if (r.manufacturer) {
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = r.manufacturer;
        d.appendChild(m);
      }
      d.classList.toggle('sel', i === sel);
      d.onmousedown = (e) => {
        e.preventDefault();
        choose(r);
      };
      results.appendChild(d);
    });
    results.hidden = rows.length === 0;
  };
  const search = async () => {
    const text = input.value.trim();
    const mine = ++seq;
    if (!text || !luna) {
      rows = [];
      return close();
    }
    try {
      const found = await luna.plugins.query({ search: text, insertType: 'effect_0', limit: 40 });
      if (mine !== seq) return;
      rows = found;
      sel = rows.length ? 0 : -1;
      paint();
    } catch (e) {
      if (mine === seq) log(`Plugin search failed: ${e.message}`, true);
    }
  };
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  };
  input.onkeydown = (e) => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      paint();
    } else if (e.key === 'Enter' && rows[sel]) {
      e.preventDefault();
      choose(rows[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  input.onblur = close;
}

// ---- engine ----

async function seedIfFirstRun() {
  if (settings.seeded) return;
  try {
    const rows = await luna.plugins.query({ search: L.DEFAULT_SEARCH, insertType: 'effect_0' });
    settings = L.seedSettings(settings, rows);
    saveSettings();
    const picked = new Set(L.KINDS.flatMap((k) => settings.lists[k].map((p) => p.name)));
    if (picked.size) log(`Set up with ${[...picked].join(', ')}`);
    else log(`${L.DEFAULT_SEARCH} is not installed. Add the plugins you want below.`, true);
  } catch (e) {
    log(`Could not look for ${L.DEFAULT_SEARCH}: ${e.message}`, true);
  }
}

// Session events arrive in bursts. Handle them one at a time, or each would start its own
// watcher and every new channel would get its plugins once per watcher.
let bindQueue = Promise.resolve();
function bindSession() {
  bindQueue = bindQueue.then(bindSessionNow, bindSessionNow);
  return bindQueue;
}

async function bindSessionNow() {
  const next = luna.sessions.current();
  // Re-watching the same session would forget which channels are new; keep the watch.
  if (next && next === session && stopWatch) return;
  stopWatch?.();
  stopWatch = null;
  session = next;
  $('applyAll').disabled = !session;
  if (!session) {
    $('status').textContent = 'No session open';
    return;
  }
  const s = session;
  await s.ready();
  const stop = await L.watchNewChannels(s, () => settings, logResult);
  if (session !== s) return stop(); // the focus moved on while we were starting
  stopWatch = stop;
  $('status').textContent = `Watching “${s.name.value ?? s.uid}” for new tracks and buses`;
}

async function connect() {
  loadSettings();
  renderEnabled();
  renderLists();
  $('enabled').onclick = () => {
    settings.enabled = !settings.enabled;
    saveSettings();
    renderEnabled();
    log(settings.enabled ? 'Switched on' : 'Switched off: new tracks are left alone');
  };
  $('applyAll').onclick = async () => {
    if (!session) return;
    $('applyAll').disabled = true;
    let n = 0;
    try {
      await L.applyToAll(session, () => settings, (ch, kind, r) => {
        n++;
        logResult(ch, kind, r);
      });
      if (!n) log('Every track and bus already has its plugins');
    } catch (e) {
      log(`Apply failed: ${e.message}`, true);
    } finally {
      $('applyAll').disabled = !session;
    }
  };

  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('status').textContent = 'Reconnecting…';
    if (luna.status.value === 'connected') bindSession();
  });
  await seedIfFirstRun();
  renderLists();
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  await bindSession();
}

connect();
