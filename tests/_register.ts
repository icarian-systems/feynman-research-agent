// Test-setup module: registers the obsidian-stub loader before any test file
// imports kick in. Wired via the `test` script (`node --import ./tests/_register.ts ...`).
//
// We can't put this logic inline in each test file because module hooks must
// be registered BEFORE the module graph that needs them is loaded — Node
// evaluates `--import` modules before user code.

import { register } from "node:module";

// `import.meta.url` is already a file:// URL when tsx loads this; passing it
// raw to `register`'s `parentURL` lets it resolve the relative loader path.
register("./_obsidian-loader.mjs", import.meta.url);
