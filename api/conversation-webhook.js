export default async function handler(req, res) {
  // CORS (handig voor testen vanaf browser/tools)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Quick healthcheck
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: '/api/conversation-webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // Optional verification (recommended): set WEBHOOK_SECRET in Vercel env vars
  const configuredSecret = process.env.WEBHOOK_SECRET;
  if (configuredSecret) {
    const providedSecret = req.headers['x-webhook-secret'];
    if (!providedSecret || providedSecret !== configuredSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  // Vercel parses JSON automatically when Content-Type: application/json
  const body = req.body;

  // Log the incoming webhook so it shows up in Vercel logs
  console.log('[conversation-webhook] received', {
    method: req.method,
    url: req.url,
    contentType: req.headers['content-type'],
    userAgent: req.headers['user-agent'],
    ip:
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress,
    body,
  });

  return res.status(200).json({ ok: true, received: true });
}

