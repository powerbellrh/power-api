import { createClient } from '@supabase/supabase-js';

const EXPIRACION_SEGUNDOS = 24 * 60 * 60; // 24 horas

function clientePowerId() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function subirYFirmar(bucket, ruta, buffer) {
  const supabase = clientePowerId();

  const { error: errorSubida } = await supabase.storage
    .from(bucket)
    .upload(ruta, buffer, { contentType: 'image/png', upsert: false });
  if (errorSubida) throw new Error(`Supabase storage upload failed (${bucket}): ${errorSubida.message}`);

  const { data, error: errorFirma } = await supabase.storage
    .from(bucket)
    .createSignedUrl(ruta, EXPIRACION_SEGUNDOS);
  if (errorFirma) throw new Error(`Supabase storage signed url failed (${bucket}): ${errorFirma.message}`);

  return data.signedUrl;
}

export { subirYFirmar };
