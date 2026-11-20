import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// base './' so the build works on any static host (unv.run, GitHub Pages, IPFS)
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
