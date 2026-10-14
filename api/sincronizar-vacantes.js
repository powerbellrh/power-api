import { crearSupabase } from '../lib/supabase.js';
import { rechazarCron } from '../lib/http.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';
import { sincronizarVacantes } from '../lib/sincronizar_vacantes.js';
import { limpiarImagenesViejas } from '../lib/limpieza_de_imagenes.js';
import { avisar } from '../lib/registro.js';

// Cron cada hora (vercel.json): actualiza en Supabase las vacantes que cambiaron en TeamTailor y borra las imágenes
// generadas de más de 3 días.
async function handler(req, res) {
  if (rechazarCron(req, res)) return;

  const supabase = crearSupabase();
  const log = (etapa, datos = {}) => avisar({ etapa: `sincronizar_vacantes_${etapa}`, ...datos });

  try {
    const resumen = await sincronizarVacantes(supabase, { log });
    // De paso se borran las imágenes generadas de más de 3 días (lib/limpieza_de_imagenes.js); si falla, la
    // sincronización ya quedó y se intenta otra vez en la siguiente hora.
    let limpieza;
    try {
      limpieza = await limpiarImagenesViejas(supabase);
    } catch (error) {
      log('limpieza_de_imagenes', { estado: 'error', mensaje: error.message });
      limpieza = { limpieza_fallida: true };
    }
    log('terminado', { ...resumen, ...limpieza });
    return res.status(200).json({ status: 'success', ...resumen, ...limpieza });
  } catch (error) {
    log('error', { mensaje: error.message });
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// Cada corrida (una por hora) deja en `registros` las cifras de su resumen.
export default conRegistro({
  origen: 'sincronizar_vacantes', operacion: 'sincronizacion', actor: 'cron',
  resumen: ({ cuerpo }) => { const { status: _estado, message: _mensaje, ...cifras } = cuerpo ?? {}; return cifras; },
}, handler);
