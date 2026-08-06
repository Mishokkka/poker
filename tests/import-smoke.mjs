globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: { confirm: async () => true }
    }
  },
  utils: {}
};
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.CONST = { KEYBINDING_PRECEDENCE: { NORMAL: 0 }, DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
await import("../scripts/main.js");
console.log("Module import smoke test passed.");
