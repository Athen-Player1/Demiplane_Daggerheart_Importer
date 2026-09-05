export const MODULE_ID = 'demiplane-daggerheart-importer';

export function extractDemiplaneCharacterId(url) {
    const match = String(url ?? '').match(/demiplane\.com\/nexus\/daggerheart\/character-sheet\/([0-9a-f-]{36})/i);
    return match?.[1] ?? null;
}

export function parseDemiplaneCharacterHtml(html, sourceUrl = '') {
    const chunks = [...String(html).matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)];
    const parseErrors = [];

    for (const [, raw] of chunks) {
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (error) {
            parseErrors.push(error.message);
            continue;
        }

        const text = Array.isArray(payload) ? payload.find(value => typeof value === 'string' && value.includes('characterSheetContent')) : null;
        if (!text) continue;

        const colon = text.indexOf(':');
        if (colon === -1) continue;

        try {
            const flightNode = JSON.parse(text.slice(colon + 1));
            const content = findCharacterSheetContent(flightNode);
            if (content?.character) return normalizeDemiplaneCharacter(content, sourceUrl);
        } catch (error) {
            parseErrors.push(error.message);
        }
    }

    throw new Error(`Could not find Demiplane character data in the page. Parsed ${chunks.length} Next flight chunks. ${parseErrors.join('; ')}`);
}

function findCharacterSheetContent(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.characterSheetContent) return value.characterSheetContent;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findCharacterSheetContent(child);
            if (found) return found;
        }
        return null;
    }
    for (const child of Object.values(value)) {
        const found = findCharacterSheetContent(child);
        if (found) return found;
    }
    return null;
}

export function normalizeDemiplaneCharacter(content, sourceUrl = '') {
    const character = content.character;
    const engines = character?.data?.engines ?? [];
    const selections = collectSelections(engines);

    return {
        id: character?.uuid ?? content.characterId ?? extractDemiplaneCharacterId(sourceUrl),
        numericId: character?.id ?? null,
        sourceUrl,
        name: character?.name || content.characterName || 'Demiplane Character',
        img: character?.avatar_url || content.metadata?.image || 'icons/svg/mystery-man.svg',
        level: Number(character?.level || 1),
        updated: character?.updated ?? null,
        created: character?.created ?? null,
        selections,
        traits: collectTraits(engines),
        connections: engines
            .filter(engine => /^character_details_connection-\d+--answer$/.test(engine.name))
            .sort((a, b) => Number(a.name.match(/connection-(\d+)/)[1]) - Number(b.name.match(/connection-(\d+)/)[1]))
            .map(engine => String(engine.value ?? '').trim())
            .filter(Boolean),
        raw: {
            character,
            metadata: content.metadata,
            viewInformation: content.viewInformation
        }
    };
}

function collectSelections(engines) {
    const result = {
        class: null,
        subclass: null,
        ancestry: null,
        community: null,
        domainCards: [],
        equipment: [],
        levelUps: [],
        customEquipment: []
    };

    const seen = new Set();
    const addUnique = (bucket, value) => {
        if (!value?.name) return;
        const key = `${bucket}:${value.sourceId ?? `${value.name.toLowerCase()}:${value.slug ?? ''}:${value.level ?? ''}`}`;
        if (seen.has(key)) return;
        seen.add(key);
        result[bucket].push(value);
    };

    const byId = new Map(engines.map(engine => [engine.demiplaneEngineId, engine]));
    const values = new Map(engines.map(engine => [engine.name, engine.value]));
    const hands = ['primary', 'secondary', 'both'].map(hand => values.get(`character_hand_${hand}_equipped-id`));
    for (const engine of engines) {
        const name = engine.name ?? '';
        if (engine.type === 'CustomDemiplaneEngine') continue;
        // Starting selections wrap the actual inventory instance. Import the child
        // once, retaining its identity for equipped references and refresh state.
        if (name.startsWith('core/selection/equipment/') &&
            Object.keys(engine.args?.addEngineStatus ?? {}).some(id => byId.has(id))) continue;
        const parent = byId.get(engine.args?.parentEngine);
        const args = { ...(parent?.name?.startsWith('core/selection/equipment/') ? parent.args : {}), ...engine.args };
        const sourceId = engine.demiplaneEngineId;
        const selection = {
            name: args.name || args.customName || titleFromSlug(args.slug ?? name),
            slug: args.slug ?? slugFromEngineName(name),
            sourceRow: args.sourceRow ?? null,
            level: args.level ? Number(args.level) : null,
            engineName: name,
            sourceId,
            itemGroup: args.itemGroup,
            description: args.description,
            quantity: finiteQuantity(values.get(`${sourceId}-quantity`) ?? args.quantity),
            equipped: values.has(`${sourceId}-is-equipped`)
                ? [true, 1, '1'].includes(values.get(`${sourceId}-is-equipped`))
                : hands.some(value => value !== undefined) ? Boolean(sourceId && hands.includes(sourceId)) : undefined
        };

        if (name.startsWith('tabula/class/')) {
            result.class = selection;
        } else if (name.startsWith('tabula/subclass/')) {
            result.subclass = selection;
        } else if (name.startsWith('tabula/ancestry/')) {
            result.ancestry = selection;
        } else if (name.startsWith('tabula/community/')) {
            result.community = selection;
        } else if (name.startsWith('tabula/domain/')) {
            addUnique('domainCards', selection);
        } else if (name === 'core/selection/equipment/custom/index.eng' && args.customName) {
            addUnique('customEquipment', selection);
        } else if (name.startsWith('tabula/equipment/') || name.startsWith('tabula/weapon/') || name.startsWith('tabula/armor/')) {
            addUnique('equipment', selection);
        } else if (args.sourceRow?.includes('level-') || name.includes('/level-up/')) {
            addUnique('levelUps', selection);
        } else if (args.sourceRow?.includes('equipment') || args.sourceRow?.includes('inventory') || args.sourceRow?.includes('weapon') || args.sourceRow?.includes('armor') || args.itemGroup) {
            addUnique('equipment', selection);
        }
    }

    return result;
}

function finiteQuantity(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const quantity = Number(value);
    return Number.isInteger(quantity) && quantity >= 0 ? quantity : undefined;
}

function collectTraits(engines) {
    const traits = { agility: 0, strength: 0, finesse: 0, instinct: 0, presence: 0, knowledge: 0 };
    let found = false;
    for (const engine of engines) {
        const match = /^trait-selection-value-(neg-)?(\d+)(?:-second)?$/.exec(engine.name);
        if (!match || !Object.hasOwn(traits, engine.value)) continue;
        traits[engine.value] = Number(match[2]) * (match[1] ? -1 : 1);
        found = true;
    }
    return found ? traits : null;
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function connectionsForBiography(normalized) {
    return (normalized.connections ?? []).map(answer => `<p>${escapeHtml(answer).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}

function slugFromEngineName(name) {
    const match = String(name).match(/tabula\/[a-z-]+\/([^/]+)\.eng$/);
    return match?.[1] ?? null;
}

function titleFromSlug(slugOrEngine) {
    const slug = slugFromEngineName(slugOrEngine) ?? String(slugOrEngine).split('/').at(-1)?.replace(/\.eng$/, '') ?? '';
    return slug
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function summarizeForBiography(normalized) {
    const s = normalized.selections;
    const lines = [
        `<p><strong>Imported from Demiplane:</strong> <a href="${normalized.sourceUrl}">${normalized.sourceUrl}</a></p>`,
        '<ul>',
        `<li><strong>Level:</strong> ${normalized.level}</li>`,
        s.class ? `<li><strong>Class:</strong> ${s.class.name}</li>` : '',
        s.subclass ? `<li><strong>Subclass:</strong> ${s.subclass.name}</li>` : '',
        s.ancestry ? `<li><strong>Ancestry:</strong> ${s.ancestry.name}</li>` : '',
        s.community ? `<li><strong>Community:</strong> ${s.community.name}</li>` : '',
        s.domainCards.length ? `<li><strong>Domain Cards:</strong> ${s.domainCards.map(x => x.name).join(', ')}</li>` : '',
        s.levelUps.length ? `<li><strong>Level Ups:</strong> ${s.levelUps.map(x => x.name).join(', ')}</li>` : '',
        '</ul>'
    ];
    return lines.filter(Boolean).join('\n');
}
