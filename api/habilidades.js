import { createClient }      from '@supabase/supabase-js';
import { orChatCompletion }  from '../lib/openrouter.js';
import { HABILIDADES_REGEX } from '../lib/habilidades_dict.js';

const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash-0731';

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
    messages: [
      { role: 'system', content: 'Analiza la experiencia laboral reciente que describe el candidato y extrae únicamente las habilidades de la lista cerrada que apliquen.' },
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
  const experiencia = cuerpo?.experiencia;

  if (!experiencia || typeof experiencia !== 'string') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing experiencia field' }));
    return res.status(400).json({ error: 'missing experiencia field' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', chars: experiencia.length }));

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
      .select('id_team_tailor, habilidades');

    if (error) throw error;

    const idsCoincidentes = vacantes
      .filter(vacante => habilidadesDetectadas.some(habilidad => vacante.habilidades?.includes(habilidad)))
      .map(vacante => vacante.id_team_tailor);

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', coincidencias: idsCoincidentes.length }));
    return res.status(200).json({ id_team_tailor: idsCoincidentes, uso_ia: usoIa });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'consulta_vacantes', estado: 'error', mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}
