// Default Inserts: logic with no DOM, so tests can exercise it against Luna.MockEngine.
//
// The user picks a list of plugins for each kind of channel (audio tracks, instrument
// tracks, buses). Whenever LUNA gains a new channel of that kind, the plugins it does not
// already have go into its first empty effect slots, as one undo step.

const KINDS = ['audio', 'instrument', 'bus'];
const KIND_LABELS = { audio: 'Audio tracks', instrument: 'Instrument tracks', bus: 'Buses' };
const STORAGE_KEY = 'com.audioplanet.default_inserts.settings';
const DEFAULT_SEARCH = 'Console 1';

const AddOnLogic = {
  KINDS,
  KIND_LABELS,
  STORAGE_KEY,
  DEFAULT_SEARCH,

  /** 'VST3', 'AU' or '' from a LUNA plugin id, to tell apart plugins that share a name. */
  formatOf(pluginId) {
    const id = pluginId.toLowerCase();
    if (id.includes('.vst3.')) return 'VST3';
    if (id.includes('.au.')) return 'AU';
    return '';
  },

  /** A plugin's name with its format when it has one: "Console 1 (VST3)". */
  label(row) {
    const f = AddOnLogic.formatOf(row.pluginId ?? row.id);
    return f ? `${row.name} (${f})` : row.name;
  },

  /** Settings with nothing chosen yet. */
  emptySettings() {
    return { enabled: true, lists: { audio: [], instrument: [], bus: [] }, seeded: false };
  },

  /** Parse stored settings, filling any gaps, so a damaged or old value never breaks the page. */
  parseSettings(text) {
    const s = AddOnLogic.emptySettings();
    if (!text) return s;
    try {
      const v = JSON.parse(text);
      if (typeof v.enabled === 'boolean') s.enabled = v.enabled;
      if (v.seeded === true) s.seeded = true;
      for (const k of KINDS) {
        const list = v.lists?.[k];
        if (Array.isArray(list)) {
          s.lists[k] = list
            .filter((p) => p && typeof p.id === 'string')
            .map((p) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id }));
        }
      }
    } catch {
      /* fall back to empty settings */
    }
    return s;
  },

  /**
   * First run: put the first effect plugin whose name matches `Console 1` on every kind.
   * `rows` are PluginRow objects from `luna.plugins.query`. Returns new settings, marked
   * seeded so a user who later empties a list does not get Console 1 back.
   */
  seedSettings(settings, rows) {
    if (settings.seeded) return settings;
    const next = structuredClone(settings);
    next.seeded = true;
    const needle = DEFAULT_SEARCH.toLowerCase();
    // VST3 first when a plugin comes in more than one format.
    const rank = (r) => (AddOnLogic.formatOf(r.pluginId) === 'VST3' ? 0 : 1);
    const matches = rows.filter((r) => r.name.toLowerCase().includes(needle)).sort((a, b) => rank(a) - rank(b));
    // Prefer a channel strip for tracks and a bus variant for buses, when both exist.
    const pick = (prefer) => matches.find((r) => r.name.toLowerCase().includes(prefer)) ?? matches[0];
    for (const k of KINDS) {
      if (next.lists[k].length) continue;
      const row = pick(k === 'bus' ? 'bus' : 'channel');
      if (row) next.lists[k] = [{ id: row.pluginId, name: AddOnLogic.label(row) }];
    }
    return next;
  },

  /**
   * Which list applies to a channel: 'audio', 'instrument', 'bus', or null for channels this
   * Add On leaves alone (master and other system buses, container folders, MIDI, video, click).
   */
  kindOf(channel) {
    if (channel.trackType) {
      const t = channel.trackType.value;
      return t === 'audio' || t === 'instrument' ? t : null;
    }
    if (channel.busType) {
      if (channel.busType.value !== 'aux') return null;
      // A container folder only groups tracks; no audio passes through it.
      if (channel.folderMode?.value === 'container') return null;
      return 'bus';
    }
    return null;
  },

  /** The plugins in `list` that the channel does not already have in an effect slot. */
  async missingPlugins(channel, list) {
    await channel.effects.load();
    await channel.effects.membersReady();
    const have = new Set(channel.loadedEffects.map((e) => e.pluginId.value));
    return list.filter((p) => !have.has(p.id));
  },

  /**
   * How long to wait for a plugin to load. Some take seconds (Console 1 takes about five on
   * LUNA 3.1.2, while it connects to its hardware), far longer than the SDK's default.
   */
  LOAD_TIMEOUT_MS: 30000,

  /**
   * Put each missing plugin of `list` on the channel, in order, as one undo step. Returns
   * `{ added: [names], failed: [{ name, error }] }`.
   *
   * The plugins are placed inside the undo step without waiting for them to load, so the step
   * closes at once; then each load is awaited. A plugin still loading when the wait runs out
   * stays in its slot and counts as added.
   */
  async applyDefaults(session, channel, list) {
    const result = { added: [], failed: [] };
    const missing = await AddOnLogic.missingPlugins(channel, list);
    if (!missing.length) return result;
    const free = channel.effectSlots.filter((e) => e.isEmpty);
    const placed = [];
    await session.transaction('Default Inserts', async () => {
      for (const p of missing) {
        const slot = free.shift();
        if (!slot) {
          result.failed.push({ name: p.name, error: 'no free insert slot' });
          continue;
        }
        try {
          await slot.setPlugin(p.id, { wait: false });
          placed.push({ p, slot });
        } catch (e) {
          result.failed.push({ name: p.name, error: e?.code ?? e?.message ?? String(e) });
        }
      }
    });
    await Promise.all(
      placed.map(async ({ p, slot }) => {
        try {
          await slot.waitForPlugin(AddOnLogic.LOAD_TIMEOUT_MS, p.id);
        } catch {
          /* still loading: it is in the slot, LUNA will finish */
        }
        const err = slot.pluginError.value ?? slot.pluginLicenseError.value;
        if (err) result.failed.push({ name: p.name, error: err });
        else result.added.push(p.name);
      }),
    );
    // Keep the list's order in the report, whatever order the loads finished in.
    result.added.sort((a, b) => list.findIndex((p) => p.name === a) - list.findIndex((p) => p.name === b));
    return result;
  },

  /** Every track and bus in the session, tracks first. */
  channels(session) {
    return [...session.tracks.items, ...session.buses.items];
  },

  /**
   * Fill in every existing channel that is missing its plugins. `getSettings()` is read once.
   * `onResult(channel, kind, result)` is called for each channel that got something or failed.
   */
  async applyToAll(session, getSettings, onResult) {
    const settings = getSettings();
    for (const ch of AddOnLogic.channels(session)) {
      const kind = AddOnLogic.kindOf(ch);
      if (!kind || !settings.lists[kind].length) continue;
      const r = await AddOnLogic.applyDefaults(session, ch, settings.lists[kind]);
      if (r.added.length || r.failed.length) onResult?.(ch, kind, r);
    }
  },

  /**
   * Watch a session for channels created from now on. Channels present when the watch
   * starts are left alone (use applyToAll for those). Returns a stop function; `stop.idle()`
   * resolves once every queued scan has finished.
   */
  async watchNewChannels(session, getSettings, onResult) {
    await Promise.all([session.tracks.membersReady(), session.buses.membersReady()]);
    const seen = new Set(AddOnLogic.channels(session).map((c) => c.id));
    let stopped = false;
    let queue = Promise.resolve();

    const scan = async () => {
      await Promise.all([session.tracks.membersReady(), session.buses.membersReady()]);
      for (const ch of AddOnLogic.channels(session)) {
        if (stopped || seen.has(ch.id)) continue;
        seen.add(ch.id);
        const settings = getSettings();
        if (!settings.enabled) continue;
        const kind = AddOnLogic.kindOf(ch);
        if (!kind || !settings.lists[kind].length) continue;
        try {
          const r = await AddOnLogic.applyDefaults(session, ch, settings.lists[kind]);
          onResult?.(ch, kind, r);
        } catch (e) {
          onResult?.(ch, kind, { added: [], failed: [{ name: '(all)', error: e?.message ?? String(e) }] });
        }
      }
    };
    // Serialise scans so a burst of new channels is handled one at a time, never twice.
    const schedule = () => {
      queue = queue.then(scan, scan);
      return queue;
    };
    const offTracks = session.tracks.onChange(schedule);
    const offBuses = session.buses.onChange(schedule);
    const stop = () => {
      stopped = true;
      offTracks();
      offBuses();
    };
    stop.idle = () => queue;
    return stop;
  },
};

globalThis.AddOnLogic = AddOnLogic;
