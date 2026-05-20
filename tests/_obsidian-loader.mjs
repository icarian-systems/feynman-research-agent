// Node module-customization hook that intercepts `import ... from "obsidian"`
// and resolves it to a local stub. The Obsidian API package shipped on npm is
// types-only (`main: ""`), so importing it at runtime under Node — which is
// what `node --test` does — would fail with ERR_MODULE_NOT_FOUND. Tests don't
// exercise any of the live Obsidian classes; they only need the symbols
// imported by the files under test (FsBridgeHandler, FeynmanChatView, etc.)
// to resolve so the module graphs load.
//
// Wired by `tests/_register.ts` via `module.register(...)`.

const STUB_URL = new URL("./_obsidian-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "obsidian") {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
