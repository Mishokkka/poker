import { SOUND_DEFINITIONS, defaultSoundSettings, PokerSoundService } from "../audio/sound-service.js";
import { notifyError } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function filePickerClass() {
  return globalThis.FilePicker
    ?? globalThis.foundry?.applications?.apps?.FilePicker?.implementation
    ?? globalThis.foundry?.applications?.api?.FilePicker;
}

export class PokerSoundSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fbl-poker-sound-settings",
    classes: ["fbl-poker", "fbl-poker-sound-settings"],
    tag: "form",
    position: { width: 680, height: 610 },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.SoundSettings.Title",
      icon: "fa-solid fa-volume-high",
      resizable: true
    },
    actions: {
      browseSound: PokerSoundSettingsApp.browseSound,
      previewSound: PokerSoundSettingsApp.previewSound,
      resetDefaults: PokerSoundSettingsApp.resetDefaults,
      saveSounds: PokerSoundSettingsApp.saveSounds
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/sound-settings.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const settings = PokerSoundService.getSettings();
    context.sounds = SOUND_DEFINITIONS.map((definition) => ({
      ...definition,
      labelText: game.i18n.localize(definition.label),
      path: settings[definition.id].path,
      volume: settings[definition.id].volume,
      volumePercent: Math.round(settings[definition.id].volume * 100)
    }));
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const slider of this.element?.querySelectorAll?.('[data-sound-volume]') ?? []) {
      const output = this.element.querySelector(`[data-volume-output="${slider.dataset.soundVolume}"]`);
      const update = () => {
        if (output) output.textContent = `${Math.round(Number(slider.value) * 100)}%`;
      };
      slider.addEventListener("input", update);
      update();
    }
  }

  #formSettings() {
    const form = this.form ?? this.element;
    const settings = {};
    for (const definition of SOUND_DEFINITIONS) {
      const path = form.querySelector(`[name="${definition.id}.path"]`)?.value ?? definition.defaultPath;
      const volume = form.querySelector(`[name="${definition.id}.volume"]`)?.value ?? definition.defaultVolume;
      settings[definition.id] = { path, volume: Number(volume) };
    }
    return settings;
  }

  static async browseSound(_event, target) {
    try {
      const soundId = target.dataset.soundId;
      const input = this.element.querySelector(`[name="${soundId}.path"]`);
      if (!input) return;
      const Picker = filePickerClass();
      if (!Picker) throw new Error("FBLPoker.Errors.FilePickerUnavailable");
      const picker = new Picker({
        type: "audio",
        current: input.value,
        callback: (path) => { input.value = path; }
      });
      if (typeof picker.browse === "function") await picker.browse();
      else if (typeof picker.render === "function") picker.render(true);
    } catch (error) {
      notifyError(error);
    }
  }

  static async previewSound(_event, target) {
    const soundId = target.dataset.soundId;
    const settings = this.#formSettings();
    await PokerSoundService.play(soundId, settings[soundId]);
  }

  static async resetDefaults() {
    const defaults = defaultSoundSettings();
    const form = this.form ?? this.element;
    for (const definition of SOUND_DEFINITIONS) {
      const path = form.querySelector(`[name="${definition.id}.path"]`);
      const volume = form.querySelector(`[name="${definition.id}.volume"]`);
      if (path) path.value = defaults[definition.id].path;
      if (volume) {
        volume.value = defaults[definition.id].volume;
        volume.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  static async saveSounds(event) {
    event.preventDefault();
    try {
      await PokerSoundService.saveSettings(this.#formSettings());
      ui.notifications?.info(game.i18n.localize("FBLPoker.SoundSettings.Saved"));
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}
