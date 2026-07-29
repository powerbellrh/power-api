import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ttObtener, ttCrear, ttSubirArchivoTransitorio } from '../lib/clientes_api.js';
import { orChatCompletion, orGenerarImagen } from '../lib/openrouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_ANALISIS_ESTRUCTURADO = readFileSync(join(__dirname, '../prompts/analisis_estructurado.txt'), 'utf-8');
const OPENROUTER_MODEL             = 'anthropic/claude-opus-5';
const OPENROUTER_MODEL_IMAGEN      = 'google/gemini-3.1-flash-lite-image';
const PROMPT_RETOQUE_FOTO          = 'Aplica únicamente retoques ligeros a esta fotografía, en beneficio de la persona, que incrementen ligeramente su imagen corporativa y profesional, y aumenta la resolución/nitidez de la imagen. No alteres ningún rasgo facial de la persona, ni su maquillaje, ni ninguna expresión de su personalidad. Puedes ajustar el encuadre/enmarcado y simular ángulos más profesionales, pero el resultado debe lucir natural, sin verse alterado ni artificial.';

// Mapeo de preguntas de TeamTailor -> etiqueta legible que se envía al modelo.
const QUESTION_MAPPING = {
  '74195':  'FECHA_LUGAR_NACIMIENTO',
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
              periodo:  { type: 'string', description: 'Una sola línea.' },
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

function construirBloqueRespuestasCrudas(respuestasPorId) {
  const lineas = [];

  for (const [preguntaId, etiqueta] of Object.entries(QUESTION_MAPPING)) {
    const valores = respuestasPorId[preguntaId];
    if (!valores?.length) continue;
    const texto = valores.length > 1 ? valores.join('\n') : valores[0];
    lineas.push(`### ${etiqueta}\n${texto}`);
  }

  return lineas.length ? lineas.join('\n\n') : '(Sin respuestas disponibles)';
}

async function obtenerAnalisisEstructurado(respuestasPorId, nombreCandidato, vacante, comentarios, respuestaAnterior) {
  const bloqueCrudo   = construirBloqueRespuestasCrudas(respuestasPorId);
  let mensajeUsuario = `Candidato: ${nombreCandidato}\nVacante: ${vacante}\n\n${bloqueCrudo}`;

  if (comentarios) {
    mensajeUsuario += `\n\n### COMENTARIOS_DE_CORRECCION_DEL_RECLUTADOR\nEste informe ya fue generado previamente y el reclutador solicitó una corrección. A continuación tienes el informe anterior (JSON) y los comentarios del reclutador sobre él. Compáralos: corrige ÚNICAMENTE lo que los comentarios indican, exactamente como se indica, y conserva sin cambios todo lo demás del informe anterior.`;

    if (respuestaAnterior) {
      const informeAnteriorTexto = typeof respuestaAnterior === 'string' ? respuestaAnterior : JSON.stringify(respuestaAnterior);
      mensajeUsuario += `\n\nInforme anterior:\n${informeAnteriorTexto}`;
    }

    mensajeUsuario += `\n\nComentarios del reclutador:\n${comentarios}`;
  }

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

async function retocarFoto(urlFoto, candidatoId, comentarioImagen) {
  // imagen_comentario funciona como 'comentarios' en el informe de texto: es feedback puntual
  // del reclutador sobre un retoque previo, que se añade al prompt en vez de reemplazarlo.
  let prompt = PROMPT_RETOQUE_FOTO;
  if (comentarioImagen) {
    prompt += `\n\nEsta foto ya fue retocada previamente y el reclutador solicitó una corrección. Aplica ÚNICAMENTE lo que indican los siguientes comentarios, exactamente como se indica:\n${comentarioImagen}`;
  }

  const datos = await orGenerarImagen({
    model:          OPENROUTER_MODEL_IMAGEN,
    prompt,
    resolution:     '1K',
    aspect_ratio:   '1:1',
    output_format:  'jpeg',
    input_references: [
      { type: 'image_url', image_url: { url: urlFoto } },
    ],
  });

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

  const { postulacion: postulacionId, vacante: vacanteId, comentarios, respuesta_anterior: respuestaAnterior, imagen: mejorarFoto, imagen_comentario: comentarioImagen } = req.body ?? {};
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
    const urlCurriculum  = attrs.resume ?? null;

    if (!urlFoto) {
      console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'candidato sin foto de perfil', postulacion_id: postulacionId }));
      return res.status(422).json({ error: 'El candidato no tiene foto de perfil' });
    }

    const datosVacante   = await ttObtener(`/jobs/${vacanteId}?include=user`, true);
    const nombreInterno  = extraerNombreInterno(datosVacante);
    const nombreReclutador = extraerNombreReclutador(datosVacante);

    const respuestasCrudas = await obtenerRespuestasCandidato(candidatoId);
    const respuestasPorId  = parsearRespuestas(respuestasCrudas);

    console.log(JSON.stringify({ etapa: 'analisis_ia', candidato: nombreCompleto, vacante: nombreInterno }));
    const analisis = await obtenerAnalisisEstructurado(respuestasPorId, nombreCompleto, nombreInterno, comentarios, respuestaAnterior);

    let fotoFinal = urlFoto;
    if (mejorarFoto) {
      console.log(JSON.stringify({ etapa: 'retoque_foto', candidato: nombreCompleto, postulacion_id: postulacionId }));
      fotoFinal = await retocarFoto(urlFoto, candidatoId, comentarioImagen);
    }

    const camposSimples = mapearCamposSimples(analisis, {
      FOTO: fotoFinal,
    });

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato: nombreCompleto, postulacion_id: postulacionId }));

    return res.status(200).json({
      simple:        camposSimples,
      trayectoria:   analisis.trayectoria ?? [],
      apego_vacante: analisis.apego_vacante ?? [],
      competencias:  analisis.competencias ?? [],
      ...(urlCurriculum ? { curriculum: urlCurriculum } : {}),
      ...(nombreReclutador ? { reclutador: nombreReclutador } : {}),
    });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}
