import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IMPORTANT: this must match your actual GitHub repo name.
// GitHub Pages serves project sites at https://<username>.github.io/<repo-name>/
// so Vite needs to know that sub-path at build time, or assets will 404.
// Repo: Digit-scan (owner: poptraders)
export default defineConfig({
  plugins: [react()],
  base: '/Digit-scan/',
});
