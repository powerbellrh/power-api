import { readFileSync }      from 'fs';
import { fileURLToPath }     from 'url';
import { dirname, join }     from 'path';
import { createClient }      from '@supabase/supabase-js';
import { orChatCompletion }  from '../lib/openrouter.js';
import { HABILIDADES_REGEX } from '../lib/habilidades_dict.js';

const __dirname                     = dirname(fileURLToPath(import.meta.url));
const PROMPT_EXTRACCION_HABILIDADES = readFileSync(join(__dirname, '../prompts/extraccion_habilidades.txt'), 'utf-8');
const PROMPT_VERIFICACION_MATCH     = readFileSync(join(__dirname, '../prompts/verificacion_emparejamiento.txt'), 'utf-8');
const OPENROUTER_MODEL              = 'deepseek/deepseek-v4-flash-0731';

const HABILIDADES_TOOL = {
  type: 'function',
  function: {
    name: 'extraer_habilidades',
    description: 'Extrae las habilidades laborales mencionadas en el texto del candidato, a partir de una lista cerrada de habilidades posibles.',
    parameters: {
      type: 'object',
      properties: {
        habilidades: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(HABILIDADES_REGEX) },
          description: 'Habilidades detectadas en el texto. Vacío si ninguna aplica.',
        },
      },
      required: ['habilidades'],
    },
  },
};

// ============================================================================
// HELPERS
// ============================================================================

function detectarHabilidadesPorRegex(texto) {
  return Object.entries(HABILIDADES_REGEX)
    .filter(([, regex]) => regex.test(texto))
    .map(([habilidad]) => habilidad);
}

async function detectarHabilidadesPorLlm(texto) {
  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    reasoning:  { enabled: false },
    messages: [
      { role: 'system', content: PROMPT_EXTRACCION_HABILIDADES },
      { role: 'user',   content: texto },
    ],
    tools:       [HABILIDADES_TOOL],
    tool_choice: { type: 'function', function: { name: 'extraer_habilidades' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'extraer_habilidades');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  const argumentos = typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
  return argumentos.habilidades ?? [];
}

async function verificarCompatibilidad(candidato, descripcion) {
  const prompt = PROMPT_VERIFICACION_MATCH
    .replace('{{nombre}}',       candidato.nombre       || '(no proporcionado)')
    .replace('{{ubicacion}}',    candidato.ubicacion     || '(no proporcionado)')
    .replace('{{escolaridad}}',  candidato.escolaridad   || '(no proporcionado)')
    .replace('{{expectativa}}',  candidato.expectativa   || '(no proporcionado)')
    .replace('{{experiencia}}',  candidato.experiencia   || '(no proporcionado)')
    .replace('{{descripcion}}',  descripcion             || '(sin descripción)');

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 300,
    reasoning:  { enabled: false },
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  const textoRespuesta = datos?.choices?.[0]?.message?.content?.trim();
  if (!textoRespuesta) throw new Error('OpenRouter no devolvió contenido de texto');

  const inicio = textoRespuesta.indexOf('{');
  const fin    = textoRespuesta.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new Error('No se encontró JSON en la respuesta de verificación');

  return JSON.parse(textoRespuesta.slice(inicio, fin + 1));
}

async function verificarRecomendaciones(candidato, vacantesCoincidentes) {
  const resultados = await Promise.all(
    vacantesCoincidentes.map(async (vacante) => {
      try {
        const { apto } = await verificarCompatibilidad(candidato, vacante.descripcion);
        return { vacante, apto: apto ?? true };
      } catch (error) {
        console.log(JSON.stringify({ etapa: 'verificacion_match', estado: 'error', id_team_tailor: vacante.id_team_tailor, mensaje: error.message }));
        return { vacante, apto: true };
      }
    })
  );

  return resultados.filter(r => r.apto).map(r => r.vacante);
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.log(JSON.stringify({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` }));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY) {
    console.log(JSON.stringify({ etapa: 'auth', estado: 'error', mensaje: 'unauthorized' }));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cuerpo      = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const nombre      = cuerpo?.nombre;
  const ubicacion   = cuerpo?.ubicacion;
  const escolaridad = cuerpo?.escolaridad;
  const expectativa = cuerpo?.expectativa;
  const experiencia = cuerpo?.experiencia;

  if (!ubicacion || typeof ubicacion !== 'string') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing ubicacion field' }));
    return res.status(400).json({ error: 'missing ubicacion field' });
  }

  if (!experiencia || typeof experiencia !== 'string') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing experiencia field' }));
    return res.status(400).json({ error: 'missing experiencia field' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', ubicacion, chars: experiencia.length }));

  let habilidadesDetectadas = detectarHabilidadesPorRegex(experiencia);
  let origenDeteccion = 'regex';

  if (habilidadesDetectadas.length === 0) {
    try {
      habilidadesDetectadas = await detectarHabilidadesPorLlm(experiencia);
      origenDeteccion = 'llm';
    } catch (error) {
      console.log(JSON.stringify({ etapa: 'llm', estado: 'error', mensaje: error.message }));
      return res.status(500).json({ error: error.message });
    }
  }

  console.log(JSON.stringify({ etapa: 'deteccion', estado: 'ok', origen: origenDeteccion, habilidades: habilidadesDetectadas }));

  const usoIa = origenDeteccion === 'llm';

  if (habilidadesDetectadas.length === 0) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'sin_habilidades' }));
    return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: vacantes, error } = await supabase
      .from('vacantes')
      .select('id_team_tailor, domicilio, habilidades, descripcion')
      .eq('domicilio', ubicacion);

    if (error) throw error;

    const vacantesCoincidentes = vacantes.filter(
      vacante => habilidadesDetectadas.some(habilidad => vacante.habilidades?.includes(habilidad))
    );

    console.log(JSON.stringify({ etapa: 'coincidencias_iniciales', estado: 'ok', coincidencias: vacantesCoincidentes.length }));

    if (vacantesCoincidentes.length === 0) {
      console.log(JSON.stringify({ etapa: 'completado', estado: 'sin_coincidencias' }));
      return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
    }

    const candidato = { nombre, ubicacion, escolaridad, expectativa, experiencia };
    const vacantesVerificadas = await verificarRecomendaciones(candidato, vacantesCoincidentes);

    console.log(JSON.stringify({ etapa: 'verificacion_match', estado: 'ok', antes: vacantesCoincidentes.length, despues: vacantesVerificadas.length }));

    const idsCoincidentes = vacantesVerificadas
      .map(vacante => parseInt(vacante.id_team_tailor, 10))
      .filter(id => Number.isInteger(id));

    const idsUnicos = [...new Set(idsCoincidentes)];

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', coincidencias: idsUnicos.length }));
    return res.status(200).json({ id_team_tailor: idsUnicos, uso_ia: usoIa });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'consulta_vacantes', estado: 'error', mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}
