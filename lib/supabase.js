import { createClient } from '@supabase/supabase-js';

let _cached = null;

function readSupabaseKeyRole(rawKey) {
  try {
    const token = String(rawKey || '').trim();
    const parts = token.split('.');
    if (parts.length < 2) return { role: null, issuer: false };
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return {
      role: payload?.role || null,
      issuer: !!payload?.iss,
    };
  } catch {
    return { role: null, issuer: false };
  }
}

export function getSupabaseAdminClient() {
  if (_cached) return _cached;

  const url = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !serviceRoleKey) {
    console.log('SUPABASE_DISABLED', {
      hasUrl: !!process.env.SUPABASE_URL,
      hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    _cached = {
      enabled: false,
      client: null,
      reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing',
    };
    return _cached;
  }

  const keyCheck = readSupabaseKeyRole(serviceRoleKey);
  console.log('SUPABASE_KEY_ROLE_CHECK', {
    role: keyCheck.role,
    issuer: keyCheck.issuer,
  });

  const client = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  _cached = {
    enabled: true,
    client,
    reason: null,
  };
  return _cached;
}

