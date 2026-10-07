import * as esbuild from "esbuild"

const watch = process.argv.includes("--watch")

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
