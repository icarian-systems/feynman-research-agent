// Coverage: src/docker/supervisor.ts helpers and src/settings/settings-tab.ts
// `dockerErrorMessage`. We test the pure functions: PATH augmentation, the
// platform → candidate-list map, and the {reason, platform} → user-message
// map. The async resolver and `check()` classifier require process-spawn
// injection that's out of proportion for v1; manual verification in
// docs/SETUP.md covers them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { augmentPath, dockerPathExtras } from "../src/docker/supervisor";
import { dockerErrorMessage } from "../src/settings/settings-tab";

// ---------------------------------------------------------------------
// dockerPathExtras
// ---------------------------------------------------------------------

test("dockerPathExtras: darwin returns Homebrew + Docker Desktop bins", () => {
  const extras = dockerPathExtras("darwin");
  assert.ok(extras.includes("/usr/local/bin"));
  assert.ok(extras.includes("/opt/homebrew/bin"));
  assert.ok(extras.includes("/Applications/Docker.app/Contents/Resources/bin"));
});

test("dockerPathExtras: linux returns nothing — desktop session PATH is usable", () => {
  const extras = dockerPathExtras("linux");
  assert.deepEqual(extras, []);
});

test("dockerPathExtras: win32 returns Program Files Docker bin", () => {
  const extras = dockerPathExtras("win32");
  assert.ok(extras.some((p) => p.includes("Docker")));
});

// ---------------------------------------------------------------------
// augmentPath
// ---------------------------------------------------------------------

test("augmentPath: prepends extras to an empty PATH", () => {
  const result = augmentPath("", ["/usr/local/bin"], ":");
  assert.equal(result, "/usr/local/bin");
});

test("augmentPath: prepends extras to an existing PATH", () => {
  const result = augmentPath("/usr/bin:/bin", ["/usr/local/bin"], ":");
  assert.equal(result, "/usr/local/bin:/usr/bin:/bin");
});

test("augmentPath: does not duplicate entries that are already present", () => {
  // The launchd-stripped PATH already has /usr/bin; augmenting with extras
  // that include /usr/bin must not add a second copy.
  const result = augmentPath("/usr/bin:/bin", ["/usr/bin", "/opt/homebrew/bin"], ":");
  assert.equal(result, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("augmentPath: idempotent across repeated calls", () => {
  const once = augmentPath("/usr/bin", ["/opt/homebrew/bin"], ":");
  const twice = augmentPath(once, ["/opt/homebrew/bin"], ":");
  assert.equal(once, twice);
});

test("augmentPath: respects a custom separator (Windows)", () => {
  const result = augmentPath("C:\\Windows\\System32", ["C:\\Program Files\\Docker\\Docker\\resources\\bin"], ";");
  assert.equal(result, "C:\\Program Files\\Docker\\Docker\\resources\\bin;C:\\Windows\\System32");
});

// ---------------------------------------------------------------------
// dockerErrorMessage
// ---------------------------------------------------------------------

test("dockerErrorMessage: macOS 'not-installed' mentions relaunch", () => {
  const msg = dockerErrorMessage("not-installed", "darwin");
  assert.match(msg, /Docker Desktop/);
  assert.match(msg, /relaunch Obsidian/i);
});

test("dockerErrorMessage: windows 'not-installed' mentions reboot", () => {
  const msg = dockerErrorMessage("not-installed", "win32");
  assert.match(msg, /reboot|sign out/i);
});

test("dockerErrorMessage: linux 'not-installed' mentions package manager", () => {
  const msg = dockerErrorMessage("not-installed", "linux");
  assert.match(msg, /package manager|apt/i);
});

test("dockerErrorMessage: macOS 'daemon-down' tells user to start Docker Desktop", () => {
  const msg = dockerErrorMessage("daemon-down", "darwin");
  assert.match(msg, /Docker Desktop is not running/);
});

test("dockerErrorMessage: linux 'daemon-down' suggests systemctl", () => {
  const msg = dockerErrorMessage("daemon-down", "linux");
  assert.match(msg, /systemctl start docker/);
});

test("dockerErrorMessage: 'permission-denied' gives usermod command", () => {
  const msg = dockerErrorMessage("permission-denied", "linux");
  assert.match(msg, /usermod -aG docker/);
});

test("dockerErrorMessage: 'sandboxed' mentions Flatpak/Snap", () => {
  const msg = dockerErrorMessage("sandboxed", "linux");
  assert.match(msg, /Flatpak|Snap/i);
});
