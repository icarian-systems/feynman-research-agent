import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Standard externals for Obsidian plugins: Obsidian itself, Electron, CodeMirror 6,
// the legacy CM5 namespace, and every Node builtin (the bundle runs in Electron-renderer
// + main world, so Node builtins are resolvable at runtime).
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const baseOptions = {
  entryPoints: ["main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  external,
};

if (watch) {
  const ctx = await esbuild.context(baseOptions);
  await ctx.watch();
  // eslint-disable-next-line no-console
  console.log("[feynman] esbuild watching…");
} else {
  await esbuild.build(baseOptions);
}
