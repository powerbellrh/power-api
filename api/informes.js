import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient }  from '@supabase/supabase-js';
import { ttObtener, ttActualizar, ttCrear, ttSubirArchivoTransitorio } from '../lib/clientes_api.js';
import { orChatCompletion, orGenerarImagen } from '../lib/openrouter.js';
import { analizarRespuestas } from '../lib/evaluacion_postulacion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_ANALISIS_ESTRUCTURADO           = readFileSync(join(__dirname, '../prompts/analisis_estructurado.txt'), 'utf-8');
const PROMPT_ANALISIS_ESTRUCTURADO_OPERATIVO = readFileSync(join(__dirname, '../prompts/analisis_estructurado_operativo.txt'), 'utf-8');
const OPENROUTER_MODEL             = 'z-ai/glm-5.3';
const OPENROUTER_MODEL_IMAGEN      = 'google/gemini-3.1-flash-lite-image';
const FOTO_PERFIL_DEFAULT          = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';
const FOTO_PERFIL_HOMBRE           = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
const FOTO_PERFIL_MUJER            = 'https://i.ibb.co/6CdjYbv/fotomujer.png';
const PROMPT_RETOQUE_FOTO          = 'El propósito de este retoque es mostrar a la persona en una gran versión corporativa de sí misma, para presentarla ante un cliente. Aplica únicamente retoques ligeros a esta fotografía, en beneficio de la persona, que incrementen ligeramente su imagen corporativa y profesional, y aumenta la resolución/nitidez de la imagen. No alteres ningún rasgo facial de la persona, ni su maquillaje, ni ninguna expresión de su personalidad: la persona debe seguir viéndose como ella misma. Puedes ajustar el encuadre/enmarcado y simular ángulos más profesionales, pero el resultado debe lucir natural, sin verse alterado ni artificial. Asegúrate de que la persona esté vistiendo siempre ropa formal de oficina (por ejemplo, camisa, blusa o saco), ajustando la vestimenta de manera natural y coherente con la persona y el encuadre.';

// IDs de reclutadores (usuarios de TeamTailor) que operan bajo el modo "operativo".
// Cualquier otro reclutador, o vacantes sin reclutador asignado, usan el modo "administrativo" (default).
const RECLUTADORES_OPERATIVA = new Set([
  '42381', '82313', '46016', '107180', '64360', '76703',
  '45146', '45147', '46250', '68768', '44696',
]);

// Catálogo de intenciones al que se clasifica cada pregunta contestada por el candidato
// (formulario de TeamTailor, formulario de evaluación y preguntas personalizadas de WhatsApp),
// sin importar el ID de la pregunta original ni la vacante/entrevista de la que provenga.
const INTENCIONES_ADMINISTRATIVO = {
  FECHA_LUGAR_NACIMIENTO:     'Fecha y lugar de nacimiento del candidato.',
  EDAD:                       'Edad del candidato.',
  DOMICILIO:                  'Domicilio o dirección donde vive el candidato.',
  ESCOLARIDAD:                'Nivel de estudios, carrera o escolaridad del candidato.',
  ESTADO_CIVIL:               'Estado civil del candidato.',
  SUELDO_DESEADO:             'Sueldo o salario que el candidato espera o desea ganar.',
  ULTIMO_SUELDO:              'Sueldo o salario que el candidato percibía en su último empleo.',
  CONTEXTO_PERSONAL:          'Contexto personal, familiar o de vida del candidato relevante para el puesto.',
  ANTECEDENTES_PROFESIONALES: 'Historial y antecedentes profesionales o experiencia laboral previa del candidato.',
  COMPETENCIAS_Y_HABILIDADES: 'Competencias, habilidades técnicas o blandas del candidato.',
  METODOLOGIAS_UTILIZADAS:    'Metodologías, herramientas o procesos que el candidato ha utilizado en su trabajo.',
  RESPUESTAS_A_ESCENARIOS:    'Respuestas del candidato a escenarios o preguntas situacionales/hipotéticas.',
  AREAS_DE_OPORTUNIDAD:       'Áreas de oportunidad, debilidades o aspectos a mejorar del candidato.',
  MOTIVACIONES_Y_EXPECTATIVAS: 'Motivaciones, expectativas o razones del candidato para buscar el puesto.',
  NOTAS_DEL_ENTREVISTADOR:    'Notas, observaciones o percepción del entrevistador/consultor sobre el candidato.',
  HISTORICO_LABORAL:          'Histórico o trayectoria laboral detallada del candidato (empleos anteriores, fechas, puestos).',
};

// Catálogo de intenciones para el modo "operativo".
const INTENCIONES_OPERATIVO = {
  FECHA_LUGAR_NACIMIENTO: 'Fecha y lugar de nacimiento del candidato.',
  EDAD:                   'Edad del candidato.',
  DOMICILIO:              'Domicilio o dirección donde vive el candidato.',
  ESTADO_CIVIL:           'Estado civil del candidato.',
  ESCOLARIDAD:            'Nivel de estudios, carrera o escolaridad del candidato.',
  MOVILIDAD_EMPRESA:      'Disposición o facilidad del candidato para trasladarse hacia la empresa o el centro de trabajo.',
  SUELDO_DESEADO:         'Sueldo o salario que el candidato espera o desea ganar.',
  HISTORICO_LABORAL:      'Histórico o trayectoria laboral del candidato (empleos anteriores, fechas, puestos).',
  CONTEXTO_PERSONAL:      'Contexto personal, familiar o de vida del candidato relevante para el puesto.',
  PERCEPCION_CONSULTOR:   'Percepción, notas u observaciones del consultor/entrevistador sobre el candidato.',
};

const INFORME_TOOL = {
  type: 'function',
  function: {
    name:        'informe_estructurado',
    description: 'Entrega el análisis estructurado del candidato para el informe ejecutivo de una sola página. Todos los textos deben ser de una sola línea, breves y ejecutivos.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del candidato, en MAYÚSCULAS, con ortografía y capitalización corregidas si vienen mal escritas. No inventes ni cambies el nombre, solo corrige errores evidentes de captura.' },
        cliente: { type: 'string', description: 'Nombre del cliente, en MAYÚSCULAS. El texto crudo de la vacante sigue la convención "CLIENTE - PUESTO"; toma la parte ANTES del primer guion, corrige su ortografía y elimina espacios sobrantes. Si no hay un guion en el texto crudo, usa "-".' },
        vacante: { type: 'string', description: 'Nombre de la vacante (el puesto), en MAYÚSCULAS, con ortografía corregida. El texto crudo sigue la convención "CLIENTE - PUESTO"; toma SOLO la parte DESPUÉS del primer guion (si no hay guion, usa el texto completo). Elimina cualquier sufijo o marca interna de republicación o control (ej. "V2", "V3", "REPUBLICACION", "RE-PUBLICACION", códigos de ubicación u otras etiquetas internas), dejando solo el nombre real del puesto.' },
        datos_personales: {
          type: 'object',
          properties: {
            estado_civil:   { type: 'string', description: 'Una sola línea, ej. "Casado(a)".' },
            educacion:      { type: 'string', description: 'Una sola línea, ej. "Lic. en Administración".' },
            domicilio:      { type: 'string', description: 'Una sola línea.' },
            sueldo_deseado: { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
            edad:           { type: 'string', description: 'Formato EXACTO y obligatorio: "<edad> años, <fecha completa en letras> en <ciudad>, <estado>", ej. "31 años, 30 de septiembre de 1990 en Pátzcuaro, Michoacán". Convierte fechas abreviadas o numéricas a formato completo en letras ("03 may 95" → "3 de mayo de 1995") y corrige nombres de lugares (acentos, mayúsculas). Si falta la edad, el lugar o la fecha, omite esa parte pero conserva lo disponible en el mismo formato. Si no hay ningún dato, usa "-".' },
          },
          required: ['estado_civil', 'educacion', 'domicilio', 'sueldo_deseado', 'edad'],
        },
        trayectoria: {
          type: 'array',
          description: 'Máximo 2 empleos (idealmente 1: el más reciente y relevante), más reciente primero. Lista vacía si no hay información.',
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              compania: { type: 'string', description: 'Una sola línea.' },
              periodo:  { type: 'string', description: 'Una sola línea. Usa fechas concretas si están disponibles, formato "<Mes> <año> a <Mes> <año>" (ej. "Marzo 2019 a Febrero 2021"), o "<Mes> <año> a la fecha" si sigue vigente. Nunca uses una duración aproximada como "5 años"; solo recurre a eso si no hay ninguna fecha disponible.' },
              puesto:   { type: 'string', description: 'SOLO el nombre del puesto tal cual, lo más corto posible. Nunca incluir área, empresa, giro del negocio ni descripciones adicionales (ej. "Gerente de Ventas", nunca "Gerente de Ventas de la división industrial").' },
              sueldo:   { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
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
      required: ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'apego_vacante', 'competencias', 'comentarios'],
    },
  },
};

const INFORME_TOOL_OPERATIVO = {
  type: 'function',
  function: {
    name:        'informe_operativo_estructurado',
    description: 'Entrega el análisis estructurado del candidato operativo para el informe ejecutivo de una sola página. Todos los textos deben ser de una sola línea, breves y ejecutivos.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del candidato, en MAYÚSCULAS, con ortografía y capitalización corregidas si vienen mal escritas. No inventes ni cambies el nombre, solo corrige errores evidentes de captura.' },
        cliente: { type: 'string', description: 'Nombre del cliente, en MAYÚSCULAS. El texto crudo de la vacante sigue la convención "CLIENTE - PUESTO"; toma la parte ANTES del primer guion, corrige su ortografía y elimina espacios sobrantes. Si no hay un guion en el texto crudo, usa "-".' },
        vacante: { type: 'string', description: 'Nombre de la vacante (el puesto), en MAYÚSCULAS, con ortografía corregida. El texto crudo sigue la convención "CLIENTE - PUESTO"; toma SOLO la parte DESPUÉS del primer guion (si no hay guion, usa el texto completo). Elimina cualquier sufijo o marca interna de republicación o control (ej. "V2", "V3", "REPUBLICACION", "RE-PUBLICACION", códigos de ubicación u otras etiquetas internas), dejando solo el nombre real del puesto.' },
        datos_personales: {
          type: 'object',
          properties: {
            estado_civil:   { type: 'string', description: 'Una sola línea, ej. "Casado(a)".' },
            educacion:      { type: 'string', description: 'Una sola línea, ej. "Lic. en Administración".' },
            domicilio:      { type: 'string', description: 'Una sola línea.' },
            sueldo_deseado: { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
            edad:           { type: 'string', description: 'Formato EXACTO y obligatorio: "<edad> años, <fecha completa en letras> en <ciudad>, <estado>", ej. "31 años, 30 de septiembre de 1990 en Pátzcuaro, Michoacán". Convierte fechas abreviadas o numéricas a formato completo en letras ("03 may 95" → "3 de mayo de 1995") y corrige nombres de lugares (acentos, mayúsculas). Si falta la edad, el lugar o la fecha, omite esa parte pero conserva lo disponible en el mismo formato. Si no hay ningún dato, usa "-".' },
          },
          required: ['estado_civil', 'educacion', 'domicilio', 'sueldo_deseado', 'edad'],
        },
        trayectoria: {
          type: 'array',
          description: 'Máximo 2 empleos (idealmente 1: el más reciente y relevante), más reciente primero. Lista vacía si no hay información.',
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              compania: { type: 'string', description: 'Una sola línea.' },
              periodo:  { type: 'string', description: 'Una sola línea. Usa fechas concretas si están disponibles, formato "<Mes> <año> a <Mes> <año>" (ej. "Marzo 2019 a Febrero 2021"), o "<Mes> <año> a la fecha" si sigue vigente. Nunca uses una duración aproximada como "5 años"; solo recurre a eso si no hay ninguna fecha disponible.' },
              puesto:   { type: 'string', description: 'SOLO el nombre del puesto tal cual, lo más corto posible. Nunca incluir área, empresa, giro del negocio ni descripciones adicionales (ej. "Gerente de Ventas", nunca "Gerente de Ventas de la división industrial").' },
              sueldo:   { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
              salida:   { type: 'string', description: 'Una sola línea.' },
            },
            required: ['compania', 'periodo', 'puesto', 'sueldo', 'salida'],
          },
        },
        comentarios: { type: 'string', description: 'Un solo párrafo, máximo 70 palabras, que incluya explícitamente la movilidad del candidato hacia la empresa y las notas del consultor (combinando contexto personal y percepción del consultor sobre el candidato). La última frase siempre debe ser una recomendación explícita de avance en el proceso — este informe solo se genera para candidatos que ya se decidió avanzar.' },
      },
      required: ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'comentarios'],
    },
  },
};

const GENERO_TOOL = {
  type: 'function',
  function: {
    name:        'genero_candidato',
    description: 'Determina el género del candidato según su nombre.',
    parameters: {
      type: 'object',
      properties: {
        genero: {
          type:        'string',
          enum:        ['Hombre', 'Mujer', 'ninguno'],
          description: 'Género del candidato según su nombre, solo con alta confianza según uso común en México. "ninguno" si es dudoso, unisex o el nombre no es suficiente.',
        },
      },
      required: ['genero'],
    },
  },
};

function construirToolClasificacion(catalogoIntenciones) {
  return {
    type: 'function',
    function: {
      name:        'clasificar_preguntas',
      description: 'Clasifica cada pregunta contestada por el candidato según la intención del catálogo que mejor le corresponda.',
      parameters: {
        type: 'object',
        properties: {
          clasificaciones: {
            type:        'array',
            description: 'Una entrada por cada pregunta recibida, en el mismo orden en que se recibieron.',
            items: {
              type: 'object',
              properties: {
                indice:    { type: 'integer', description: 'Índice (basado en 0) de la pregunta, según el orden en que se recibió.' },
                intencion: { type: 'string', enum: [...Object.keys(catalogoIntenciones), 'NINGUNA'], description: 'Intención del catálogo que mejor corresponde a la pregunta, o "NINGUNA" si ninguna aplica.' },
              },
              required: ['indice', 'intencion'],
            },
          },
        },
        required: ['clasificaciones'],
      },
    },
  };
}

// Clasifica, con IA, cada pregunta contestada (venga de donde venga: formulario de
// TeamTailor, formulario de evaluación o preguntas personalizadas de WhatsApp) según
// la intención del catálogo que mejor le corresponda. Esto reemplaza el mapeo fijo de
// IDs de pregunta -> etiqueta, así el informe funciona sin importar el formato exacto
// de la entrevista o de la vacante.
async function clasificarPreguntasPorIntencion(paresPreguntaRespuesta, catalogoIntenciones) {
  if (!paresPreguntaRespuesta.length) return {};

  const listaPreguntas = paresPreguntaRespuesta.map((par, indice) => `${indice}: ${par.pregunta}`).join('\n');
  const catalogoTexto  = Object.entries(catalogoIntenciones).map(([clave, descripcion]) => `- ${clave}: ${descripcion}`).join('\n');
  const tool           = construirToolClasificacion(catalogoIntenciones);

  try {
    const datos = await orChatCompletion({
      model:    OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'Clasifica cada pregunta de una entrevista de candidato según la intención del catálogo que mejor le corresponda. Usa "NINGUNA" si la pregunta no corresponde a ninguna intención del catálogo.' },
        { role: 'user',   content: `Catálogo de intenciones:\n${catalogoTexto}\n\nPreguntas a clasificar:\n${listaPreguntas}` },
      ],
      tools:       [tool],
      tool_choice: { type: 'function', function: { name: 'clasificar_preguntas' } },
    }, process.env.OPENROUTER_API_KEY_INFORMES);

    const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'clasificar_preguntas');
    if (!llamada) return {};

    const argumentos = typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
    const clasificaciones = argumentos?.clasificaciones ?? [];

    const porIndice = {};
    for (const clasificacion of clasificaciones) {
      if (clasificacion.intencion && clasificacion.intencion !== 'NINGUNA') porIndice[clasificacion.indice] = clasificacion.intencion;
    }
    return porIndice;
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'clasificacion_preguntas', estado: 'error', mensaje: error.message }));
    return {};
  }
}

// Agrupa las respuestas del candidato bajo la intención con la que fueron clasificadas,
// en el mismo formato de bloque que antes se armaba a partir del mapeo fijo de IDs.
function construirBloqueRespuestasPorIntencion(paresPreguntaRespuesta, clasificacionPorIndice, catalogoIntenciones) {
  const porIntencion = {};

  paresPreguntaRespuesta.forEach((par, indice) => {
    const intencion = clasificacionPorIndice[indice];
    if (!intencion) return;
    (porIntencion[intencion] ??= []).push(par.respuesta);
  });

  const lineas = [];
  for (const clave of Object.keys(catalogoIntenciones)) {
    const valores = porIntencion[clave];
    if (!valores?.length) continue;
    lineas.push(`### ${clave}\n${valores.join('\n')}`);
  }

  return lineas.length ? lineas.join('\n\n') : '(Sin respuestas disponibles)';
}

async function inferirGenero(nombreCompleto) {
  const datos = await orChatCompletion({
    model:       OPENROUTER_MODEL,
    messages:    [{ role: 'user', content: `Nombre del candidato: ${nombreCompleto}` }],
    tools:       [GENERO_TOOL],
    tool_choice: { type: 'function', function: { name: 'genero_candidato' } },
  }, process.env.OPENROUTER_API_KEY_INFORMES);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'genero_candidato');
  if (!llamada) return 'ninguno';

  const argumentos = typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
  return argumentos?.genero ?? 'ninguno';
}

// Cuando el candidato no tiene foto de perfil en TeamTailor, le asignamos una
// foto genérica según su género (inferido por IA a partir del nombre) para que
// el informe siempre pueda generarse.
async function asignarFotoGenerica(nombreCompleto, candidatoId) {
  let genero = 'ninguno';
  try {
    genero = await inferirGenero(nombreCompleto);
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'foto_generica', estado: 'error', mensaje: error.message, candidato_id: candidatoId }));
  }

  const fotoGenerica = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  await ttActualizar(`/candidates/${candidatoId}`, {
    data: { id: candidatoId.toString(), type: 'candidates', attributes: { picture: fotoGenerica } },
  }, true);

  console.log(JSON.stringify({ etapa: 'foto_generica', estado: 'ok', candidato_id: candidatoId, genero }));
  return fotoGenerica;
}

// ── TeamTailor ───────────────────────────────────────────────────────────

async function obtenerRespuestasCandidato(candidatoId) {
  let respuestas = [];
  let preguntas  = [];
  let pagina = 1;

  while (true) {
    const datos = await ttObtener(`/candidates/${candidatoId}/answers?include=question&page[size]=30&page[number]=${pagina}`, true);
    respuestas = respuestas.concat(datos.data ?? []);
    preguntas  = preguntas.concat(datos.included ?? []);

    const totalPaginas = datos.meta?.['page-count'] ?? 1;
    if (pagina >= totalPaginas) break;
    pagina++;
  }

  return { respuestas, preguntas };
}

function extraerNombreInterno(datosVacante) {
  const attrs = datosVacante.data?.attributes ?? {};
  return attrs['internal-name'] || attrs.title || '-';
}

function extraerIdReclutador(datosVacante) {
  return datosVacante.data?.relationships?.user?.data?.id ?? null;
}

function extraerNombreReclutador(datosVacante) {
  const usuarioId = datosVacante.data?.relationships?.user?.data?.id;
  if (!usuarioId) return null;

  const usuario = datosVacante.included?.find(item => item.type === 'users' && item.id === usuarioId);
  if (!usuario) return null;

  const attrs = usuario.attributes ?? {};
  return attrs.name || `${attrs['first-name'] ?? ''} ${attrs['last-name'] ?? ''}`.trim() || null;
}

function limpiarValor(valor, fallback = '-') {
  if (valor == null) return fallback;
  const texto = String(valor).trim();
  return texto && !['None', 'null', 'NA', 'N/A'].includes(texto) ? texto : fallback;
}

// Trae las preguntas y respuestas que ya recopiló el endpoint de evaluaciones
// (formulario de TeamTailor tal como lo vio la IA, más las respuestas a las
// preguntas personalizadas enviadas por WhatsApp), como pares {pregunta, respuesta}
// listos para clasificar por intención junto con el resto de las respuestas.
async function obtenerPreguntasRespuestasEvaluacion(postulacionId) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('evaluaciones')
      .select('candidato_respuestas, respuestas_preguntas_personalizadas')
      .eq('postulacion_id', postulacionId)
      .single();

    if (error || !data) return {};

    return {
      ...(data.candidato_respuestas ?? {}),
      ...(data.respuestas_preguntas_personalizadas ?? {}),
    };
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'obtener_preguntas_evaluacion', estado: 'error', mensaje: error.message, postulacion_id: postulacionId }));
    return {};
  }
}

// El consumidor (power_informe.py) reenvía como respuesta_anterior el JSON aplanado
// que este mismo endpoint le devolvió (simple.NOMBRE, simple.ESTADOCIVIL, etc.), no el
// shape de INFORME_TOOL (nombre, datos_personales.estado_civil, etc.). Hay que reconstruirlo
// para que el modelo reciba el informe anterior en el mismo formato que debe producir.
function reconstruirAnalisisPrevio(respuestaAnterior) {
  const simple = respuestaAnterior.simple ?? {};

  return {
    nombre:   simple.NOMBRE,
    cliente:  simple.CLIENTE,
    vacante:  simple.VACANTE,
    datos_personales: {
      estado_civil:   simple.ESTADOCIVIL,
      educacion:      simple.EDUCACION,
      domicilio:      simple.DOMICILIO,
      sueldo_deseado: simple.SUELDODESEADO,
      edad:           simple.EDAD,
    },
    trayectoria:   respuestaAnterior.trayectoria ?? [],
    apego_vacante: respuestaAnterior.apego_vacante ?? [],
    competencias:  respuestaAnterior.competencias ?? [],
    comentarios:   simple.COMENTARIOS,
  };
}

async function obtenerAnalisisEstructurado(bloqueCrudo, nombreCandidato, vacante, comentarios, respuestaAnterior, urlCurriculum, opciones = {}) {
  const {
    prompt     = PROMPT_ANALISIS_ESTRUCTURADO,
    tool       = INFORME_TOOL,
    nombreTool = 'informe_estructurado',
  } = opciones;

  let mensajeUsuario = `Candidato: ${nombreCandidato}\nVacante: ${vacante}\n\n${bloqueCrudo}`;

  if (comentarios) {
    mensajeUsuario += `\n\n### COMENTARIOS_DE_CORRECCION_DEL_RECLUTADOR\nEste informe ya fue generado previamente y el reclutador solicitó una corrección. A continuación tienes el informe anterior (JSON) y los comentarios del reclutador sobre él. Compáralos: corrige ÚNICAMENTE lo que los comentarios indican, exactamente como se indica, y conserva sin cambios todo lo demás del informe anterior.`;

    if (respuestaAnterior && typeof respuestaAnterior === 'object') {
      const informeAnteriorTexto = JSON.stringify(reconstruirAnalisisPrevio(respuestaAnterior));
      mensajeUsuario += `\n\nInforme anterior:\n${informeAnteriorTexto}`;
    } else if (respuestaAnterior) {
      mensajeUsuario += `\n\nInforme anterior:\n${respuestaAnterior}`;
    }

    mensajeUsuario += `\n\nComentarios del reclutador:\n${comentarios}`;
  }

  async function llamarAnalisis(conCurriculum) {
    const adjuntoCurriculum = conCurriculum && urlCurriculum?.trim()
      ? [{ type: 'file', file: { filename: 'curriculum.pdf', file_data: urlCurriculum } }]
      : [];

    const datos = await orChatCompletion({
      model:      OPENROUTER_MODEL,
      ...(adjuntoCurriculum.length > 0 && { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] }),
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensajeUsuario },
            ...adjuntoCurriculum,
          ],
        },
      ],
      tools:       [tool],
      tool_choice: { type: 'function', function: { name: nombreTool } },
      reasoning:   { effort: 'high' },
    }, process.env.OPENROUTER_API_KEY_INFORMES);

    const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === nombreTool);
    if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

    const argumentos = llamada.function.arguments;
    return typeof argumentos === 'string' ? JSON.parse(argumentos) : argumentos;
  }

  try {
    return await llamarAnalisis(true);
  } catch (error) {
    if (!urlCurriculum?.trim()) throw error;
    // Si falla con el CV adjunto (ej. PDF corrupto o rate limit del parser), se reintenta
    // solo con las respuestas del candidato en vez de tumbar todo el informe.
    console.log(JSON.stringify({ etapa: 'analisis_con_cv', estado: 'error', mensaje: error.message }));
    return await llamarAnalisis(false);
  }
}

async function retocarFoto(urlFoto, candidatoId) {
  // TeamTailor sirve estas fotos desde un bucket S3/CloudFront que bloquea peticiones
  // HEAD (403), y el validador de URLs de OpenRouter/Gemini rechaza la URL cruda por eso
  // ("Unsupported URL, public internet addresses only") aunque un GET normal sí funciona.
  // Por eso la descargamos aquí y se la mandamos a OpenRouter como base64 inline.
  const respuestaFoto = await fetch(urlFoto);
  if (!respuestaFoto.ok) throw new Error(`No se pudo descargar la foto original (${respuestaFoto.status})`);
  const tipoFoto = respuestaFoto.headers.get('content-type') || 'image/jpeg';
  const bufferFotoOriginal = Buffer.from(await respuestaFoto.arrayBuffer());
  const dataUrlFoto = `data:${tipoFoto};base64,${bufferFotoOriginal.toString('base64')}`;

  const datos = await orGenerarImagen({
    model:          OPENROUTER_MODEL_IMAGEN,
    prompt:         PROMPT_RETOQUE_FOTO,
    resolution:     '1K',
    aspect_ratio:   '1:1',
    output_format:  'jpeg',
    input_references: [
      { type: 'image_url', image_url: { url: dataUrlFoto } },
    ],
  }, process.env.OPENROUTER_API_KEY_INFORMES);

  const imagen = datos?.data?.[0];
  if (!imagen?.b64_json) throw new Error('OpenRouter no devolvió una imagen válida');

  const bufferImagen = Buffer.from(imagen.b64_json, 'base64');
  const archivoTransitorio = await ttSubirArchivoTransitorio(bufferImagen, 'foto_retocada.jpg', imagen.media_type ?? 'image/jpeg', true);
  const uriTransitoria = archivoTransitorio?.uri;
  if (!uriTransitoria) {
    console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: 'sin URI transitoria', respuesta_teamtailor: archivoTransitorio }));
    throw new Error('TeamTailor no devolvió una URI transitoria válida');
  }

  const subida = await ttCrear('/uploads', {
    data: {
      type:       'uploads',
      attributes: { url: uriTransitoria },
      relationships: {
        candidate: { data: { type: 'candidates', id: candidatoId } },
      },
    },
  }, true);

  const urlFinal = subida?.data?.attributes?.url;
  if (!urlFinal) {
    console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: 'sin URL final', respuesta_teamtailor: subida }));
    throw new Error('TeamTailor no devolvió la URL de la imagen subida');
  }

  return urlFinal;
}

function mapearCamposSimples(analisis, extra) {
  const personales = analisis.datos_personales ?? {};

  return {
    NOMBRE:         limpiarValor(analisis.nombre),
    CLIENTE:        limpiarValor(analisis.cliente),
    VACANTE:        limpiarValor(analisis.vacante),
    ESTADOCIVIL:    limpiarValor(personales.estado_civil),
    EDUCACION:      limpiarValor(personales.educacion),
    DOMICILIO:      limpiarValor(personales.domicilio),
    SUELDODESEADO:  limpiarValor(personales.sueldo_deseado),
    EDAD:           limpiarValor(personales.edad),
    COMENTARIOS:    limpiarValor(analisis.comentarios),
    ...extra,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.INFORMES_API_KEY && claveApi !== process.env.INFORMES_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { postulacion: postulacionId, vacante: vacanteId, comentarios, respuesta_anterior: respuestaAnterior, imagen: mejorarFoto, cv: soloCurriculum } = req.body ?? {};

  if (soloCurriculum) {
    if (!postulacionId) {
      console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion' }));
      return res.status(400).json({ error: "El campo 'postulacion' es requerido" });
    }

    try {
      const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
      const urlCurriculum = candidatoCrudo.data?.attributes?.resume ?? null;
      if (!urlCurriculum)
        return res.status(422).json({ error: 'El candidato no tiene CV' });

      console.log(JSON.stringify({ etapa: 'refrescar_cv', estado: 'ok', postulacion_id: postulacionId }));
      return res.status(200).json({ curriculum: urlCurriculum });
    } catch (error) {
      console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
      return res.status(500).json({ error: error.message });
    }
  }

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
    let urlFoto          = attrs.picture ?? null;
    const urlCurriculum  = attrs.resume ?? null;

    if (!urlFoto) {
      console.log(JSON.stringify({ etapa: 'validacion', estado: 'sin_foto', mensaje: 'candidato sin foto de perfil, asignando foto genérica', postulacion_id: postulacionId }));
      urlFoto = await asignarFotoGenerica(nombreCompleto, candidatoId);
    }

    const datosVacante   = await ttObtener(`/jobs/${vacanteId}?include=user`, true);
    const nombreInterno  = extraerNombreInterno(datosVacante);
    const nombreReclutador = extraerNombreReclutador(datosVacante);
    const idReclutador   = extraerIdReclutador(datosVacante);
    const esOperativo    = idReclutador != null && RECLUTADORES_OPERATIVA.has(idReclutador);

    const catalogoIntenciones = esOperativo ? INTENCIONES_OPERATIVO : INTENCIONES_ADMINISTRATIVO;

    const { respuestas: respuestasCrudas, preguntas: preguntasIncluidas } = await obtenerRespuestasCandidato(candidatoId);
    const respuestasFormulario         = analizarRespuestas(respuestasCrudas, preguntasIncluidas) ?? {};
    const preguntasRespuestasEvaluacion = await obtenerPreguntasRespuestasEvaluacion(postulacionId);

    const todasLasPreguntas = { ...respuestasFormulario, ...preguntasRespuestasEvaluacion };
    const paresPreguntaRespuesta = Object.entries(todasLasPreguntas)
      .filter(([, respuesta]) => respuesta != null && String(respuesta).trim() !== '')
      .map(([pregunta, respuesta]) => ({ pregunta, respuesta: String(respuesta) }));

    const clasificacionPorIndice = await clasificarPreguntasPorIntencion(paresPreguntaRespuesta, catalogoIntenciones);
    const bloqueCrudo = construirBloqueRespuestasPorIntencion(paresPreguntaRespuesta, clasificacionPorIndice, catalogoIntenciones);

    console.log(JSON.stringify({
      etapa: 'preguntas_respuestas', postulacion_id: postulacionId,
      formulario_teamtailor: Object.keys(respuestasFormulario).length,
      evaluacion_supabase:   Object.keys(preguntasRespuestasEvaluacion).length,
      total_clasificadas:    Object.keys(clasificacionPorIndice).length,
      total_pares:           paresPreguntaRespuesta.length,
    }));

    // Se refresca el CV justo antes de mandarlo a OpenRouter: la URL firmada de TeamTailor
    // expira en segundos, y para este punto ya pasaron las llamadas de clasificación de preguntas.
    let urlCurriculumAnalisis = urlCurriculum;
    try {
      const candidatoParaAnalisis = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
      urlCurriculumAnalisis = candidatoParaAnalisis.data?.attributes?.resume ?? urlCurriculum;
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'refrescar_cv_analisis', estado: 'error', mensaje: e.message, postulacion_id: postulacionId }));
    }

    console.log(JSON.stringify({ etapa: 'analisis_ia', candidato: nombreCompleto, vacante: nombreInterno, tipo: esOperativo ? 'operativo' : 'estandar', con_cv: !!urlCurriculumAnalisis }));
    const analisis = await obtenerAnalisisEstructurado(bloqueCrudo, nombreCompleto, nombreInterno, comentarios, respuestaAnterior, urlCurriculumAnalisis, esOperativo ? {
      prompt:     PROMPT_ANALISIS_ESTRUCTURADO_OPERATIVO,
      tool:       INFORME_TOOL_OPERATIVO,
      nombreTool: 'informe_operativo_estructurado',
    } : {});

    let fotoFinal = urlFoto;
    if (mejorarFoto) {
      console.log(JSON.stringify({ etapa: 'retoque_foto', candidato: nombreCompleto, postulacion_id: postulacionId }));
      try {
        fotoFinal = await retocarFoto(urlFoto, candidatoId);
      } catch (error) {
        console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: error.message, postulacion_id: postulacionId }));
        fotoFinal = urlFoto;
      }
    }

    const camposSimples = mapearCamposSimples(analisis, {
      FOTO: fotoFinal,
    });

    // Se vuelve a pedir el CV justo antes de responder: la URL firmada de TeamTailor expira
    // pronto, y para este punto ya pasó el tiempo del análisis de IA y el posible retoque de foto.
    let urlCurriculumFinal = urlCurriculum;
    try {
      const candidatoFresco = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
      urlCurriculumFinal = candidatoFresco.data?.attributes?.resume ?? urlCurriculum;
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'refrescar_cv', estado: 'error', mensaje: e.message, postulacion_id: postulacionId }));
    }

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato: nombreCompleto, postulacion_id: postulacionId }));

    return res.status(200).json({
      tipo:        esOperativo ? 'operativo' : 'administrativo',
      simple:      camposSimples,
      trayectoria: analisis.trayectoria ?? [],
      ...(esOperativo ? {} : {
        apego_vacante: analisis.apego_vacante ?? [],
        competencias:  analisis.competencias ?? [],
      }),
      ...(urlCurriculumFinal ? { curriculum: urlCurriculumFinal } : {}),
      ...(nombreReclutador ? { reclutador: nombreReclutador } : {}),
    });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}
