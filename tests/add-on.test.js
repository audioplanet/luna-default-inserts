// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

const C1 = 'com.softube.console1channel';
const EQ = 'com.uaudio.uadx.pultec';

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addPlugin(C1, { name: 'Console 1 Channel Mk III', categories: ['Channel Strip'] });
  engine.addPlugin(EQ, { name: 'Pultec EQP-1A', categories: ['EQ'] });
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.ready();
  return { engine, luna, session };
}

const settingsWith = (lists) => ({ ...logic.emptySettings(), seeded: true, lists: { audio: [], instrument: [], bus: [], ...lists } });
const c1 = { id: C1, name: 'Console 1 Channel Mk III' };
const eq = { id: EQ, name: 'Pultec EQP-1A' };
const pluginIds = (ch) => ch.loadedEffects.map((e) => e.pluginId.value);

describe('settings', () => {
  it('survives empty, broken and partial storage', () => {
    expect(logic.parseSettings(null)).toEqual(logic.emptySettings());
    expect(logic.parseSettings('{oops')).toEqual(logic.emptySettings());
    const s = logic.parseSettings(JSON.stringify({ enabled: false, lists: { bus: [{ id: 'x' }, 7] } }));
    expect(s.enabled).toBe(false);
    expect(s.lists).toEqual({ audio: [], instrument: [], bus: [{ id: 'x', name: 'x' }] });
  });

  it('seeds Console 1 once, preferring a bus variant for buses', () => {
    const rows = [
      { pluginId: 'b', name: 'Console 1 Bus' },
      { pluginId: 'c', name: 'Console 1 Channel Mk III' },
      { pluginId: 'z', name: 'Something else' },
    ];
    const s = logic.seedSettings(logic.emptySettings(), rows);
    expect(s.lists.audio[0].id).toBe('c');
    expect(s.lists.instrument[0].id).toBe('c');
    expect(s.lists.bus[0].id).toBe('b');
    // Once seeded, an emptied list stays empty.
    s.lists.bus = [];
    expect(logic.seedSettings(s, rows).lists.bus).toEqual([]);
  });

  it('seeds nothing when Console 1 is not installed', () => {
    const s = logic.seedSettings(logic.emptySettings(), [{ pluginId: 'z', name: 'Other' }]);
    expect(s.seeded).toBe(true);
    expect(s.lists.audio).toEqual([]);
  });
});

describe('inserting', () => {
  it('sorts channels into audio, instrument and bus, and skips master', async () => {
    const { session } = await connected();
    const [inst] = await session.newTrack({ name: 'Synth', trackType: 'instrument' });
    const bus = await session.newBus({ name: 'Verb' });
    expect(logic.kindOf(session.tracks.items[0])).toBe('audio');
    expect(logic.kindOf(inst)).toBe('instrument');
    expect(logic.kindOf(bus)).toBe('bus');
    expect(logic.kindOf(session.master)).toBe(null);
  });

  it('adds the list in order as one undo step, and never twice', async () => {
    const { engine, session } = await connected();
    const vocal = session.tracks.items[0];
    const before = engine.transactions.length;
    const r = await logic.applyDefaults(session, vocal, [c1, eq]);
    await engine.settled();
    expect(r).toEqual({ added: [c1.name, eq.name], failed: [] });
    expect(pluginIds(vocal)).toEqual([C1, EQ]);
    expect(engine.transactions.slice(before)).toEqual(['begin', 'commit']);

    const again = await logic.applyDefaults(session, vocal, [c1, eq]);
    expect(again.added).toEqual([]);
    expect(pluginIds(vocal)).toEqual([C1, EQ]);
  });

  it('reports a plugin LUNA cannot load instead of stopping', async () => {
    const { session } = await connected();
    const r = await logic.applyDefaults(session, session.tracks.items[0], [{ id: 'not.installed', name: 'Ghost' }, c1]);
    expect(r.added).toEqual([c1.name]);
    expect(r.failed.map((f) => f.name)).toEqual(['Ghost']);
  });
});

describe('watching', () => {
  it('leaves existing channels alone and fills new tracks and buses', async () => {
    const { engine, session } = await connected();
    const settings = settingsWith({ audio: [c1], instrument: [c1], bus: [c1, eq] });
    const log = [];
    const stop = await logic.watchNewChannels(session, () => settings, (ch, kind, r) => log.push([ch.name.value, kind, r.added]));

    const [drums] = await session.newTrack({ name: 'Drums' });
    const [synth] = await session.newTrack({ name: 'Synth', trackType: 'instrument' });
    const bus = await session.newBus({ name: 'Verb' });
    await engine.settled();
    await stop.idle();
    await engine.settled();

    expect(pluginIds(drums)).toEqual([C1]);
    expect(pluginIds(synth)).toEqual([C1]);
    expect(pluginIds(bus)).toEqual([C1, EQ]);
    await session.tracks.items[0].effects.load();
    expect(pluginIds(session.tracks.items[0])).toEqual([]); // Vocal existed before
    expect(log.map((l) => l[0]).sort()).toEqual(['Drums', 'Synth', 'Verb']);
    stop();
  });

  it('does nothing while switched off, and stops when told', async () => {
    const { engine, session } = await connected();
    const settings = settingsWith({ audio: [c1] });
    settings.enabled = false;
    const stop = await logic.watchNewChannels(session, () => settings, () => {});
    const [a] = await session.newTrack({ name: 'Off' });
    await engine.settled();
    await stop.idle();
    await a.effects.load();
    expect(pluginIds(a)).toEqual([]);

    settings.enabled = true;
    stop();
    const [b] = await session.newTrack({ name: 'Stopped' });
    await engine.settled();
    await stop.idle();
    await b.effects.load();
    expect(pluginIds(b)).toEqual([]);
  });

  it('fills existing channels on request', async () => {
    const { engine, session } = await connected();
    const done = [];
    await logic.applyToAll(session, () => settingsWith({ audio: [c1] }), (ch) => done.push(ch.name.value));
    await engine.settled();
    expect(done).toEqual(['Vocal', 'Bass']);
    for (const t of session.tracks.items) expect(pluginIds(t)).toEqual([C1]);
  });
});

describe('labels', () => {
  it('tells VST3 and AU versions apart', () => {
    expect(logic.label({ pluginId: 'com.Softube.vst3.Console 1', name: 'Console 1' })).toBe('Console 1 (VST3)');
    expect(logic.label({ pluginId: 'com.SfTb.au.aufx_ScPi', name: 'Console 1' })).toBe('Console 1 (AU)');
    expect(logic.label({ pluginId: 'com.uaudio.uadx.1176', name: 'UA 1176' })).toBe('UA 1176');
  });
});

describe('seeding with two formats', () => {
  it('prefers the VST3 version', () => {
    const s = logic.seedSettings(logic.emptySettings(), [
      { pluginId: 'com.SfTb.au.aufx_ScPi', name: 'Console 1' },
      { pluginId: 'com.Softube.vst3.Console 1', name: 'Console 1' },
    ]);
    for (const k of logic.KINDS) expect(s.lists[k]).toEqual([{ id: 'com.Softube.vst3.Console 1', name: 'Console 1 (VST3)' }]);
  });
});
