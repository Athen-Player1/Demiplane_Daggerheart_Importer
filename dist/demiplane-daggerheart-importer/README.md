# Demiplane Daggerheart Importer

A Foundry VTT addon module that imports a Demiplane Daggerheart character sheet into the [Foundryborne Daggerheart system](https://github.com/Foundryborne/daggerheart).

The module is designed for GMs who build or maintain characters in Demiplane but want playable Foundryborne actors without rebuilding every choice by hand.

## Compatibility

- **Foundry VTT:** v14, tested against v14.365
- **System:** `daggerheart` by Foundryborne, tested around v2.6.4
- **Module id:** `demiplane-daggerheart-importer`

## Install

Use this manifest URL in Foundry's **Install Module** dialog:

```text
https://raw.githubusercontent.com/Athen-Player1/Demiplane_Daggerheart_Importer/main/module.json
```

Or download the latest zip from the GitHub releases page:

```text
https://github.com/Athen-Player1/Demiplane_Daggerheart_Importer/releases
```

After installation, enable the module in your Daggerheart world.

## What it imports

The importer reads the public Demiplane character page payload and builds a Foundryborne character actor.

Currently imported/synced:

- Character name
- Character portrait/image, when available
- Level
- Class
- Subclass
- Ancestry
- Community
- Domain cards
- Equipment
- Equipped weapons and armor, including the carried/equipped distinction
- Connection answers in the actor sheet's native Connections field
- Custom equipment descriptions and explicit inventory quantities
- Custom equipment as loot placeholders
- Basic biography/import summary
- Demiplane source URL/id stored as actor flags
- Demiplane's selected starting traits, with class suggestions as a fallback
- Class-derived HP/evasion values where available
- Recognized level-up choices such as extra HP slot and increased evasion

When the importer finds a matching Foundryborne compendium item, it copies that item into the actor and preserves its compendium source metadata. This matters because Foundryborne validates relationships like:

```text
Troubadour subclass -> Bard class
```

If no matching compendium item is found, the importer creates a clearly labelled loot placeholder rather than silently dropping the selection.

## Basic use

### Import a character

1. Open your Daggerheart world in Foundry.
2. Select the token/scene controls area.
3. Click the **Import Demiplane Daggerheart Character** control.
4. Paste a Demiplane Daggerheart character sheet URL, for example:

```text
https://app.demiplane.com/nexus/daggerheart/character-sheet/<character-uuid>
```

5. Submit the dialog.

The module creates a new Foundryborne `character` actor and stores the Demiplane URL on that actor for future updates.

### Update an existing imported actor

Imported actors can be refreshed from their saved Demiplane URL.

Depending on Foundry/Foundryborne UI behaviour, use one of these paths:

- Open the actor sheet and click **Update from Demiplane** if the button is visible.
- Use the console API below as a fallback.

If an actor does not have a saved source URL, the module prompts for one before updating.

## Console API

Open the browser dev console in Foundry and run:

```js
await DemiplaneDaggerheartImporter.importFromUrl(
  'https://app.demiplane.com/nexus/daggerheart/character-sheet/<character-uuid>'
)
```

To update an actor that already has a saved source URL:

```js
await DemiplaneDaggerheartImporter.updateActorFromSavedUrl(actor)
```

Example: update the currently opened actor sheet:

```js
await DemiplaneDaggerheartImporter.updateActorFromSavedUrl(ui.windows[Object.keys(ui.windows)[0]].actor)
```

Example: update by actor name:

```js
const actor = game.actors.getName('Your Character Name')
await DemiplaneDaggerheartImporter.updateActorFromSavedUrl(actor)
```

## CORS proxy setting

Foundry modules run in the browser. If Demiplane does not allow your Foundry origin to fetch the character page directly, the browser may block the request with CORS.

The module includes a world setting:

```text
CORS proxy URL template
```

The value should be a trusted proxy URL containing `{url}`. Example for a local proxy you control:

```text
http://127.0.0.1:8787/?url={url}
```

Blank means:

```text
Fetch Demiplane directly
```

Only use a proxy you control or trust. Character pages may contain private character details.

## Current limitations

This is still an early importer, not a perfect Demiplane clone spell.

Known limitations:

- Demiplane does not expose every final computed sheet value in an obvious stable public format.
- Some stats are derived from Foundryborne class data and recognized choices rather than copied from a final Demiplane stat block.
- Level-up support is partial.
- Item matching is name-based against Foundryborne compendium packs.
- Matching also searches accessible installed Item packs and the source slug. Some content (including Casting Dagger and Mage Robes) is absent from the public 2.6.4 packs; install matching content for working mechanics. Missing matches produce a warning and loot placeholders.
- Thresholds use Foundryborne's equipped armor, level, and item effects. The importer does not copy final computed thresholds from Demiplane. Correct compendium content is required, including spellcast bonuses such as Mage Robes' Enchanted feature.
- Demiplane connection answers replace the native Connections field on refresh, including clearing removed answers.
- Explicit source quantities/equipped states take precedence on refresh; unavailable values preserve local state. Armor marks are preserved without overwriting the compendium's armor score or thresholds.
- Homebrew or renamed Demiplane content may become placeholder loot if no compendium match is found.
- Actor update replaces previously imported items flagged by this module, but does not intentionally delete user-created/non-imported items.
- UI button placement may vary as Foundryborne updates its ApplicationV2 sheets.

## Troubleshooting

### Import button does not appear

- Confirm the module is enabled in the world.
- Confirm the active system is Foundryborne `daggerheart`.
- Hard refresh the browser:

```text
Ctrl+F5
```

- Check the browser console for:

```text
demiplane-daggerheart-importer | Ready
```

### Update button does not appear

Foundryborne uses Foundry's ApplicationV2 sheet framework, and the sheet markup may change between releases.

Try:

1. Hard refresh the browser.
2. Close and reopen the actor sheet.
3. Use the console API fallback.

The console should log when a sheet button is injected:

```text
demiplane-daggerheart-importer | Added update button to <actor name>
```

### Subclass fails to import

If Foundry shows a warning like:

```text
This subclass does not belong to your selected class
```

make sure you are on module `0.1.3` or later. Those versions preserve Foundryborne compendium source UUIDs so subclass/class validation works.

For old test actors created before that fix, delete and re-import the actor fresh.

### Domain cards fail to import

Domain cards require the class to exist first and to expose matching domains. Module `0.1.2` and later creates items in dependency order:

1. Class
2. Class-derived stats
3. Ancestry/community
4. Subclass
5. Equipment
6. Domain cards
7. Custom loot

If domain cards are still missing, check the actor flag:

```js
actor.getFlag('demiplane-daggerheart-importer', 'missingCompendiumMatches')
```

### CORS or fetch errors

If the browser blocks Demiplane requests, configure the CORS proxy setting as described above.

## Development

The Node test suite exercises production parser and sync functions with mocked Foundry documents. Its fixture preserves the observed engine structure while removing character identity and replacing connection answers. No dependencies are required.

An optional upstream integration test runs the actual 2.6.4 `prepareBaseData` method with mocked base class/settings. Set `DH_SOURCE_DIR` to a directory containing `dh264-module-data-actor-character.mjs` (from the 2.6.4 tag), `armor_Mage_Robes_rWDk8ovwnBrBwWRR.json`, and `weapon_Casting_Dagger_eCEf5ysz8Eq0ma9u.json` (from the upstream main branch). This checks base thresholds and retained armor effects; it does not replace testing a running Foundry world.

Useful local commands:

```bash
npm test
npm run zip
node --check scripts/module.mjs
```

Build artifacts are written to:

```text
dist/
```

The release zip contains the module folder:

```text
demiplane-daggerheart-importer/
```

## Project status

This module is experimental and built around observed Demiplane/Foundryborne payloads. Expect iterative fixes as Demiplane, Foundry VTT, and Foundryborne Daggerheart change.

Please include browser console errors and the affected Demiplane URL when reporting issues.
