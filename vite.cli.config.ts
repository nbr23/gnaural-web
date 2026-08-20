import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'src/cli/render.ts',
    outDir: 'dist-cli',
    target: 'node24',
    minify: false,
    emptyOutDir: true,
  },
})
