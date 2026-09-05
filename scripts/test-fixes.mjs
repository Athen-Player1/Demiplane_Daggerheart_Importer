import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_ID, normalizeDemiplaneCharacter, parseDemiplaneCharacterHtml, connectionsForBiography } from './parser.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/character.json', import.meta.url)));
const clone = structuredClone;
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function set(object, path, value) {
    const keys = path.split('.');
    const key = keys.pop();
    for (const part of keys) object = object[part] ??= {};
    object[key] = clone(value);
}
function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value);
        else target[key] = clone(value);
    }
    return target;
}
class Collection extends Array {
    get(id) { return this.find(item => item.id === id || item.collection === id); }
}
let nextId = 0;
class Item {
    constructor(data) { Object.assign(this, clone(data)); this.id = `item${++nextId}`; }
    getFlag(namespace, key) { return this.flags?.[namespace]?.[key]; }
    async update(update) { for (const [path, value] of Object.entries(update)) set(this, path, value); }
}
class MockActor {
    items = new Collection(); effects = new Collection(); flags = {}; system = {}; deletions = [];
    async createEmbeddedDocuments(type, data) {
        assert.equal(type, 'Item');
        const items = data.map(value => new Item(value));
        for (const item of items.filter(item => item.type === 'class')) {
            this.system.biography ??= {};
            this.system.biography.connections = (this.system.biography.connections ?? '') +
                (item.system.connections ?? []).filter(Boolean).map(question => `<p><strong>${question}</strong></p>`).join('<br/>');
        }
        this.items.push(...items);
        return items;
    }
    async deleteEmbeddedDocuments(type, ids) {
        this.deletions.push(...ids);
        const key = type === 'Item' ? 'items' : 'effects';
        this[key] = this[key].filter(item => !ids.includes(item.id));
    }
    async update(update) { merge(this, update); }
    async setFlag(namespace, key, value) { set(this.flags, `${namespace}.${key}`, value); }
}
function pack(collection, data) {
    return {
        collection, documentName: 'Item', visible: true,
        async getIndex() { return data.map((item, i) => ({ _id: String(i), name: item.name, type: item.type })); },
        async getDocument(id) { return { uuid: `Compendium.${collection}.Item.${id}`, toObject: () => clone(data[Number(id)]) }; }
    };
}
const armor = { name: 'Mage Robes', type: 'armor', system: { equipped: false, quantity: 1, armor: { current: 0, max: 2 }, baseThresholds: { major: 4, severe: 10 } } };
const weapon = name => ({ name, type: 'weapon', _id: 'compendium-id', system: { equipped: false, quantity: 1, secondary: false } });
globalThis.Hooks = { once() {}, on() {} };
globalThis.foundry = { utils: { deepClone: clone, mergeObject: merge, getProperty: get, setProperty: set, isEmpty: object => Object.keys(object).length === 0 } };
globalThis.ui = { notifications: { warn() {} } };
globalThis.game = { packs: new Collection() };
const { syncImportedItems, buildSystemUpdate, findPackItem } = await import('./module.mjs');
beforeEach(() => {
    // Exercise mixed installed content: 2.6.4 public packs lack the robes/dagger.
    game.packs = new Collection(
        pack('daggerheart.weapons', [weapon('Dualstaff')]),
        pack('daggerheart.consumables', [{ name: 'Minor Health Potion', type: 'consumable', system: { quantity: 1 } }]),
        pack('extra.content', [{ name: 'Mage Robes', type: 'feature' }, armor, weapon('Casting Dagger')])
    );
});
const normalized = () => normalizeDemiplaneCharacter(clone(fixture));
const item = (actor, name) => actor.items.find(item => item.name === name);

test('observed payload imports each real inventory instance once with descriptions', () => {
    const n = normalized();
    assert.deepEqual(n.selections.equipment.map(item => item.name), ['Casting Dagger', 'Dualstaff', 'Mage Robes', 'Minor Health Potion']);
    assert.equal(n.selections.customEquipment.length, 5);
    assert.match(n.selections.customEquipment.find(item => item.name === 'Nomadic Pack').description, /Hope/);
});
test('equipped IDs distinguish active dagger and robes from carried staff', () => {
    assert.deepEqual(normalized().selections.equipment.map(item => item.equipped), [true, false, true, false]);
});
test('connections populate native biography field in numeric order', () => {
    assert.equal(buildSystemUpdate(normalized()).biography.connections, '<p>Connection answer 0</p>\n<p>Connection answer 1</p>\n<p>Connection answer 2</p>');
});
test('empty connections clear previous answers and HTML is escaped', () => {
    const n = normalized(); n.connections = [];
    assert.equal(buildSystemUpdate(n).biography.connections, '');
    n.connections = ['<img onerror="bad"> &\nnext'];
    assert.equal(buildSystemUpdate(n).biography.connections, '<p>&lt;img onerror=&quot;bad&quot;&gt; &amp;<br>next</p>');
});

test('connection answers follow their questions after class creation and repeated refresh', async () => {
    const questions = ['Why do you confide in me?', 'What did you see?', 'What was foolish?'];
    game.packs.push(pack('daggerheart.classes', [{ name: 'Warlock', type: 'class', system: { connections: questions } }]));
    const n = normalized(); n.selections.class = { name: 'Warlock' };
    const actor = new MockActor();
    const expected = questions.map((q, i) => `<p><strong>${q}</strong></p>\n<p>Connection answer ${i}</p>`).join('\n');
    for (let i = 0; i < 3; i++) {
        await actor.update({ system: buildSystemUpdate(n) });
        await syncImportedItems(actor, n);
        assert.equal(actor.system.biography.connections, expected);
    }
    n.connections = []; n.connectionIndices = [];
    await syncImportedItems(actor, n);
    assert.equal(actor.system.biography.connections, '');
});
test('skipped connection questions do not shift answer pairing', () => {
    const f = clone(fixture);
    f.character.data.engines = f.character.data.engines.filter(engine => !engine.name.includes('connection-1--answer'));
    const n = normalizeDemiplaneCharacter(f);
    assert.deepEqual(n.connectionIndices, [0, 2]);
    assert.equal(connectionsForBiography(n, ['First?', 'Skipped?', 'Third?']), '<p><strong>First?</strong></p>\n<p>Connection answer 0</p>\n<p><strong>Third?</strong></p>\n<p>Connection answer 2</p>');
});
test('missing or unsafe question text preserves answers and escapes markup', () => {
    const n = { connections: ['Answer', 'Another'], connectionIndices: [0, 4] };
    assert.equal(connectionsForBiography(n, ['<script>bad</script>']), '<p><strong>&lt;script&gt;bad&lt;/script&gt;</strong></p>\n<p>Answer</p>\n<p>Another</p>');
});
test('HTML parsing runs the production normalizer and rejects missing data', () => {
    const text = `43:${JSON.stringify(['$', 'component', null, { characterSheetContent: fixture }])}`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`;
    assert.equal(parseDemiplaneCharacterHtml(html).connections.length, 3);
    assert.throws(() => parseDemiplaneCharacterHtml('<html>Private</html>'), /Could not find/);
});
test('same-name inventory copies retain independent identities', () => {
    const f = clone(fixture);
    const copy = clone(f.character.data.engines.find(engine => engine.name === 'tabula/equipment/dualstaff.eng'));
    copy.demiplaneEngineId = 'second-staff'; f.character.data.engines.push(copy);
    assert.equal(normalizeDemiplaneCharacter(f).selections.equipment.filter(item => item.name === 'Dualstaff').length, 2);
});
test('custom equipment takes precedence over source-row categorization', () => {
    const f = clone(fixture); f.character.data.engines[0].args.sourceRow = 'inventory';
    assert.equal(normalizeDemiplaneCharacter(f).selections.customEquipment.length, 5);
});
test('quantity zero is retained and invalid quantities are ignored', () => {
    for (const [value, expected] of [[0, 0], ['3', 3], [-1, undefined], ['bad', undefined], ['', undefined]]) {
        const f = clone(fixture); f.character.data.engines[0].args.quantity = value;
        assert.equal(normalizeDemiplaneCharacter(f).selections.customEquipment[0].quantity, expected);
    }
});
test('matching searches equipment types and installed packs, with slug fallback', async () => {
    const found = await findPackItem('equipment', 'Mage Robes');
    assert.equal(found.toObject().type, 'armor'); assert.match(found.uuid, /extra.content/);
    assert.equal((await findPackItem('equipment', 'Renamed', 'minor-health-potion-playtest')).toObject().type, 'consumable');
    assert.equal(await findPackItem('class', 'Mage Robes'), null);
});
test('import creates usable equipment, preserves source UUIDs and descriptions', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    assert.equal(actor.items.length, 9);
    assert.equal(item(actor, 'Casting Dagger').system.equipped, true);
    assert.equal(item(actor, 'Dualstaff').system.equipped, false);
    assert.equal(item(actor, 'Mage Robes').type, 'armor');
    assert.equal(item(actor, 'Mage Robes').system.equipped, true);
    assert.equal(item(actor, 'Casting Dagger')._id, undefined);
    assert.match(item(actor, 'Casting Dagger')._stats.compendiumSource, /extra.content/);
    assert.match(item(actor, 'Nomadic Pack').system.description, /Hope/);
    assert.deepEqual(actor.flags[MODULE_ID].missingCompendiumMatches, []);
});
test('repeated refresh preserves armor marks without replacing new armor statistics', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    item(actor, 'Mage Robes').system.armor.current = 2;
    game.packs.push(pack('daggerheart.armors', [{ ...clone(armor), system: { ...clone(armor.system), armor: { current: 0, max: 4 }, baseThresholds: { major: 6, severe: 14 } } }]));
    for (let i = 0; i < 3; i++) await syncImportedItems(actor, normalized());
    assert.equal(actor.items.length, 9);
    assert.deepEqual(item(actor, 'Mage Robes').system.armor, { current: 2, max: 4 });
    assert.deepEqual(item(actor, 'Mage Robes').system.baseThresholds, { major: 6, severe: 14 });
});
test('source quantity/equipped changes override local state including zero/false', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    const n = normalized(); n.selections.equipment[0].quantity = 0;
    n.selections.equipment[0].equipped = false; n.selections.equipment[1].equipped = true;
    await syncImportedItems(actor, n);
    assert.equal(item(actor, 'Casting Dagger').system.quantity, 0);
    assert.equal(item(actor, 'Casting Dagger').system.equipped, false);
    assert.equal(item(actor, 'Dualstaff').system.equipped, true);
});
test('absent source quantity preserves local quantity', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    item(actor, 'Minor Health Potion').system.quantity = 0;
    await syncImportedItems(actor, normalized());
    assert.equal(item(actor, 'Minor Health Potion').system.quantity, 0);
});
test('refresh removes deleted imports but preserves user items and effects', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    const local = new Item({ name: 'Local item', type: 'loot' }); actor.items.push(local);
    const effect = new Item({ origin: `Actor.test.Item.${local.id}` }); actor.effects.push(effect);
    const orphan = new Item({ origin: 'Actor.test.Item.local-deleted-item' }); actor.effects.push(orphan);
    const importedEffect = new Item({ flags: { [MODULE_ID]: { imported: true } } }); actor.effects.push(importedEffect);
    const transferred = new Item({ origin: `Actor.test.Item.${item(actor, 'Casting Dagger').id}` }); actor.effects.push(transferred);
    const n = normalized(); n.selections.equipment = []; await syncImportedItems(actor, n);
    assert.equal(item(actor, 'Casting Dagger'), undefined);
    assert.ok(actor.items.includes(local)); assert.ok(actor.effects.includes(effect));
    assert.ok(actor.effects.includes(orphan));
    assert.ok(!actor.effects.includes(importedEffect)); assert.ok(!actor.effects.includes(transferred));
});
test('compendium read failure happens before destructive item replacement', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    const oldIds = actor.items.map(item => item.id);
    game.packs[0].getIndex = async () => { throw new Error('Compendium unavailable'); };
    await assert.rejects(syncImportedItems(actor, normalized()), /Compendium unavailable/);
    assert.deepEqual(actor.items.map(item => item.id), oldIds); assert.deepEqual(actor.deletions, []);
});
test('missing mechanical content becomes a reported loot placeholder', async () => {
    game.packs = new Collection(); const actor = new MockActor(); await syncImportedItems(actor, normalized());
    assert.equal(item(actor, 'Mage Robes').type, 'loot');
    assert.ok(actor.flags[MODULE_ID].missingCompendiumMatches.includes('equipment: Mage Robes'));
});

test('source traits override class suggestions used by spellcast armor effects', async () => {
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    assert.deepEqual(normalized().traits, { agility: 0, strength: -1, finesse: 0, instinct: 1, presence: 1, knowledge: 2 });
    assert.equal(actor.system.traits.knowledge.value, 2);
});
test('class HP/evasion are not persisted twice and refresh does not stack bonuses', async () => {
    game.packs.push(pack('daggerheart.classes', [{ name: 'Witch', type: 'class', system: { evasion: 10, hitPoints: 6 } }]));
    const n = normalized(); n.selections.class = { name: 'Witch' };
    n.selections.levelUps = [{ slug: 'add-hp' }, { slug: 'increase-evasion' }];
    const actor = new MockActor();
    for (let i = 0; i < 3; i++) await syncImportedItems(actor, n);
    assert.equal(actor.system.resources.hitPoints.max, 1);
    assert.equal(actor.system.evasion, 1);
});
test('armor marks migrate from older imports without source IDs and clamp to new max', async () => {
    const actor = new MockActor();
    const old = new Item({ ...clone(armor), flags: { [MODULE_ID]: { imported: true } } });
    old.system.armor.current = 3; actor.items.push(old);
    await syncImportedItems(actor, normalized());
    assert.equal(item(actor, 'Mage Robes').system.armor.current, 2);
});
test('two identical weapons preserve independent local quantities after refresh', async () => {
    const actor = new MockActor(); const n = normalized();
    n.selections.equipment.push({ ...n.selections.equipment[1], sourceId: 'second-staff' });
    await syncImportedItems(actor, n);
    const staffs = actor.items.filter(item => item.name === 'Dualstaff');
    staffs[0].system.quantity = 2; staffs[1].system.quantity = 5;
    await syncImportedItems(actor, n);
    assert.deepEqual(Array.from(actor.items.filter(item => item.name === 'Dualstaff'), item => item.system.quantity), [2, 5]);
});

// Optional integration check executes the downloaded upstream method verbatim.
// No Foundry runtime is bundled; its base class/settings are stubbed here.
test('upstream 2.6.4 armor/threshold preparation consumes imported real compendium data', { skip: !process.env.DH_SOURCE_DIR }, async () => {
    const root = process.env.DH_SOURCE_DIR;
    const source = readFileSync(`${root}/dh264-module-data-actor-character.mjs`, 'utf8');
    const start = source.indexOf('    prepareBaseData() {');
    const end = source.indexOf('    prepareDerivedData()', start);
    const getterStart = source.indexOf('    get armor() {');
    const getterEnd = source.indexOf('\n    }', getterStart) + 6;
    assert.ok(start > 0 && end > start && getterStart > 0);
    const Base = class { prepareBaseData() {} };
    const Model = new Function('Base', `return class extends Base { ${source.slice(getterStart, getterEnd)} ${source.slice(start, end)} }`)(Base);
    const robes = JSON.parse(readFileSync(`${root}/armor_Mage_Robes_rWDk8ovwnBrBwWRR.json`));
    const dagger = JSON.parse(readFileSync(`${root}/weapon_Casting_Dagger_eCEf5ysz8Eq0ma9u.json`));
    game.packs.push(pack('daggerheart.armors', [robes]), pack('actual.weapons', [dagger]));
    const actor = new MockActor(); await syncImportedItems(actor, normalized());
    const imported = item(actor, 'Mage Robes');
    assert.equal(imported.effects[0].system.changes[0].value, '@cast');
    assert.equal(imported.effects[0].flags[MODULE_ID].imported, true);
    globalThis.CONFIG = { DH: { id: 'daggerheart', SETTINGS: { gameSettings: { LevelTiers: 'tiers', Automation: 'auto', Homebrew: 'homebrew' } } } };
    game.settings = { get: (_id, key) => key === 'tiers' ? { tiers: [{ tier: 2, levels: { start: 2, end: 4 } }] } : key === 'auto' ? { levelupAuto: false } : { maxHope: 6 } };
    for (const [level, equipped, expected] of [[1, true, { major: 5, severe: 11 }], [3, true, { major: 7, severe: 13 }], [1, false, { major: 1, severe: 2 }]]) {
        imported.system.equipped = equipped;
        const model = new Model();
        Object.assign(model, { parent: { items: actor.items, appliedEffects: [] }, class: { value: null }, evasion: 0, levelData: { level: { current: level } }, resources: { hope: {}, hitPoints: { max: 0 } } });
        model.prepareBaseData();
        assert.deepEqual(model.damageThresholds, expected);
    }
});
