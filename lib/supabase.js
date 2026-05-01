import { createClient } from '@supabase/supabase-js';

let _cached = null;

export function getSupabaseAdminClient() {
  if (_cached) return _cached;

  const url = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !serviceRoleKey) {
    _cached = {
      enabled: false,
      client: null,
      reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing',
    };
    return _cached;
  }

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

