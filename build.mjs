// Build the client bundle in the dsh ModuleLoader handoff format:
//   window.__ModuleLoader__.load({ id: "<name>", factory: (require) => { ... return module.exports; } });
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'lib/client.js',
  jsx: 'automatic',
  // External packages are resolved through the factory's `require` at runtime,
  // mirroring how the official client modules load third-party bundles.
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
  },
  footer: {
    js: `return module.exports; } });`
  },
  sourcemap: true,
  logLevel: 'info'
})
