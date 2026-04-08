export function button({ text, variant = 'default', onClick = '' }) {
  const klass =
    variant === 'primary' ? 'hk-btn hk-btn-primary' : variant === 'danger' ? 'hk-btn hk-btn-danger' : 'hk-btn';
  return `<button class="${klass}" ${onClick ? `onclick="${onClick}"` : ''}>${escapeHtml(text)}</button>`;
}

export function card({ title, body = '' }) {
  return `
    <section class="hk-card">
      <h3 style="margin:0 0 8px 0">${escapeHtml(title)}</h3>
      <div class="hk-text-muted">${body}</div>
    </section>
  `;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
