/**
 * Build config: the host library (lib/index.js, lib/agent-tool.js — ESM,
 * dsh-family peers external, resolved at runtime from the running dsh
 * installation) and the browser bundle (lib/client.js — one CJS closure
 * factory registered through window.__ModuleLoader__.load, with CSS Modules
 * compiled inline and module-table externals preserved).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = 'dsh-prime-orchestrator'

/**
 * Externals resolved from the browser loader module table: the shell's
 * platform modules (react, cordis, ui-primitives) plus the snapshot-store
 * engine under dsh-client-runtime/client, an immediately-tier row whose
 * factory is registered before any dependent bundle materializes.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css): the suffix dodges its `.css` guard, and the
 * custom loader below compiles the stylesheet with lightningcss cssModules.
 */
const CSS_VIRTUAL_PREFIX = '\0prime-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Resolve one relative import against its importing file. */
function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'agent-tool': 'src/agent-tool.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outputOptions: { entryFileNames: '[name].js' },
  },
  {
    entry: { client: 'client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: ['es2022'],
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead — a require() the table cannot
    // answer is a guaranteed runtime throw, so the rule is the table list.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [
      {
        name: 'prime-css-modules-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: 'prime-[hash]_[local]' },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
          return [
            `const css = ${JSON.stringify(code.toString())};`,
            `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
            'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        },
      },
      {
        // Bundle purity gate: every surviving @deepseek-ai value import must
        // be a module-table entry (external above); anything else is a build
        // error rather than a silently inlined duplicate runtime instance.
        name: 'prime-client-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a module-table entry — cross-plugin value imports are forbidden; `
            + 'collaborate through cordis services (type-only imports are erased and never reach this gate)',
          )
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
