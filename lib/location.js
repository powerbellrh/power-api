import { createClient } from '@supabase/supabase-js';

export async function checkLocationProximity(vacanteId, direccion) {
  if (!direccion?.trim()) return { found: false, reason: 'no_address_provided' };

  try {
    const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: locations, error } = await supabase
      .from('powermap')
      .select('punto_nombre, punto_descripcion, punto_coordenadas, vacante_nombre')
      .eq('vacante_id', vacanteId);

    if (error) throw error;
    if (!locations?.length) return { found: false, reason: 'job_not_in_powermap' };

    const location = locations[0];
    const { lat, lng } = location.punto_coordenadas;
    const origins     = `${lat},${lng}`;
    const apiKey      = process.env.GOOGLE_MAPS_API_KEY;
    const baseUrl     = 'https://maps.googleapis.com/maps/api/distancematrix/json';
    const params      = new URLSearchParams({ origins, destinations: direccion, units: 'metric', language: 'es', key: apiKey });

    const [walkRes, driveRes] = await Promise.all([
      fetch(`${baseUrl}?${params}&mode=walking`),
      fetch(`${baseUrl}?${params}&mode=driving`),
    ]);

    const [walkData, driveData] = await Promise.all([walkRes.json(), driveRes.json()]);

    if (walkData.status !== 'OK' || driveData.status !== 'OK')
      return { found: false, reason: 'google_api_error' };

    const walkEl  = walkData.rows[0].elements[0];
    const driveEl = driveData.rows[0].elements[0];

    if (walkEl.status !== 'OK' || driveEl.status !== 'OK')
      return { found: false, reason: 'route_not_found' };

    return {
      found:                  true,
      location_name:          location.punto_nombre        ?? 'Sin nombre',
      location_description:   location.punto_descripcion   ?? '',
      distance_text:          walkEl.distance.text,
      distance_meters:        walkEl.distance.value,
      walking_time:           walkEl.duration.text,
      driving_time:           driveEl.duration.text,
      has_multiple_locations: locations.length > 1,
      location_count:         locations.length,
    };
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'location_proximity', estado: 'error', mensaje: e.message }));
    return { found: false, reason: 'exception' };
  }
}

export function buildLocationContext(locationData, direccion) {
  if (!locationData?.found) return '';

  let ctx = '\n\n--- INFORMACIÓN DE PROXIMIDAD AL TRABAJO ---\n\n';
  ctx += `📍 Ubicación del trabajo: ${locationData.location_name}\n`;
  if (locationData.location_description)
    ctx += `Descripción: ${locationData.location_description}\n`;
  ctx += `Dirección del candidato: ${direccion}\n`;
  ctx += `📏 Distancia: ${locationData.distance_text}\n`;
  ctx += `🚶 Tiempo caminando: ${locationData.walking_time}\n`;
  ctx += `🚗 Tiempo manejando: ${locationData.driving_time}\n`;
  if (locationData.has_multiple_locations)
    ctx += `\n⚠️ NOTA: Este trabajo tiene ${locationData.location_count} ubicaciones. Distancias mostradas para la ubicación principal.\n`;
  ctx += '\nIMPORTANTE: Si el candidato menciona en sus respuestas que tiene disponibilidad para trabajar en esta ubicación o que cuenta con transporte, PRIORIZAR esa información sobre los tiempos de traslado calculados.\n';

  return ctx;
}

export function buildLocationResultSection(locationData) {
  if (!locationData?.found) return '';

  let section = '\n\n📍 Información de ubicación:\n';
  if (locationData.location_description)
    section += `${locationData.location_description}\n`;
  section += `📏 Distancia: ${locationData.distance_text}\n`;
  section += `🚶 Tiempo caminando: ${locationData.walking_time}\n`;
  section += `🚗 Tiempo manejando: ${locationData.driving_time}\n`;

  return section;
}
