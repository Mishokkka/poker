import { MODULE_ID } from "../constants.js";

export const SOUND_DEFINITIONS = Object.freeze([
  { id: "holeDeal", label: "FBLPoker.SoundSettings.Sounds.holeDeal", defaultPath: `modules/${MODULE_ID}/assets/sounds/card-deal.wav`, defaultVolume: 0.62 },
  { id: "communityDeal", label: "FBLPoker.SoundSettings.Sounds.communityDeal", defaultPath: `modules/${MODULE_ID}/assets/sounds/community-deal.wav`, defaultVolume: 0.62 },
  { id: "chips", label: "FBLPoker.SoundSettings.Sounds.chips", defaultPath: `modules/${MODULE_ID}/assets/sounds/chips.wav`, defaultVolume: 0.58 },
  { id: "check", label: "FBLPoker.SoundSettings.Sounds.check", defaultPath: `modules/${MODULE_ID}/assets/sounds/check.wav`, defaultVolume: 0.5 },
  { id: "fold", label: "FBLPoker.SoundSettings.Sounds.fold", defaultPath: `modules/${MODULE_ID}/assets/sounds/fold.wav`, defaultVolume: 0.56 },
  { id: "turn", label: "FBLPoker.SoundSettings.Sounds.turn", defaultPath: `modules/${MODULE_ID}/assets/sounds/turn.wav`, defaultVolume: 0.48 },
  { id: "allIn", label: "FBLPoker.SoundSettings.Sounds.allIn", defaultPath: `modules/${MODULE_ID}/assets/sounds/all-in.wav`, defaultVolume: 0.62 },
  { id: "win", label: "FBLPoker.SoundSettings.Sounds.win", defaultPath: `modules/${MODULE_ID}/assets/sounds/win.wav`, defaultVolume: 0.58 }
]);

export function defaultSoundSettings() {
  return Object.fromEntries(SOUND_DEFINITIONS.map((definition) => [definition.id, {
    path: definition.defaultPath,
    volume: definition.defaultVolume
  }]));
}

function clampVolume(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export class PokerSoundService {
  static getSettings() {
    const defaults = defaultSoundSettings();
    let stored = {};
    try {
      stored = game?.settings?.get?.(MODULE_ID, "soundSettings") ?? {};
    } catch (_error) {
      stored = {};
    }

    const merged = {};
    for (const definition of SOUND_DEFINITIONS) {
      const value = stored?.[definition.id] ?? {};
      merged[definition.id] = {
        path: String(value.path || defaults[definition.id].path),
        volume: clampVolume(value.volume, defaults[definition.id].volume)
      };
    }
    return merged;
  }

  static async saveSettings(settings) {
    const normalized = {};
    const defaults = defaultSoundSettings();
    for (const definition of SOUND_DEFINITIONS) {
      const value = settings?.[definition.id] ?? {};
      normalized[definition.id] = {
        path: String(value.path || defaults[definition.id].path).trim(),
        volume: clampVolume(value.volume, defaults[definition.id].volume)
      };
    }
    await game.settings.set(MODULE_ID, "soundSettings", normalized);
    return normalized;
  }

  static async play(id, override = null) {
    const settings = this.getSettings();
    const definition = SOUND_DEFINITIONS.find((entry) => entry.id === id);
    if (!definition) return null;
    const configured = settings[id] ?? { path: definition.defaultPath, volume: definition.defaultVolume };
    const src = String(override?.path || configured.path || definition.defaultPath).trim();
    const volume = clampVolume(override?.volume, configured.volume);
    if (!src || volume <= 0) return null;

    try {
      const helper = globalThis.foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (helper?.play) {
        return await helper.play({ src, volume, autoplay: true, loop: false }, false);
      }

      const audio = new Audio(src);
      audio.volume = volume;
      await audio.play();
      return audio;
    } catch (error) {
      console.warn(`FBL Poker | Could not play sound ${id}`, error);
      return null;
    }
  }

  static playSequence(id, count, interval = 120, startDelay = 0) {
    const total = Math.max(0, Number.parseInt(count, 10) || 0);
    for (let index = 0; index < total; index += 1) {
      setTimeout(() => this.play(id), startDelay + (index * interval));
    }
  }
}
