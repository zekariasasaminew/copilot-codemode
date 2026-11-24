// Bundles each extension (and QuickJS WASM) into a single file, so the plugin needs no npm install.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@github/copilot-sdk', '@github/copilot-sdk/*', '@microsoft/copilot-sdk', '@microsoft/copilot-sdk/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/extension.mjs'], outfile: 'extensions/codemode/extension.mjs' });
await build({ ...common, entryPoints: ['src/guide.mjs'], outfile: 'extensions/codemode-guide/extension.mjs' });
