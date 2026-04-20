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
const buildVersion =
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
  String(Date.now());

fs.mkdirSync(pub, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (name.endsWith('.html')) {
    const src = path.join(root, name);
    const dst = path.join(pub, name);
    let html = fs.readFileSync(src, 'utf8');
    html = html.replace(
      /(src|href)="\/(app\/[^"?]+|styles\/[^"?]+|manifest\.webmanifest|icons\/[^"?]+)(\?[^"]*)?"/g,
      (_m, attr, assetPath, existingQuery) => {
        if (existingQuery && /(?:^|&)v=/.test(existingQuery.replace(/^\?/, ''))) {
          return `${attr}="/${assetPath}${existingQuery}"`;
        }
        const qs = existingQuery ? `${existingQuery}&v=${encodeURIComponent(buildVersion)}` : `?v=${encodeURIComponent(buildVersion)}`;
        return `${attr}="/${assetPath}${qs}"`;
      }
    );
    if (!/name="hk-app-version"/.test(html)) {
      html = html.replace(
        /<title>([^<]*)<\/title>/,
        `<title>$1</title>\n<meta name="hk-app-version" content="${buildVersion}">`
      );
    }
    fs.writeFileSync(dst, html, 'utf8');
  }
}
console.log('[vercel-build-public] copied *.html → public/ with build version', buildVersion);
