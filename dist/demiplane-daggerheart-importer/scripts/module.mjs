import { MODULE_ID, extractDemiplaneCharacterId, parseDemiplaneCharacterHtml, summarizeForBiography, connectionsForBiography, escapeHtml } from './parser.mjs';

const TEMPLATE = `modules/${MODULE_ID}/templates/import-dialog.hbs`;
const PACKS = {
    class: ['daggerheart.classes'],
    subclass: ['daggerheart.subclasses'],
    ancestry: ['daggerheart.ancestries'],
    community: ['daggerheart.communities'],
    domain: ['daggerheart.domains'],
    weapon: ['daggerheart.weapons'],
    armor: ['daggerheart.armors'],
    consumable: ['daggerheart.consumables'],
    loot: ['daggerheart.loot']
};

Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'corsProxy', {
        name: game.i18n.localize('DEMIPLANE_DH.settings.corsProxy.name'),
        hint: game.i18n.localize('DEMIPLANE_DH.settings.corsProxy.hint'),
        scope: 'world',
        config: true,
        type: String,
        default: ''
    });
});

Hooks.once('ready', () => {
    if (game.system.id !== 'daggerheart') {
        ui.notifications.warn(game.i18n.localize('DEMIPLANE_DH.notifications.systemRequired'));
        return;
    }
    console.log(`${MODULE_ID} | Ready`);
});

Hooks.on('getActorDirectoryEntryContext', (_html, options) => {
    options.push({
        name: game.i18n.localize('DEMIPLANE_DH.controls.update'),
        icon: '<i class="fa-solid fa-rotate"></i>',
        condition: li => getActorFromDirectoryEntry(li)?.type === 'character',
        callback: li => updateActorFromSavedUrl(getActorFromDirectoryEntry(li))
    });
});

Hooks.on('renderActorSheet', injectUpdateButton);
Hooks.on('renderActorSheetV2', injectUpdateButton);
Hooks.on('renderApplicationV2', injectUpdateButton);
Hooks.on('renderCharacterSheet', injectUpdateButton);

function injectUpdateButton(app, htmlOrElement) {
    const actor = app.actor ?? app.document ?? app.object;
    if (actor?.type !== 'character') return;

    const root = htmlOrElement instanceof jQuery ? htmlOrElement[0] : htmlOrElement;
    if (!(root instanceof HTMLElement)) return;
    if (root.querySelector('.demiplane-dh-update-button')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'demiplane-dh-update-button demiplane-dh-sheet-action';
    button.innerHTML = `<i class="fa-solid fa-rotate"></i> ${game.i18n.localize('DEMIPLANE_DH.controls.update')}`;
    button.title = 'Update from Demiplane (Shift+Click to edit URL)';
    button.addEventListener('click', event => {
        event.preventDefault();
        if (event.shiftKey) {
            editActorSourceUrl(actor);
        } else {
            updateActorFromSavedUrl(actor);
        }
    });

    const target = root.querySelector('.character-header-sheet .downtime-section')
        ?? root.querySelector('.character-header-sheet .name-row')
        ?? root.querySelector('.character-header-sheet')
        ?? root.querySelector('header')
        ?? root;
    target.append(button);
    console.log(`${MODULE_ID} | Added update button to ${actor.name}`);
}

function getActorFromDirectoryEntry(li) {
    const element = li instanceof jQuery ? li[0] : li;
    const id = element?.dataset?.documentId
        ?? element?.dataset?.entryId
        ?? element?.closest?.('[data-document-id]')?.dataset?.documentId
        ?? element?.closest?.('[data-entry-id]')?.dataset?.entryId;
    return id ? game.actors.get(id) : null;
}

Hooks.on('getSceneControlButtons', controls => {
    const tokenControls = controls.tokens ?? controls.find?.(c => c.name === 'token')?.tools;
    const tool = {
        name: 'demiplane-dh-import',
        title: game.i18n.localize('DEMIPLANE_DH.controls.import'),
        icon: 'fa-solid fa-file-import',
        visible: game.user.isGM,
        button: true,
        onClick: () => showImportDialog()
    };

    if (Array.isArray(tokenControls)) tokenControls.push(tool);
    else if (controls.tokens?.tools) controls.tokens.tools['demiplane-dh-import'] = tool;
});

async function showImportDialog() {
    const content = await renderTemplate(TEMPLATE, { url: '' });
    new Dialog({
        title: game.i18n.localize('DEMIPLANE_DH.dialog.title'),
        content,
        buttons: {},
        render: html => {
            const root = html instanceof jQuery ? html[0] : html;
            root.querySelector('form')?.addEventListener('submit', async event => {
                event.preventDefault();
                const url = new FormData(event.currentTarget).get('url');
                await importFromUrl(url);
                root.closest('.app')?.querySelector('.header-button.close')?.click();
            });
            root.querySelector('[data-action="cancel"]')?.addEventListener('click', event => {
                event.currentTarget.closest('.app')?.querySelector('.header-button.close')?.click();
            });
        }
    }).render(true);
}

async function importFromUrl(url) {
    validateUrl(url);
    const normalized = await fetchAndParse(url);

    // Foundryborne's Daggerheart character model has a rich default attack Action.
    // In Foundry v14, passing a partial `system` object at Actor.create time can
    // suppress/poison those nested defaults and causes Action validation failures.
    // Create the actor with only document-level data first, then apply partial
    // system updates after the system has initialized its own defaults.
    const actor = await Actor.create(buildActorCreateData(normalized));
    if (!actor) throw new Error('Actor creation failed; Foundry did not return a created actor.');

    await actor.update(buildActorPostCreateUpdate(normalized));
    await syncImportedItems(actor, normalized);
    ui.notifications.info(game.i18n.format('DEMIPLANE_DH.notifications.imported', { name: actor.name }));
    actor.sheet?.render(true);
    return actor;
}

async function updateActorFromSavedUrl(actor) {
    if (!actor) return;
    let url = actor.getFlag(MODULE_ID, 'sourceUrl');
    if (!url) {
        url = await promptForActorSourceUrl(actor);
        if (!url) return;
    }

    const normalized = await fetchAndParse(url);
    await actor.update(buildActorUpdate(normalized));
    await syncImportedItems(actor, normalized);
    ui.notifications.info(game.i18n.format('DEMIPLANE_DH.notifications.updated', { name: actor.name }));
    actor.sheet?.render(false);
}

async function promptForActorSourceUrl(actor) {
    const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, { url: '' });
    return new Promise(resolve => {
        new Dialog({
            title: `${game.i18n.localize('DEMIPLANE_DH.controls.update')}: ${actor.name}`,
            content,
            buttons: {},
            close: () => resolve(null),
            render: html => {
                const root = html instanceof jQuery ? html[0] : html;
                root.querySelector('form')?.addEventListener('submit', async event => {
                    event.preventDefault();
                    const url = new FormData(event.currentTarget).get('url');
                    try {
                        validateUrl(url);
                        await actor.setFlag(MODULE_ID, 'sourceUrl', url);
                        resolve(url);
                        root.closest('.app')?.querySelector('.header-button.close')?.click();
                    } catch (error) {
                        ui.notifications.error(error.message);
                    }
                });
                root.querySelector('[data-action="cancel"]')?.addEventListener('click', event => {
                    resolve(null);
                    event.currentTarget.closest('.app')?.querySelector('.header-button.close')?.click();
                });
            }
        }).render(true);
    });
}

async function editActorSourceUrl(actor) {
    if (!actor) return;
    const currentUrl = actor.getFlag(MODULE_ID, 'sourceUrl') || '';
    const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, { url: currentUrl });
    return new Promise(resolve => {
        new Dialog({
            title: `Edit Demiplane URL: ${actor.name}`,
            content,
            buttons: {},
            close: () => resolve(null),
            render: html => {
                const root = html instanceof jQuery ? html[0] : html;
                root.querySelector('form')?.addEventListener('submit', async event => {
                    event.preventDefault();
                    const url = new FormData(event.currentTarget).get('url');
                    try {
                        validateUrl(url);
                        await actor.setFlag(MODULE_ID, 'sourceUrl', url);
                        ui.notifications.info(`${actor.name}'s Demiplane URL has been updated`);
                        resolve(url);
                        root.closest('.app')?.querySelector('.header-button.close')?.click();
                    } catch (error) {
                        ui.notifications.error(error.message);
                    }
                });
                root.querySelector('[data-action="cancel"]')?.addEventListener('click', event => {
                    resolve(null);
                    event.currentTarget.closest('.app')?.querySelector('.header-button.close')?.click();
                });
            }
        }).render(true);
    });
}

async function fetchAndParse(url) {
    const response = await fetchDemiplane(url);
    const html = await response.text();
    return parseDemiplaneCharacterHtml(html, url);
}

async function fetchDemiplane(url) {
    const proxyTemplate = game.settings.get(MODULE_ID, 'corsProxy')?.trim();
    const target = proxyTemplate ? proxyTemplate.replace('{url}', encodeURIComponent(url)) : url;

    try {
        const response = await fetch(target, { credentials: 'omit' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response;
    } catch (error) {
        ui.notifications.error(`${game.i18n.localize('DEMIPLANE_DH.notifications.corsHelp')} (${error.message})`);
        throw error;
    }
}

function validateUrl(url) {
    if (!extractDemiplaneCharacterId(url)) throw new Error(game.i18n.localize('DEMIPLANE_DH.notifications.invalidUrl'));
}

function buildActorCreateData(normalized) {
    return {
        name: normalized.name,
        type: 'character',
        img: normalized.img,
        flags: buildFlags(normalized)
    };
}

function buildActorPostCreateUpdate(normalized) {
    return {
        system: buildSystemUpdate(normalized),
        flags: buildFlags(normalized)
    };
}

function buildActorUpdate(normalized) {
    return {
        name: normalized.name,
        img: normalized.img,
        system: buildSystemUpdate(normalized),
        flags: buildFlags(normalized)
    };
}

export function buildSystemUpdate(normalized) {
    return {
        biography: {
            background: summarizeForBiography(normalized),
            connections: connectionsForBiography(normalized)
        },
        levelData: {
            level: {
                current: normalized.level,
                changed: normalized.level
            }
        }
    };
}

function buildFlags(normalized) {
    return {
        [MODULE_ID]: {
            sourceUrl: normalized.sourceUrl,
            sourceId: normalized.id,
            numericId: normalized.numericId,
            demiplaneUpdated: normalized.updated,
            importedAt: new Date().toISOString(),
            selections: normalized.selections
        }
    };
}

export async function syncImportedItems(actor, normalized) {
    const oldImportedIds = actor.items
        .filter(item => item.getFlag(MODULE_ID, 'imported'))
        .map(item => item.id);
    
    // Capture state of armor and other items before deletion to preserve durability/depletion
    const itemStateMap = new Map();
    for (const itemId of oldImportedIds) {
        const item = actor.items.get(itemId);
        if (item) {
            const key = item.getFlag(MODULE_ID, 'sourceId') ?? `${item.type}:${item.name.toLowerCase()}`;
            const states = itemStateMap.get(key) ?? [];
            states.push(captureItemState(item));
            itemStateMap.set(key, states);
        }
    }
    
    const selections = {
        class: normalized.selections.class && { kind: 'class', ...normalized.selections.class },
        ancestry: normalized.selections.ancestry && { kind: 'ancestry', ...normalized.selections.ancestry },
        community: normalized.selections.community && { kind: 'community', ...normalized.selections.community },
        subclass: normalized.selections.subclass && { kind: 'subclass', ...normalized.selections.subclass },
        domains: normalized.selections.domainCards.map(x => ({ kind: 'domain', ...x })),
        equipment: normalized.selections.equipment.map(x => ({ kind: 'equipment', ...x })),
        customEquipment: normalized.selections.customEquipment.map(x => ({ kind: 'loot', ...x }))
    };

    const missing = [];
    const createdItems = [];
    const prepareSelectionBatch = async batch => {
        const itemData = [];
        for (const selection of batch.filter(Boolean)) {
            const found = await findPackItem(selection.kind, selection.name, selection.slug);
            if (found) {
                const data = found.toObject();
                delete data._id;
                // Preserve the compendium origin. Foundryborne's Daggerheart system
                // uses Item#sourceUuid to validate subclass <-> class links. A plain
                // toObject/createEmbeddedDocuments copy can lose that origin, making a
                // perfectly valid subclass look unrelated to its class.
                data._stats = foundry.utils.mergeObject(data._stats ?? {}, {
                    compendiumSource: found.uuid,
                    duplicateSource: found.uuid
                });
                data.flags = foundry.utils.mergeObject(data.flags ?? {}, itemFlags(selection));
                data.effects = (data.effects ?? []).map(effect => {
                    effect.flags = foundry.utils.mergeObject(effect.flags ?? {}, itemFlags(selection));
                    return effect;
                });
                applyInventorySelection(data, selection);
                itemData.push(data);
            } else {
                if (selection.kind !== 'loot') missing.push(`${selection.kind}: ${selection.name}`);
                itemData.push(buildPlaceholderLoot(selection));
            }
        }
        return itemData;
    };
    // Resolve all compendium documents before removing anything from the actor.
    const prepared = {};
    for (const [key, batch] of Object.entries(selections)) {
        prepared[key] = await prepareSelectionBatch(Array.isArray(batch) ? batch : [batch]);
    }
    await cleanupImportedEffects(actor, oldImportedIds);
    if (oldImportedIds.length) await actor.deleteEmbeddedDocuments('Item', oldImportedIds);

    const createSelectionBatch = async itemData => {
        if (!itemData.length) return [];
        const created = await actor.createEmbeddedDocuments('Item', itemData);
        createdItems.push(...created);
        return created;
    };

    // Foundryborne validates some item types against already-created actor state:
    // subclass and domain cards require a class to exist, and domain cards require
    // the class domains to be known. Create dependency-bearing items in waves.
    const createdClassItems = await createSelectionBatch(prepared.class);
    await applyClassDerivedStats(actor, createdClassItems[0], normalized);
    await createSelectionBatch([...prepared.ancestry, ...prepared.community]);
    await createSelectionBatch(prepared.subclass);
    await createSelectionBatch(prepared.equipment);
    await createSelectionBatch(prepared.domains);
    await createSelectionBatch(prepared.customEquipment);

    // Restore preserved item state (armor durability, etc.)
    for (const createdItem of createdItems) {
        const key = createdItem.getFlag(MODULE_ID, 'sourceId');
        const savedState = (itemStateMap.get(key) ?? itemStateMap.get(`${createdItem.type}:${createdItem.name.toLowerCase()}`))?.shift();
        if (savedState) {
            await restoreItemState(createdItem, savedState);
        }
    }

    await actor.setFlag(MODULE_ID, 'missingCompendiumMatches', missing);
    if (missing.length) ui.notifications.warn(`Demiplane: no compendium match for ${missing.join(', ')}. Imported as loot placeholders; install the matching content to enable its mechanics.`);
}

function applyInventorySelection(data, selection) {
    if (!['weapon', 'armor', 'consumable', 'loot'].includes(data.type)) return;
    data.system ??= {};
    if (selection.quantity !== undefined) data.system.quantity = selection.quantity;
    if (['weapon', 'armor'].includes(data.type) && selection.equipped !== undefined) data.system.equipped = selection.equipped;
}

function captureItemState(item) {
    // Capture item state that should be preserved across import updates
    // This is especially important for armor durability/depletion tracking
    const state = {};
    
    if (item.type === 'armor') {
        // Capture armor depletion state
        if (item.system?.depleted !== undefined) {
            state.depleted = item.system.depleted;
        }
        if (item.system?.depletion !== undefined) {
            state.depletion = foundry.utils.deepClone(item.system.depletion);
        }
        if (item.system?.armor?.current !== undefined) {
            state.armorCurrent = item.system.armor.current;
        }
    }
    
    // Capture any quantity/consumed data
    if (item.system?.quantity !== undefined) {
        state.quantity = item.system.quantity;
    }
    if (item.system?.equipped !== undefined) state.equipped = item.system.equipped;
    if (item.system?.uses !== undefined) {
        state.uses = foundry.utils.deepClone(item.system.uses);
    }
    
    return state;
}

async function restoreItemState(item, savedState) {
    // Restore captured item state to the newly created item
    const update = {};
    
    if (savedState.depleted !== undefined) {
        update['system.depleted'] = savedState.depleted;
    }
    if (savedState.depletion !== undefined) {
        update['system.depletion'] = foundry.utils.deepClone(savedState.depletion);
    }
    if (savedState.armorCurrent !== undefined && item.type === 'armor') {
        update['system.armor.current'] = Math.max(0, Math.min(savedState.armorCurrent, item.system.armor.max));
    }
    if (savedState.quantity !== undefined && item.getFlag(MODULE_ID, 'sourceQuantity') === undefined) {
        update['system.quantity'] = savedState.quantity;
    }
    if (savedState.equipped !== undefined && item.getFlag(MODULE_ID, 'sourceEquipped') === undefined) update['system.equipped'] = savedState.equipped;
    if (savedState.uses !== undefined) {
        update['system.uses'] = foundry.utils.deepClone(savedState.uses);
    }
    
    if (!foundry.utils.isEmpty(update)) {
        await item.update(update);
    }
}

async function cleanupImportedEffects(actor, oldImportedIds = []) {
    const oldItemIds = new Set(oldImportedIds);
    const effectIds = actor.effects
        .filter(effect => {
            if (effect.getFlag(MODULE_ID, 'imported')) return true;

            const itemId = String(effect.origin ?? '').match(/\.Item\.([^.]+)/)?.[1];
            if (!itemId) return false;
            if (oldItemIds.has(itemId)) return true;

            // An orphan alone is not evidence that this importer owns an effect.
            return false;
        })
        .map(effect => effect.id);

    if (effectIds.length) await actor.deleteEmbeddedDocuments('ActiveEffect', effectIds);
}

async function applyClassDerivedStats(actor, classItem, normalized) {
    const update = {};
    const suggestedTraits = normalized.traits ?? classItem?.system?.characterGuide?.suggestedTraits;
    for (const [trait, value] of Object.entries(suggestedTraits ?? {})) {
        foundry.utils.setProperty(update, `system.traits.${trait}.value`, Number(value) || 0);
    }

    // Foundryborne 2.6.4 adds class HP/evasion in prepareBaseData. Persist only
    // level-up bonuses, otherwise class base values are counted twice.
    const hpBonus = normalized.selections.levelUps.filter(x => x.slug === 'add-hp').length;
    const evasionBonus = normalized.selections.levelUps.filter(x => x.slug === 'increase-evasion').length;
    if (classItem?.type === 'class') {
        foundry.utils.setProperty(update, 'system.resources.hitPoints.max', hpBonus);
        foundry.utils.setProperty(update, 'system.evasion', evasionBonus);
    }

    if (!foundry.utils.isEmpty(update)) await actor.update(update);
}

function itemFlags(selection) {
    return {
        [MODULE_ID]: {
            imported: true,
            sourceName: selection.name,
            sourceSlug: selection.slug,
            sourceKind: selection.kind,
            sourceId: selection.sourceId,
            sourceQuantity: selection.quantity,
            sourceEquipped: selection.equipped
        }
    };
}

function buildPlaceholderLoot(selection) {
    return {
        name: selection.name,
        type: 'loot',
        system: {
            quantity: selection.quantity ?? 1,
            description: selection.description ? `<p>${escapeHtml(selection.description)}</p>` : ''
        },
        flags: itemFlags(selection)
    };
}

export async function findPackItem(kind, name, slug) {
    const kinds = kind === 'equipment' ? ['weapon', 'armor', 'consumable', 'loot'] : [kind];
    const types = kinds.map(value => value === 'domain' ? 'domainCard' : value);
    const packIds = [...new Set([
        ...kinds.flatMap(value => PACKS[value] ?? []),
        ...Array.from(game.packs).filter(pack => pack.documentName === 'Item' && pack.visible !== false).map(pack => pack.collection)
    ])];
    const names = [...new Set([name, slug].filter(Boolean).map(normalizeName))];
    for (const normalized of names) for (const packId of packIds) {
        const pack = game.packs.get(packId);
        if (!pack) continue;
        const index = await pack.getIndex({ fields: ['name', 'type'] });
        const hit = index.find(entry => types.includes(entry.type) && normalizeName(entry.name) === normalized);
        if (hit) return pack.getDocument(hit._id);
    }

    return null;
}

function normalizeName(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\bplaytest\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

globalThis.DemiplaneDaggerheartImporter = {
    importFromUrl,
    updateActorFromSavedUrl,
    editActorSourceUrl,
    parseDemiplaneCharacterHtml
};
