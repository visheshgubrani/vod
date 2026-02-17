import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    external: ['react', 'react-dom'],
    noExternal: ['@vidstack/react'],
    injectStyle: true,
    treeshake: true,
    sourcemap: true,
    minify: false,
    esbuildOptions(options) {
        options.jsx = 'automatic'
        // Prevent esbuild from treeshaking Vidstack CSS imports
        // (Vidstack sets sideEffects: false which strips CSS)
        options.treeShaking = true
    },
    // Ensure CSS side-effect imports are preserved
    loader: {
        '.css': 'css',
    },
})
