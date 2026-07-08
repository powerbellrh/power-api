import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 25; // límite de orígenes por request de Google Distance Matrix

async function calcularDistancias(origenes, direccion) {
  const claveApi   = process.env.GOOGLE_MAPS_API_KEY;
  const urlBase    = 'https://maps.googleapis.com/maps/api/distancematrix/json';
  const parametros = new URLSearchParams({ origins: origenes, destinations: direccion, units: 'metric', language: 'es', key: claveApi });

  const [respCaminando, respManejando] = await Promise.all([
    fetch(`${urlBase}?${parametros}&mode=walking`),
    fetch(`${urlBase}?${parametros}&mode=driving`),
  ]);

  const [datosCaminando, datosManejando] = await Promise.all([respCaminando.json(), respManejando.json()]);
  if (datosCaminando.status !== 'OK' || datosManejando.status !== 'OK') return null;

  return { datosCaminando, datosManejando };
}

export async function verificarProximidadUbicacion(vacanteId, direccion) {
  if (!direccion?.trim()) return { encontrado: false, razon: 'sin_direccion_proporcionada' };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: ubicaciones, error } = await supabase
      .from('powermap')
      .select('punto_nombre, punto_descripcion, punto_coordenadas, vacante_nombre')
      .eq('vacante_id', vacanteId);

    if (error) throw error;
    if (!ubicaciones?.length) return { encontrado: false, razon: 'vacante_no_en_powermap' };

    let mejor = null;

    for (let i = 0; i < ubicaciones.length; i += BATCH_SIZE) {
      const lote     = ubicaciones.slice(i, i + BATCH_SIZE);
      const origenes = lote.map(u => `${u.punto_coordenadas.lat},${u.punto_coordenadas.lng}`).join('|');

      const datos = await calcularDistancias(origenes, direccion);
      if (!datos) continue;

      datos.datosCaminando.rows.forEach((fila, idx) => {
        const elCaminando = fila.elements[0];
        const elManejando = datos.datosManejando.rows[idx].elements[0];
        if (elCaminando.status !== 'OK' || elManejando.status !== 'OK') return;

        if (!mejor || elCaminando.distance.value < mejor.distancia_metros) {
          mejor = {
            ubicacion:        lote[idx],
            distancia_metros: elCaminando.distance.value,
            distancia_texto:  elCaminando.distance.text,
            tiempo_caminando: elCaminando.duration.text,
            tiempo_manejando: elManejando.duration.text,
          };
        }
      });
    }

    if (!mejor) return { encontrado: false, razon: 'ruta_no_encontrada' };

    return {
      encontrado:                  true,
      nombre_ubicacion:            mejor.ubicacion.punto_nombre      ?? 'Sin nombre',
      descripcion_ubicacion:       mejor.ubicacion.punto_descripcion ?? '',
      distancia_texto:             mejor.distancia_texto,
      distancia_metros:            mejor.distancia_metros,
      tiempo_caminando:            mejor.tiempo_caminando,
      tiempo_manejando:            mejor.tiempo_manejando,
      tiene_multiples_ubicaciones: ubicaciones.length > 1,
      cantidad_ubicaciones:        ubicaciones.length,
    };
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'proximidad_ubicacion', estado: 'error', mensaje: e.message }));
    return { encontrado: false, razon: 'excepcion' };
  }
}

export function construirContextoUbicacion(datosUbicacion, direccion) {
  if (!datosUbicacion?.encontrado) return '';

  let ctx = '\n\n--- INFORMACIÓN DE PROXIMIDAD AL TRABAJO ---\n\n';
  ctx += `📍 Ubicación del trabajo: ${datosUbicacion.nombre_ubicacion}\n`;
  if (datosUbicacion.descripcion_ubicacion)
    ctx += `Descripción: ${datosUbicacion.descripcion_ubicacion}\n`;
  ctx += `Dirección del candidato: ${direccion}\n`;
  ctx += `📏 Distancia: ${datosUbicacion.distancia_texto}\n`;
  ctx += `🚶 Tiempo caminando: ${datosUbicacion.tiempo_caminando}\n`;
  ctx += `🚗 Tiempo manejando: ${datosUbicacion.tiempo_manejando}\n`;
  if (datosUbicacion.tiene_multiples_ubicaciones)
    ctx += `\n⚠️ NOTA: Este trabajo tiene ${datosUbicacion.cantidad_ubicaciones} ubicaciones. Distancias mostradas para la ubicación principal.\n`;
  ctx += '\nIMPORTANTE: Si el candidato menciona en sus respuestas que tiene disponibilidad para trabajar en esta ubicación o que cuenta con transporte, PRIORIZAR esa información sobre los tiempos de traslado calculados.\n';

  return ctx;
}

export function construirSeccionResultadoUbicacion(datosUbicacion) {
  if (!datosUbicacion?.encontrado) return '';

  let seccion = '\n\n📍 Información de ubicación:\n';
  if (datosUbicacion.descripcion_ubicacion)
    seccion += `${datosUbicacion.descripcion_ubicacion}\n`;
  seccion += `📏 Distancia: ${datosUbicacion.distancia_texto}\n`;
  seccion += `🚶 Tiempo caminando: ${datosUbicacion.tiempo_caminando}\n`;
  seccion += `🚗 Tiempo manejando: ${datosUbicacion.tiempo_manejando}\n`;

  return seccion;
}
