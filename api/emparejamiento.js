import { readFileSync }      from 'fs';
import { fileURLToPath }     from 'url';
import { dirname, join }     from 'path';
import { createClient }      from '@supabase/supabase-js';
import { orChatCompletion }  from '../lib/openrouter.js';
import { HABILIDADES_REGEX } from '../lib/habilidades_dict.js';

const __dirname                     = dirname(fileURLToPath(import.meta.url));
const PROMPT_EXTRACCION_HABILIDADES = readFileSync(join(__dirname, '../prompts/extraccion_habilidades.txt'), 'utf-8');
const PROMPT_VERIFICACION_MATCH     = readFileSync(join(__dirname, '../prompts/verificacion_emparejamiento.txt'), 'utf-8');
const PROMPT_NORMALIZACION_DOMICILIO = readFileSync(join(__dirname, '../prompts/normalizacion_domicilio.txt'), 'utf-8');
const OPENROUTER_MODEL              = 'deepseek/deepseek-v4-flash-0731';

const DOMICILIOS_VALIDOS = [
  'Zapopan, Jalisco',
  'Guadalajara, Jalisco',
  'Tlaquepaque, Jalisco',
  'El Salto, Jalisco',
  'Tlajomulco, Jalisco',
];

const DOMICILIO_REGEX = {
  'Zapopan, Jalisco':      /zapopan/i,
  'Guadalajara, Jalisco':  /guadalajara/i,
  'Tlaquepaque, Jalisco':  /tlaquepaque/i,
  'El Salto, Jalisco':     /el salto/i,
  'Tlajomulco, Jalisco':   /tlajomulco/i,
};

const DOMICILIO_TOOL = {
  type: 'function',
  function: {
    name: 'normalizar_domicilio',
    description: 'Determina a cuál de los municipios permitidos corresponde el domicilio del candidato.',
    parameters: {
      type: 'object',
      properties: {
        domicilio: {
          type: 'string',
          enum: [...DOMICILIOS_VALIDOS, 'NO_DETERMINADO'],
          description: 'Municipio inferido, o NO_DETERMINADO si no hay información suficiente.',
        },
      },
      required: ['domicilio'],
    },
  },
};

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

function detectarDomicilioPorRegex(texto) {
  const encontrado = Object.entries(DOMICILIO_REGEX).find(([, regex]) => regex.test(texto));
  return encontrado?.[0] ?? null;
}

async function detectarDomicilioPorLlm(texto) {
  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    reasoning:  { enabled: false },
    messages: [
      { role: 'system', content: PROMPT_NORMALIZACION_DOMICILIO },
      { role: 'user',   content: texto },
    ],
    tools:       [DOMICILIO_TOOL],
    tool_choice: { type: 'function', function: { name: 'normalizar_domicilio' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'normalizar_domicilio');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  const argumentos = typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
  return argumentos.domicilio === 'NO_DETERMINADO' ? null : argumentos.domicilio;
}

async function normalizarDomicilio(texto) {
  const porRegex = detectarDomicilioPorRegex(texto);
  if (porRegex) return { domicilio: porRegex, origen: 'regex' };

  try {
    const porLlm = await detectarDomicilioPorLlm(texto);
    return { domicilio: porLlm, origen: 'llm' };
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'normalizacion_domicilio', estado: 'error', mensaje: error.message }));
    return { domicilio: null, origen: 'error' };
  }
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
    .replace('{{ubicacion}}',    candidato.domicilio     || '(no proporcionado)')
    .replace('{{escolaridad}}',  '(no proporcionado)')
    .replace('{{expectativa}}',  candidato.expectativa === true ? 'tiene expectativa de sueldo' : candidato.expectativa === false ? 'sin expectativa de sueldo particular' : '(no proporcionado)')
    .replace('{{experiencia}}',  candidato.experiencia   || '(no proporcionado)')
    .replace('{{rolar_turno}}',  typeof candidato.rolarTurno === 'boolean' ? (candidato.rolarTurno ? 'sí' : 'no') : '(no proporcionado)')
    .replace('{{acceso}}',       typeof candidato.acceso === 'boolean' ? (candidato.acceso ? 'sí' : 'no') : '(no proporcionado)')
    .replace('{{descripcion}}',  descripcion             || '(sin descripción)');

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 300,
    reasoning:  { effort: 'low' },
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
        const { apto, motivo } = await verificarCompatibilidad(candidato, vacante.descripcion);
        console.log(JSON.stringify({ etapa: 'verificacion_match', estado: 'ok', id_team_tailor: vacante.id_team_tailor, apto: apto ?? true, motivo }));
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
  const telefono    = cuerpo?.telefono;
  const edad        = cuerpo?.edad;
  const domicilio   = cuerpo?.domicilio;
  const expectativa = cuerpo?.expectativa;
  const experiencia = cuerpo?.experiencia;
  const rolarTurno  = cuerpo?.rolar_turno;
  const acceso      = cuerpo?.acceso;

  if (!domicilio || typeof domicilio !== 'string') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing domicilio field' }));
    return res.status(400).json({ error: 'missing domicilio field' });
  }

  if (!experiencia || typeof experiencia !== 'string') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing experiencia field' }));
    return res.status(400).json({ error: 'missing experiencia field' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', domicilio, chars: experiencia.length }));

  const { domicilio: domicilioNormalizado, origen: origenDomicilio } = await normalizarDomicilio(domicilio);

  console.log(JSON.stringify({ etapa: 'normalizacion_domicilio', estado: 'ok', origen: origenDomicilio, domicilio: domicilioNormalizado }));

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

  const usoIa = origenDeteccion === 'llm' || origenDomicilio === 'llm';

  if (habilidadesDetectadas.length === 0) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'sin_habilidades' }));
    return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    let consulta = supabase
      .from('vacantes')
      .select('id_team_tailor, domicilio, habilidades, descripcion');

    if (domicilioNormalizado) {
      consulta = consulta.eq('domicilio', domicilioNormalizado);
    }

    const { data: vacantes, error } = await consulta;

    if (error) throw error;

    const vacantesCoincidentes = vacantes.filter(
      vacante => habilidadesDetectadas.some(habilidad => vacante.habilidades?.includes(habilidad))
    );

    console.log(JSON.stringify({ etapa: 'coincidencias_iniciales', estado: 'ok', coincidencias: vacantesCoincidentes.length }));

    if (vacantesCoincidentes.length === 0) {
      console.log(JSON.stringify({ etapa: 'completado', estado: 'sin_coincidencias' }));
      return res.status(200).json({ id_team_tailor: [], uso_ia: usoIa });
    }

    const candidato = { nombre, domicilio: domicilioNormalizado ?? domicilio, expectativa, experiencia, rolarTurno, acceso };
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
