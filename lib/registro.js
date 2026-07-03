import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function registrar(endpoint, status, mensaje = null) {
  try {
    await supabase.from('logs').insert({ endpoint, status, mensaje });
  } catch {
    // logging nunca debe interrumpir el flujo principal
  }
}
