/**
 * Vercel Hobby/Pro: als "Output Directory" op public staat, moet die map na build bestaan.
 * Kopieert root *.html naar public/ (api/ blijft apart als serverless functions).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

fs.mkdirSync(pub, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (name.endsWith('.html')) {
    fs.copyFileSync(path.join(root, name), path.join(pub, name));
  }
}
console.log('[vercel-build-public] copied *.html → public/');
