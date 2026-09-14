import { defineConfig } from 'tsup'

/**
 * Standalone stylesheet build.
 *
 * A second pass — not a second entry in `tsup.config.ts` — because
 * `injectStyle: true` applies to every entry in a run, which turned the CSS
 * entry into a JS module that injects a <style> tag instead of emitting a real
 * `.css` asset. This pass keeps the JS entry untouched (`clean: false`) and
 * emits `dist/styles.css` for `import '@openvod/player/styles.css'`.
 */
export default defineConfig({
    entry: { styles: 'src/styles.css' },
    format: ['esm'],
    dts: false,
    clean: false,
    injectStyle: false,
    treeshake: false,
    sourcemap: false,
    minify: false,
    loader: {
        '.css': 'css',
    },
})
