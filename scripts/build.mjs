// Bundles the extension and its QuickJS WASM into one file, so the plugin needs no npm install.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.mjs'],
  outfile: 'extensions/codemode/extension.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@github/copilot-sdk', '@github/copilot-sdk/*', '@microsoft/copilot-sdk', '@microsoft/copilot-sdk/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});
