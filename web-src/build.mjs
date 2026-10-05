import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const storage = process.argv[2] || 'https://z.noclip.website';
const out = process.argv[3] || 'dist-game/katamari.html';
const r = await build({
  entryPoints: ['src/KatamariGame/main.ts'], bundle: true, format: 'iife', minify: process.env.NOMIN ? false : true, write: false, target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.PUBLIC_STORAGE_URL': JSON.stringify(storage), '__COMMIT_HASH': '"game"', 'import.meta.url': '"about:blank"' },
  external: ['fs', 'path', 'url'], loader: { '.png': 'empty', '.svg': 'empty', '.wasm': 'empty', '.glsl': 'text', '.wgsl': 'text' }, platform: 'browser', alias: { 'noclip-rust-support': './src/KatamariGame/rust_shim.ts' }, logLevel: 'warning',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});
let js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/KatamariGame/index.html', 'utf8').replace('/*BUNDLE*/', () => js);
mkdirSync('dist-game', { recursive: true });
writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0) + ' KB');
