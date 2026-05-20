// Runtime stub for the `obsidian` module so test files that transitively
// import obsidian-bound code can load under Node's test runner. None of the
// classes here implement real behavior — they only have to exist so
// `import { Component, ItemView, ... } from "obsidian"` resolves. Tests that
// need realistic behavior pass purpose-built stubs at the call site (e.g.
// fs-bridge.test.ts builds a fake `App`).

class Stub {}

export class Component extends Stub {}
export class Plugin extends Stub {}
export class ItemView extends Stub {}
export class Modal extends Stub {}
export class WorkspaceLeaf extends Stub {}
export class TFile extends Stub {}
export class TFolder extends Stub {}
export class TAbstractFile extends Stub {}
export class MarkdownRenderer extends Stub {
  static render() {
    return Promise.resolve();
  }
}
export class Notice extends Stub {}
export class App extends Stub {}
export class Setting extends Stub {}
export class PluginSettingTab extends Stub {}
export class FuzzySuggestModal extends Stub {}
export class SuggestModal extends Stub {}
export class MarkdownView extends Stub {}

// requestUrl is referenced by waitlist-modal — provide a noop stand-in.
export function requestUrl() {
  return Promise.resolve({ status: 200, text: "", json: {} });
}

// Re-export anything else as an undefined-but-accessible namespace so
// `import * as o from "obsidian"` doesn't blow up if a file pulls in a symbol
// that the stub hasn't named.
export default {};
