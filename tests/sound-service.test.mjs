import assert from "node:assert/strict";

let stored = {};
globalThis.game = {
  settings: {
    get: () => stored,
    set: async (_module, _key, value) => { stored = value; }
  }
};

const { SOUND_DEFINITIONS, defaultSoundSettings, PokerSoundService } = await import("../scripts/audio/sound-service.js");
const defaults = defaultSoundSettings();
assert.equal(Object.keys(defaults).length, SOUND_DEFINITIONS.length);
assert.ok(defaults.holeDeal.path.endsWith("card-deal.wav"));

await PokerSoundService.saveSettings({ holeDeal: { path: "custom/deal.ogg", volume: 2 } });
const settings = PokerSoundService.getSettings();
assert.equal(settings.holeDeal.path, "custom/deal.ogg");
assert.equal(settings.holeDeal.volume, 1);
assert.ok(settings.win.path.endsWith("win.wav"));

console.log("Sound settings test passed.");
