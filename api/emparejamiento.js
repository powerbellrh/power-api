import { crearSupabase } from '../lib/supabase.js';
import { argumentosDeHerramienta, orChatCompletion } from '../lib/openrouter.js';
import { leerPrompt }        from '../lib/prompts.js';
import { rechazarSolicitud } from '../lib/http.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';
import { MODELOS } from '../lib/modelos.js';
import { avisar } from '../lib/registro.js';

const PROMPT_EXTRACCION_HABILIDADES = leerPrompt('emparejamiento/extraccion_habilidades');
const PROMPT_VERIFICACION_MATCH     = leerPrompt('emparejamiento/verificacion_emparejamiento');
const PROMPT_NORMALIZACION_DOMICILIO = leerPrompt('emparejamiento/normalizacion_domicilio');
const OPENROUTER_MODEL              = MODELOS.emparejamiento;

const DOMICILIO_TOOL = {
  type: 'function',
  function: {
    name: 'normalizar_domicilio',
    description: 'Infiere el estado y la ciudad/municipio de México a los que corresponde el domicilio del candidato.',
    parameters: {
      type: 'object',
      properties: {
        estado: {
          type: 'string',
          description: 'Nombre completo y estándar del estado inferido, o NO_DETERMINADO si no hay información suficiente.',
        },
        ciudad: {
          type: 'string',
          description: 'Nombre completo y estándar de la ciudad/municipio inferido, o NO_DETERMINADO si no hay información suficiente.',
        },
      },
      required: ['estado', 'ciudad'],
    },
  },
};

function construirHerramientaHabilidades(habilidadesDisponibles) {
  return {
    type: 'function',
    function: {
      name: 'extraer_habilidades',
      description: 'Extrae las habilidades laborales mencionadas en el texto del candidato, a partir de una lista cerrada de habilidades posibles.',
      parameters: {
        type: 'object',
        properties: {
          habilidades: {
            type: 'array',
            items: { type: 'string', enum: habilidadesDisponibles },
            description: 'Habilidades detectadas en el texto. Vacío si ninguna aplica.',
          },
        },
        required: ['habilidades'],
      },
    },
  };
}

const VERIFICACION_TOOL = {
  type: 'function',
  function: {
    name: 'verificar_compatibilidad',
    description: 'Determina si el candidato es apto para la vacante con base en su descripción.',
    parameters: {
      type: 'object',
      properties: {
        apto:   { type: 'boolean', description: 'true si el candidato es apto para la vacante, false si no.' },
        motivo: { type: 'string',  description: 'Explicación breve de en qué se basó la decisión.' },
      },
      required: ['apto', 'motivo'],
    },
  },
};

// ============================================================================
// HELPERS
// ============================================================================

// Las habilidades no son una lista fija: son las que existen realmente en la
// columna `habilidades` de cada vacante (texto libre separado por comas), para
// que lo que extraiga la IA del candidato coincida por texto con lo que ya
// tienen etiquetadas las vacantes.
export async function obtenerHabilidadesUnicas(supabase) {
  const { data, error } = await supabase.from('vacantes').select('habilidades').not('habilidades', 'is', null);
  if (error) throw error;

  const unicas = new Set();
  for (const { habilidades } of data ?? []) {
    for (const habilidad of habilidades.split(',')) {
      const limpia = habilidad.trim();
      if (limpia) unicas.add(limpia);
    }
  }

  return [...unicas];
}

function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export async function detectarUbicacionPorLlm(texto) {
  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    reasoning:  { effort: 'medium' },
    messages: [
      { role: 'system', content: PROMPT_NORMALIZACION_DOMICILIO },
      { role: 'user',   content: texto },
    ],
    tools:       [DOMICILIO_TOOL],
    tool_choice: { type: 'function', function: { name: 'normalizar_domicilio' } },
  }, process.env.OPENROUTER_API_KEY_EMPAREJAMIENTO);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'normalizar_domicilio');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  const argumentos = argumentosDeHerramienta(llamada);
  return {
    estado: argumentos.estado === 'NO_DETERMINADO' ? null : argumentos.estado,
    ciudad: argumentos.ciudad === 'NO_DETERMINADO' ? null : argumentos.ciudad,
  };
}

// Cuántas letras hay que cambiar, quitar o poner para pasar de un texto al otro (distancia de Levenshtein).
function distanciaDeEdicion(a, b) {
  let anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(anterior[j] + 1, actual[j - 1] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    anterior = actual;
  }
  return anterior[b.length];
}

// Los tramos de palabras seguidas de `nombre` que tienen tantas palabras como `buscada`
// ("san pedro tlaquepaque" con una palabra: "san", "pedro", "tlaquepaque").
function tramos(nombre, buscada) {
  const palabras = nombre.split(/\s+/);
  const largo = buscada.split(/\s+/).length;
  return Array.from({ length: Math.max(palabras.length - largo + 1, 0) }, (_, i) => palabras.slice(i, i + largo).join(' '));
}

export async function buscarUbicacion(supabase, estado, ciudad) {
  if (!ciudad) return null;

  let consulta = supabase.from('ubicaciones').select('id, ciudad, estado');
  if (estado) consulta = consulta.ilike('estado', estado);

  const { data: ubicaciones, error } = await consulta;
  if (error) throw error;

  const lista    = ubicaciones ?? [];
  const nombre   = ubicacion => normalizarTexto(ubicacion.ciudad);
  const buscada  = normalizarTexto(ciudad);
  const exacta   = lista.find(ubicacion => nombre(ubicacion) === buscada);
  if (exacta || !estado) return exacta ?? null;

  // Sin coincidencia exacta se busca dentro del estado, y solo vale si hay UNA candidata. El catálogo usa los nombres
  // oficiales de los municipios: el 11-oct-2026 "Ciudad Juárez", "Tlaquepaque" y "Tlanepantla" (mal escrito en
  // TeamTailor) no encontraban "Juárez", "San Pedro Tlaquepaque" ni "Tlalnepantla de Baz", y la vacante se quedaba
  // sin ubicación en cada sincronización.
  const unica = candidatas => (candidatas.length === 1 ? candidatas[0] : null);
  const corta = buscada.replace(/^(ciudad|cd\.?)\s+/, '');
  return unica(lista.filter(ubicacion => nombre(ubicacion) === corta))
    ?? unica(lista.filter(ubicacion => tramos(nombre(ubicacion), corta).includes(corta)))
    ?? (corta.length >= 6 ? unica(lista.filter(ubicacion => tramos(nombre(ubicacion), corta).some(tramo => distanciaDeEdicion(tramo, corta) <= 2))) : null);
}

export async function detectarHabilidadesPorLlm(texto, habilidadesDisponibles) {
  const listaHabilidades = habilidadesDisponibles.map(habilidad => `- ${habilidad}`).join('\n');
  const prompt = PROMPT_EXTRACCION_HABILIDADES.replace('{{habilidades}}', listaHabilidades);

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    reasoning:  { effort: 'medium' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user',   content: texto },
    ],
    tools:       [construirHerramientaHabilidades(habilidadesDisponibles)],
    tool_choice: { type: 'function', function: { name: 'extraer_habilidades' } },
  }, process.env.OPENROUTER_API_KEY_EMPAREJAMIENTO);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'extraer_habilidades');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  const argumentos = argumentosDeHerramienta(llamada);
  return argumentos.habilidades ?? [];
}

export function formatearPreguntasOpcionales(preguntasOpcional) {
  if (!Array.isArray(preguntasOpcional) || preguntasOpcional.length === 0) return '(sin información adicional)';

  return preguntasOpcional
    .map(({ pregunta, respuesta }) => `${pregunta} ${respuesta}`)
    .join('\n');
}

async function verificarCompatibilidad(candidato, descripcion) {
  const prompt = PROMPT_VERIFICACION_MATCH
    .replace('{{nombre}}',            candidato.nombre       || '(no proporcionado)')
    .replace('{{ubicacion}}',         candidato.domicilio     || '(no proporcionado)')
    .replace('{{escolaridad}}',       '(no proporcionado)')
    .replace('{{experiencia}}',       candidato.experiencia   || '(no proporcionado)')
    .replace('{{preguntas_opcional}}', formatearPreguntasOpcionales(candidato.preguntasOpcional))
    .replace('{{descripcion}}',       descripcion             || '(sin descripción)');

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    reasoning:  { effort: 'medium' },
    messages: [
      { role: 'user', content: prompt },
    ],
    tools:       [VERIFICACION_TOOL],
    tool_choice: { type: 'function', function: { name: 'verificar_compatibilidad' } },
  }, process.env.OPENROUTER_API_KEY_EMPAREJAMIENTO);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'verificar_compatibilidad');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  return argumentosDeHerramienta(llamada);
}

async function verificarRecomendaciones(candidato, vacantesCoincidentes) {
  const resultados = await Promise.all(
    vacantesCoincidentes.map(async (vacante) => {
      try {
        const { apto, motivo } = await verificarCompatibilidad(candidato, vacante.descripcion);
        avisar({ etapa: 'verificacion_match', estado: 'ok', id_team_tailor: vacante.id_team_tailor, apto: apto ?? true, motivo });
        return { vacante, apto: apto ?? true };
      } catch (error) {
        avisar({ etapa: 'verificacion_match', estado: 'error', id_team_tailor: vacante.id_team_tailor, mensaje: error.message });
        return { vacante, apto: true };
      }
    })
  );

  return resultados.filter(r => r.apto).map(r => r.vacante);
}

async function crearPostulaciones(supabase, candidatoId, vacantesVerificadas, datosCandidato) {
  const idsVacantes = [...new Set(vacantesVerificadas.map(vacante => vacante.id))];

  if (idsVacantes.length === 0) {
    avisar({ etapa: 'creacion_postulaciones', estado: 'ok', nuevas: 0 });
    return;
  }

  const filas = idsVacantes.map(idVacante => ({
    id_candidato:        candidatoId,
    id_vacante:          idVacante,
    experiencia_laboral: datosCandidato.experiencia ?? null,
    sugerida:            true,
  }));

  try {
    const { data: postulacionesCreadas, error: errorInsercion } = await supabase
      .from('postulaciones')
      .upsert(filas, { onConflict: 'id_vacante,id_candidato', ignoreDuplicates: true })
      .select('id, id_vacante');

    if (errorInsercion) throw errorInsercion;

    avisar({
      etapa:         'creacion_postulaciones',
      estado:        'ok',
      nuevas:        postulacionesCreadas.length,
      existentes:    idsVacantes.length - postulacionesCreadas.length,
      candidato_id:  candidatoId,
      postulaciones: postulacionesCreadas,
    });
  } catch (error) {
    avisar({ etapa: 'creacion_postulaciones', estado: 'error', mensaje: error.message, candidato_id: candidatoId, vacantes: idsVacantes });
  }
}

// ============================================================================
// HANDLER
// ============================================================================

async function handler(req, res) {
  if (rechazarSolicitud(req, res)) return;

  const cuerpo            = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const nombre            = cuerpo?.nombre;
  const telefono          = cuerpo?.telefono != null ? String(cuerpo.telefono) : cuerpo?.telefono;
  const edad              = cuerpo?.edad;
  const domicilio         = cuerpo?.domicilio;
  const experiencia       = cuerpo?.experiencia;
  const idVacante         = parseInt(cuerpo?.id_vacante, 10);
  const preguntasOpcional = Array.isArray(cuerpo?.preguntas_opcional) ? cuerpo.preguntas_opcional : [];

  if (!telefono || typeof telefono !== 'string') {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing telefono field' });
    return res.status(400).json({ error: 'missing telefono field' });
  }

  if (!domicilio || typeof domicilio !== 'string') {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing domicilio field' });
    return res.status(400).json({ error: 'missing domicilio field' });
  }

  if (!experiencia || typeof experiencia !== 'string') {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing experiencia field' });
    return res.status(400).json({ error: 'missing experiencia field' });
  }

  avisar({ etapa: 'inicio', chars: experiencia.length, preguntas_opcional: preguntasOpcional.length, id_vacante: Number.isInteger(idVacante) ? idVacante : null });

  const supabase = crearSupabase();

  const { data: candidato, error: errorCandidato } = await supabase
    .from('candidatos')
    .select('id')
    .eq('telefono', telefono)
    .maybeSingle();

  if (errorCandidato) {
    avisar({ etapa: 'busqueda_candidato', estado: 'error', mensaje: errorCandidato.message });
    return res.status(500).json({ error: errorCandidato.message });
  }

  if (!candidato) {
    avisar({ etapa: 'busqueda_candidato', estado: 'omitido', codigo: 404, motivo: 'candidato_no_encontrado' });
    return res.status(200).json({ id_team_tailor: [], uso_ia: false });
  }

  avisar({ etapa: 'busqueda_candidato', estado: 'ok', candidato_id: candidato.id });

  let estadoDetectado = null;
  let ciudadDetectada = null;
  let origenDomicilio = 'llm';

  try {
    ({ estado: estadoDetectado, ciudad: ciudadDetectada } = await detectarUbicacionPorLlm(domicilio));
    avisar({ etapa: 'normalizacion_domicilio', estado: 'ok', origen: origenDomicilio, con_estado: Boolean(estadoDetectado), con_ciudad: Boolean(ciudadDetectada) });
  } catch (error) {
    origenDomicilio = 'error';
    avisar({ etapa: 'normalizacion_domicilio', estado: 'error', mensaje: error.message });
  }

  let habilidadesDisponibles = [];
  try {
    habilidadesDisponibles = await obtenerHabilidadesUnicas(supabase);
  } catch (error) {
    avisar({ etapa: 'habilidades_disponibles', estado: 'error', mensaje: error.message });
    return res.status(500).json({ error: error.message });
  }

  if (habilidadesDisponibles.length === 0) {
    avisar({ etapa: 'completado', estado: 'sin_habilidades_catalogo' });
    return res.status(200).json({ id_team_tailor: [], uso_ia: false });
  }

  let habilidadesDetectadas;
  try {
    habilidadesDetectadas = await detectarHabilidadesPorLlm(experiencia, habilidadesDisponibles);
  } catch (error) {
    avisar({ etapa: 'llm', estado: 'error', mensaje: error.message });
    return res.status(500).json({ error: error.message });
  }

  avisar({ etapa: 'deteccion', estado: 'ok', habilidades: habilidadesDetectadas.length });

  const usoIa = true;

  if (habilidadesDetectadas.length === 0) {
    avisar({ etapa: 'completado', estado: 'sin_habilidades' });
    return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
  }

  try {
    const { data: postulacionesExistentes, error: errorPostulaciones } = await supabase
      .from('postulaciones')
      .select('id_vacante')
      .eq('id_candidato', candidato.id);

    if (errorPostulaciones) throw errorPostulaciones;

    const idsVacantesConPostulacion = new Set((postulacionesExistentes ?? []).map(p => p.id_vacante));

    let idsVacantesPorUbicacion = null;

    if (ciudadDetectada) {
      const ubicacion = await buscarUbicacion(supabase, estadoDetectado, ciudadDetectada);

      if (!ubicacion) {
        idsVacantesPorUbicacion = [];
      } else {
        const { data: ubicacionesSeleccionadas, error: errorUbicacionesSeleccionadas } = await supabase
          .from('ubicaciones_seleccionadas')
          .select('id_vacante')
          .eq('id_ubicacion', ubicacion.id);

        if (errorUbicacionesSeleccionadas) throw errorUbicacionesSeleccionadas;

        idsVacantesPorUbicacion = (ubicacionesSeleccionadas ?? []).map(u => u.id_vacante);
      }
    }

    let consulta = supabase
      .from('vacantes')
      .select('id, id_team_tailor, habilidades, descripcion')
      .or('tipo.is.null,tipo.not.ilike.administrativa'); // ilike para no depender de mayúsculas/minúsculas; is.null evita excluir vacantes sin tipo asignado

    if (idsVacantesPorUbicacion !== null) {
      consulta = consulta.in('id', idsVacantesPorUbicacion);
    }

    const { data: vacantes, error } = await consulta;

    if (error) throw error;

    const vacantesCoincidentes = vacantes.filter(
      vacante =>
        parseInt(vacante.id_team_tailor, 10) !== idVacante &&
        !idsVacantesConPostulacion.has(vacante.id) &&
        habilidadesDetectadas.some(habilidad => vacante.habilidades?.includes(habilidad))
    );

    avisar({ etapa: 'coincidencias_iniciales', estado: 'ok', coincidencias: vacantesCoincidentes.length });

    if (vacantesCoincidentes.length === 0) {
      avisar({ etapa: 'completado', estado: 'sin_coincidencias' });
      return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
    }

    const domicilioNormalizado = ciudadDetectada ? [ciudadDetectada, estadoDetectado].filter(Boolean).join(', ') : null;
    const datosCandidato = { nombre, domicilio: domicilioNormalizado ?? domicilio, experiencia, preguntasOpcional };
    const vacantesVerificadas = await verificarRecomendaciones(datosCandidato, vacantesCoincidentes);

    avisar({ etapa: 'verificacion_match', estado: 'ok', antes: vacantesCoincidentes.length, despues: vacantesVerificadas.length });

    const idsCoincidentes = vacantesVerificadas
      .map(vacante => parseInt(vacante.id_team_tailor, 10))
      .filter(id => Number.isInteger(id));

    const idsUnicos = [...new Set(idsCoincidentes)];

    await crearPostulaciones(supabase, candidato.id, vacantesVerificadas, datosCandidato);

    avisar({ etapa: 'completado', estado: 'ok', coincidencias: idsUnicos.length });
    return res.status(200).json({ id_team_tailor: idsUnicos, uso_ia: usoIa });

  } catch (error) {
    avisar({ etapa: 'consulta_vacantes', estado: 'error', mensaje: error.message });
    return res.status(500).json({ error: error.message });
  }
}

// Cada emparejamiento deja en `registros` cuántas vacantes encontró, si usó el modelo y lo que costó (sin el teléfono).
export default conRegistro({
  origen: 'emparejamiento', operacion: 'emparejamiento', actor: 'manychat', tipoReferencia: 'vacante',
  referencia: req => Number.parseInt(req.body?.id_vacante, 10) || null,
  resumen: ({ req, cuerpo }) => ({ vacante_id: Number.parseInt(req.body?.id_vacante, 10) || null, coincidencias: cuerpo?.id_team_tailor?.length ?? null, uso_ia: cuerpo?.uso_ia ?? null }),
}, handler);
