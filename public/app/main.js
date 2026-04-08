import { button, card } from './components.js';

const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <div class="hk-container hk-grid">
      <header class="hk-card">
        <h1 style="margin:0 0 8px 0">Hetekraan App Shell</h1>
        <p class="hk-text-muted" style="margin:0">
          Nieuwe modulaire frontend-shell met globale stijlen en herbruikbare component-primitives.
          Deze pagina draait achter feature-flag/route en vervangt legacy niet direct.
        </p>
      </header>
      <div class="hk-grid hk-grid-2">
        ${card({
          title: 'Component primitives',
          body: 'Button, Card, Field en design tokens staan centraal in public/styles/global.css',
        })}
        ${card({
          title: 'Migratiestrategie',
          body: 'Strangler pattern: eerst nieuwe schermen hier, daarna legacy index.html routes gefaseerd uitfaseren.',
        })}
      </div>
      <div class="hk-card" style="display:flex;gap:8px;align-items:center">
        ${button({ text: 'Primary action', variant: 'primary' })}
        ${button({ text: 'Danger action', variant: 'danger' })}
      </div>
    </div>
  `;
}
