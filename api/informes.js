import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ttObtener }     from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_ANALISIS_ESTRUCTURADO = readFileSync(join(__dirname, '../prompts/analisis_estructurado.txt'), 'utf-8');
const OPENROUTER_MODEL             = 'anthropic/claude-opus-5';

// Mapeo de preguntas de TeamTailor -> etiqueta legible que se envía al modelo.
const QUESTION_MAPPING = {
  '74195':  'LUGAR_NACIMIENTO',
  '70845':  'EDAD',
  '73101':  'DOMICILIO',
  '74382':  'ESCOLARIDAD',
  '118792': 'ESTADO_CIVIL',
  '74198':  'SUELDO_DESEADO',
  '121800': 'ULTIMO_SUELDO',
  '74426':  'CONTEXTO_PERSONAL',
  '121801': 'ANTECEDENTES_PROFESIONALES',
  '121802': 'COMPETENCIAS_Y_HABILIDADES',
  '121803': 'METODOLOGIAS_UTILIZADAS',
  '121804': 'RESPUESTAS_A_ESCENARIOS',
  '121805': 'AREAS_DE_OPORTUNIDAD',
  '121806': 'MOTIVACIONES_Y_EXPECTATIVAS',
  '121807': 'NOTAS_DEL_ENTREVISTADOR',
  '121808': 'HISTORICO_LABORAL',
};

const INFORME_TOOL = {
  type: 'function',
  function: {
    name:        'informe_estructurado',
    description: 'Entrega el análisis estructurado del candidato para el informe ejecutivo de una sola página. Todos los textos deben ser de una sola línea, breves y ejecutivos.',
    parameters: {
      type: 'object',
      properties: {
        datos_personales: {
          type: 'object',
          properties: {
            estado_civil:   { type: 'string', description: 'Una sola línea, ej. "Casado(a)".' },
            educacion:      { type: 'string', description: 'Una sola línea, ej. "Lic. en Administración".' },
            domicilio:      { type: 'string', description: 'Una sola línea.' },
            ultimo_sueldo:  { type: 'string', description: 'Una sola línea, ej. "$25,000 MXN mensuales".' },
            sueldo_deseado: { type: 'string', description: 'Una sola línea.' },
          },
          required: ['estado_civil', 'educacion', 'domicilio', 'ultimo_sueldo', 'sueldo_deseado'],
        },
        trayectoria: {
          type: 'array',
          description: 'Máximo 2 empleos (idealmente 1: el más reciente y relevante), más reciente primero. Lista vacía si no hay información.',
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              compania: { type: 'string', description: 'Una sola línea.' },
              periodo:  { type: 'string', description: 'Una sola línea.' },
              puesto:   { type: 'string', description: 'SOLO el nombre del puesto tal cual, lo más corto posible. Nunca incluir área, empresa, giro del negocio ni descripciones adicionales (ej. "Gerente de Ventas", nunca "Gerente de Ventas de la división industrial").' },
              sueldo:   { type: 'string', description: 'Una sola línea.' },
              salida:   { type: 'string', description: 'Una sola línea.' },
            },
            required: ['compania', 'periodo', 'puesto', 'sueldo', 'salida'],
          },
        },
        apego_vacante: {
          type: 'array',
          description: 'Hasta 5 áreas a evaluar (idealmente 5, una por cada área central discutida en la entrevista), derivadas directamente de las respuestas del candidato. No repetir áreas equivalentes.',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              area:      { type: 'string', description: '2-5 palabras.' },
              evidencia: { type: 'string', description: 'Una sola línea (máx. ~12 palabras), un hecho concreto.' },
            },
            required: ['area', 'evidencia'],
          },
        },
        competencias: {
          type: 'array',
          description: 'Hasta 5 competencias (idealmente 5), las centrales discutidas a lo largo de la entrevista.',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              competencia: { type: 'string', description: 'Nombre corto de la competencia o logro.' },
              nivel:       { type: 'string', enum: ['Básico', 'Intermedio', 'Avanzado', 'Experto'] },
            },
            required: ['competencia', 'nivel'],
          },
        },
        comentarios: { type: 'string', description: 'Un solo párrafo, máximo 70 palabras. La última frase siempre debe ser una recomendación explícita de avance en el proceso — este informe solo se genera para candidatos que ya se decidió avanzar.' },
      },
      required: ['datos_personales', 'trayectoria', 'apego_vacante', 'competencias', 'comentarios'],
    },
  },
};

// ── TeamTailor ───────────────────────────────────────────────────────────

async function obtenerRespuestasCandidato(candidatoId) {
  let todas = [];
  let pagina = 1;

  while (true) {
    const datos = await ttObtener(`/candidates/${candidatoId}/answers?include=question&page[size]=30&page[number]=${pagina}`, true);
    todas = todas.concat(datos.data ?? []);

    const totalPaginas = datos.meta?.['page-count'] ?? 1;
    if (pagina >= totalPaginas) break;
    pagina++;
  }

  return todas;
}

function parsearRespuestas(respuestas) {
  const porId = {};

  for (const respuesta of respuestas) {
    const preguntaId = respuesta.relationships?.question?.data?.id;
    if (!preguntaId || !QUESTION_MAPPING[preguntaId]) continue;

    const attrs        = respuesta.attributes ?? {};
    const opciones      = attrs.choices ?? [];
    const opcionesTexto = opciones.length ? opciones.map(String).join(', ') : '';
    const texto = attrs.text || attrs.answer || String(attrs.number ?? '') || opcionesTexto || String(attrs.boolean ?? '');

    if (texto && !['None', '', '-'].includes(texto)) {
      (porId[preguntaId] ??= []).push(String(texto));
    }
  }

  return porId;
}

function extraerNombreInterno(datosVacante) {
  const attrs = datosVacante.data?.attributes ?? {};
  return attrs['internal-name'] || attrs.title || '-';
}

function obtenerTextoEdad(respuestasPorId) {
  const valores = respuestasPorId['70845'];
  if (!valores) return '-';
  const match = String(valores[0]).match(/\d+/);
  return match ? `${match[0]} años` : String(valores[0]);
}

function limpiarValor(valor, fallback = '-') {
  if (valor == null) return fallback;
  const texto = String(valor).trim();
  return texto && !['None', 'null', 'NA', 'N/A'].includes(texto) ? texto : fallback;
}

function construirBloqueRespuestasCrudas(respuestasPorId) {
  const lineas = [];

  for (const [preguntaId, etiqueta] of Object.entries(QUESTION_MAPPING)) {
    if (etiqueta === 'EDAD') continue;
    const valores = respuestasPorId[preguntaId];
    if (!valores?.length) continue;
    const texto = valores.length > 1 ? valores.join('\n') : valores[0];
    lineas.push(`### ${etiqueta}\n${texto}`);
  }

  return lineas.length ? lineas.join('\n\n') : '(Sin respuestas disponibles)';
}

async function obtenerAnalisisEstructurado(respuestasPorId, nombreCandidato, vacante) {
  const bloqueCrudo   = construirBloqueRespuestasCrudas(respuestasPorId);
  const mensajeUsuario = `Candidato: ${nombreCandidato}\nVacante: ${vacante}\n\n${bloqueCrudo}`;

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: PROMPT_ANALISIS_ESTRUCTURADO },
      { role: 'user',   content: mensajeUsuario },
    ],
    tools:       [INFORME_TOOL],
    tool_choice: { type: 'function', function: { name: 'informe_estructurado' } },
    reasoning:   { effort: 'high' },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'informe_estructurado');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  const argumentos = llamada.function.arguments;
  return typeof argumentos === 'string' ? JSON.parse(argumentos) : argumentos;
}

function mapearCamposSimples(analisis, extra) {
  const personales = analisis.datos_personales ?? {};

  return {
    ESTADOCIVIL:    limpiarValor(personales.estado_civil),
    EDUCACION:      limpiarValor(personales.educacion),
    DOMICILIO:      limpiarValor(personales.domicilio),
    ULTIMOSUELDO:   limpiarValor(personales.ultimo_sueldo),
    SUELDODESEADO:  limpiarValor(personales.sueldo_deseado),
    COMENTARIOS:    limpiarValor(analisis.comentarios),
    ...extra,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { postulacion: postulacionId, vacante: vacanteId } = req.body ?? {};
  if (!postulacionId || !vacanteId) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion or vacante' }));
    return res.status(400).json({ error: "Los campos 'postulacion' y 'vacante' son requeridos" });
  }

  try {
    const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
    const datosCandidato = candidatoCrudo.data;
    if (!datosCandidato)
      return res.status(404).json({ error: 'Candidato no encontrado para la postulación indicada' });

    const candidatoId = datosCandidato.id;
    const attrs        = datosCandidato.attributes ?? {};
    const primerNombre = attrs['first-name'] ?? '';
    const apellido      = attrs['last-name']  ?? '';
    const nombreCompleto = `${primerNombre} ${apellido}`.trim();
    const urlFoto        = attrs.picture ?? null;

    if (!urlFoto) {
      console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'candidato sin foto de perfil', postulacion_id: postulacionId }));
      return res.status(422).json({ error: 'El candidato no tiene foto de perfil' });
    }

    const datosVacante  = await ttObtener(`/jobs/${vacanteId}`, true);
    const nombreInterno = extraerNombreInterno(datosVacante);

    const respuestasCrudas = await obtenerRespuestasCandidato(candidatoId);
    const respuestasPorId  = parsearRespuestas(respuestasCrudas);

    console.log(JSON.stringify({ etapa: 'analisis_ia', candidato: nombreCompleto, vacante: nombreInterno }));
    const analisis = await obtenerAnalisisEstructurado(respuestasPorId, nombreCompleto, nombreInterno);

    const camposSimples = mapearCamposSimples(analisis, {
      FOTO:    urlFoto,
      NOMBRE:  nombreCompleto || '-',
      EDAD:    obtenerTextoEdad(respuestasPorId),
      VACANTE: nombreInterno.toUpperCase(),
    });

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato: nombreCompleto, postulacion_id: postulacionId }));

    return res.status(200).json({
      simple:        camposSimples,
      trayectoria:   analisis.trayectoria ?? [],
      apego_vacante: analisis.apego_vacante ?? [],
      competencias:  analisis.competencias ?? [],
    });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}
