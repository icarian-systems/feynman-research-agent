// Tree over Feynman/outputs|papers|notes inside the vault.
// See docs/ARCHITECTURE.md §8.3 — pure vault read, no server calls.
//
// Stub: shape only.

import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_FEYNMAN_ARTIFACTS = "feynman-artifacts";

export class FeynmanArtifactView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_FEYNMAN_ARTIFACTS;
  }

  override getDisplayText(): string {
    return "Feynman artifacts";
  }

  override getIcon(): string {
    return "folder-tree";
  }

  override async onOpen(): Promise<void> {
    // TODO: enumerate <vault>/Feynman/{outputs,papers,notes} and render a tree.
  }

  override async onClose(): Promise<void> {
    // TODO: detach vault change listeners.
  }
}
