import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { timestampMexico } from '../lib/historial_utils.js';
import { mcCrear, ttObtener, ttCrear } from '../lib/clientes_api.js';
import { aplicarNombreCandidato } from '../lib/candidato_nombre.js';

const CAMPO_MANYCHAT_RESPUESTA = '14779615';
const MAX_TURNOS_DESPERDICIADOS = 5;
const TEAMTAILOR_BOT_USER_ID = +process.env.AD_TEAMTAILOR_BOT_USER_ID;

// Datos que siempre se piden primero, en este orden, antes de las preguntas
// propias de la vacante en TeamTailor. Domicilio y Edad usan preguntas fijas
// de TeamTailor (no dependen de la vacante); Edad se manda como "number".
const CAMPO_NOMBRE    = 'Nombre completo';
const CAMPO_DOMICILIO = 'Domicilio';
const CAMPO_EDAD      = 'Edad';

const TEAMTAILOR_ADDRESS_QUESTION_ID = 73101; // pregunta "Domicilio" en TeamTailor
const TEAMTAILOR_AGE_QUESTION_ID     = 70845; // pregunta "Edad" en TeamTailor (tipo number)

const CAMPOS_FIJOS = [
  { titulo: CAMPO_NOMBRE },
  { titulo: CAMPO_DOMICILIO, id: TEAMTAILOR_ADDRESS_QUESTION_ID },
  { titulo: CAMPO_EDAD,      id: TEAMTAILOR_AGE_QUESTION_ID, numero: true },
];

const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';

const lineaHistorial = (rol, mensaje) => `${timestampMexico(new Date().toISOString())} - ${rol}: ${mensaje}`;

const limpiarBloqueCodigo = (texto) => texto.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();

const normalizarTexto = (texto) => (texto || '').trim().toLowerCase();

async function subirRespuestasATeamtailor(respuestasNuevas, candidatoId, preguntasVacante) {
  if (!Array.isArray(respuestasNuevas) || respuestasNuevas.length === 0 || !candidatoId) return;

  await Promise.allSettled(respuestasNuevas.map(async ({ pregunta, respuesta, genero }) => {
    // El nombre no se guarda como answer/note: actualiza directamente el
    // candidato en TeamTailor (first-name + foto de perfil por género).
    // El género ya viene resuelto por el modelo conversacional, así que no
    // hace falta una llamada adicional a Claude (evita latencia extra).
    if (normalizarTexto(pregunta) === normalizarTexto(CAMPO_NOMBRE)) {
      try {
        const resultado = await aplicarNombreCandidato(candidatoId, respuesta, genero);
        console.log(JSON.stringify({ etapa: 'candidato_nombre', estado: 'ok', candidato_id: candidatoId, ...resultado }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'candidato_nombre', estado: 'error', candidato_id: candidatoId, mensaje: e.message }));
      }
      return;
    }

    const preguntaTt = preguntasVacante.find(p => normalizarTexto(p.titulo) === normalizarTexto(pregunta));

    try {
      if (preguntaTt?.id) {
        const atributo = preguntaTt.numero ? { number: parseInt(respuesta, 10) } : { text: respuesta };

        await ttCrear('/answers', {
          data: {
            type: 'answers',
            attributes: atributo,
            relationships: {
              candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
              question:  { data: { id: preguntaTt.id.toString(), type: 'questions' } },
            },
          },
        });
        console.log(JSON.stringify({ etapa: 'teamtailor_answer', estado: 'ok', candidato_id: candidatoId, pregunta_id: preguntaTt.id }));
      } else {
        await ttCrear('/notes', {
          data: {
            type: 'notes',
            attributes: { note: `${pregunta}: ${respuesta}` },
            relationships: {
              candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
              ...(TEAMTAILOR_BOT_USER_ID && { user: { data: { id: TEAMTAILOR_BOT_USER_ID, type: 'users' } } }),
            },
          },
        });
        console.log(JSON.stringify({ etapa: 'teamtailor_nota', estado: 'ok', candidato_id: candidatoId, pregunta }));
      }
    } catch (e) {
      console.log(JSON.stringify({ etapa: preguntaTt?.id ? 'teamtailor_answer' : 'teamtailor_nota', estado: 'error', candidato_id: candidatoId, pregunta, mensaje: e.message }));
    }
  }));
}

async function obtenerPreguntasVacante(vacanteId) {
  try {
    const respuestaTt = await ttObtener(`/jobs/${vacanteId}/questions`);
    const preguntasVacante = (respuestaTt.data ?? [])
      .filter(p => p.attributes['question-type'] === 'Text')
      .map(p => ({ id: +p.id, titulo: p.attributes.title ?? '' }))
      .filter(p => !CAMPOS_FIJOS.some(fijo => normalizarTexto(fijo.titulo) === normalizarTexto(p.titulo)));

    return [...CAMPOS_FIJOS, ...preguntasVacante];
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'teamtailor_preguntas', estado: 'error', vacante_id: vacanteId, mensaje: e.message }));
    return CAMPOS_FIJOS;
  }
}

// campos_requeridos guarda el JSON de [{id, titulo}] de las preguntas de TeamTailor;
// se parsea para mapear respuestas a su id y se muestra al modelo solo como texto de títulos.
function parsearPreguntas(campoRequeridosCrudo) {
  if (!campoRequeridosCrudo) return [];
  try {
    const parseado = JSON.parse(campoRequeridosCrudo);
    return Array.isArray(parseado) ? parseado : [];
  } catch {
    return [];
  }
}

const preguntasComoTexto = (preguntasVacante) => preguntasVacante.map(p => p.titulo).join('\n');

const aTextoLegible = (valor) => {
  if (typeof valor === 'string') return valor;
  if (valor && typeof valor === 'object') {
    return Object.entries(valor).map(([campo, dato]) => `${campo}: ${dato}`).join('; ');
  }
  return '';
};

const ESQUEMA_RESPUESTA = {
  name: 'respuesta_chatbot',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      respuesta: {
        type: 'string',
        description: 'Mensaje que se envía a la persona por WhatsApp.',
      },
      campos_recopilados: {
        type: 'string',
        description: 'Estado ACUMULADO de todos los datos recopilados hasta ahora (incluye los previos más los nuevos de este mensaje), en texto libre legible, ej: "nombre: Juan Pérez; domicilio: pendiente".',
      },
      campos_faltantes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista de los datos de DATOS A RECOPILAR que todavía no se tienen.',
      },
      turno_desperdiciado: {
        type: 'boolean',
        description: 'true si en este mensaje la persona solo hizo preguntas o comentarios sin aportar ningún dato nuevo de DATOS A RECOPILAR; false si aportó al menos un dato nuevo.',
      },
      respuestas_nuevas: {
        type: 'array',
        description: 'Datos de DATOS A RECOPILAR que se obtuvieron NUEVOS en este mensaje (no los que ya estaban en DATOS YA RECOPILADOS). Vacío si no se obtuvo nada nuevo.',
        items: {
          type: 'object',
          properties: {
            pregunta: { type: 'string', description: 'El texto EXACTO, tal cual aparece en DATOS A RECOPILAR, del dato que se obtuvo.' },
            respuesta: { type: 'string', description: 'La respuesta que dio la persona para ese dato.' },
            genero: {
              type: 'string',
              enum: ['Hombre', 'Mujer', 'ninguno'],
              description: 'SOLO cuando "pregunta" es "Nombre completo": el género que indica el nombre según uso común en México ("ninguno" si es unisex o ambiguo). Para cualquier otra pregunta, usa siempre "ninguno".',
            },
          },
          required: ['pregunta', 'respuesta', 'genero'],
          additionalProperties: false,
        },
      },
    },
    required: ['respuesta', 'campos_recopilados', 'campos_faltantes', 'turno_desperdiciado', 'respuestas_nuevas'],
    additionalProperties: false,
  },
};

const construirPromptSistema = (vacanteInfo, camposRequeridos, camposRecopilados) => `Eres el agente virtual de Powerbell, una agencia de recursos humanos y reclutamiento en Guadalajara. Atiendes por WhatsApp a personas interesadas en una vacante.

CONTEXTO IMPORTANTE: la conversación que ves en el historial NO es el inicio real. Antes de esto, la persona YA fue saludada, YA se le presentó Powerbell y YA se le presentó la vacante (sueldo, horario, prestaciones, etc.) en pantallas previas que no aparecen en este historial. Por lo tanto NUNCA vuelvas a presentarte, ni a Powerbell, ni a repetir la descripción de la vacante como si fuera la primera vez, y no le pidas confirmar interés en la vacante ni en el sueldo otra vez: continúa la conversación de forma natural exactamente desde donde la dejó el último mensaje del historial.

INFORMACIÓN VERÍDICA DE LA VACANTE (única fuente permitida si te preguntan algo puntual sobre ella):
${vacanteInfo || 'Sin información disponible por el momento.'}

DATOS A RECOPILAR DE LA PERSONA:
${camposRequeridos || 'nombre completo y domicilio'}

DATOS YA RECOPILADOS:
${camposRecopilados || 'Ninguno todavía.'}

TAREAS, EN ORDEN DE PRIORIDAD:
1. Ve directo a pedir el siguiente dato pendiente de la lista de arriba, seas cual sea el punto de la conversación. No hagas plática de relleno sobre si le interesa la vacante o el sueldo: eso ya se resolvió antes.
2. Si te preguntan algo puntual sobre la vacante, la postulación o Powerbell, respóndelo ÚNICAMENTE con datos que puedas respaldar directamente con la información de la vacante que se te dio. Nunca inventes, asumas ni completes datos que no estén ahí.
3. Si te preguntan algo sobre la vacante, la postulación o Powerbell que NO esté cubierto en la información disponible, dile a la persona que un agente de Powerbell le va a llamar para resolver esa duda, y continúa la conversación con normalidad.
4. Si te preguntan algo que no tiene relación con la vacante, la postulación o Powerbell, indica amablemente que solo puedes ayudar con esos temas.
5. Tu objetivo principal en todo momento es recopilar los datos pendientes de la lista de arriba. Sin importar el tema de la respuesta, siempre debes cerrar el mensaje encaminando la conversación de vuelta a pedir el dato que falte.

REGLAS DE ESTILO (aplican al campo "respuesta", que se envía tal cual a WhatsApp):
- Máximo 200 caracteres. Sé breve y directo, sin relleno.
- Habla como un reclutador mexicano de verdad: cordial, profesional, amable y al punto. Nada de sonar robótico, acartonado o burocrático.
- Tono amistoso pero formal.
- Mensajes cortos, tipo conversación de WhatsApp, no bloques largos de texto.
- No uses markdown ni HTML. Puedes usar *negritas* o _itálicas_ en formato de WhatsApp solo si realmente aporta claridad, y con moderación.
- Nunca uses listas con guiones, numeración ni encabezados.
- Termina siempre el mensaje con un emoji que corresponda al contenido o tono de la respuesta.

FORMATO DE SALIDA:
Debes devolver únicamente el objeto JSON que exige el esquema, con estos cinco campos:
- "respuesta": el mensaje para la persona, siguiendo las reglas de estilo de arriba.
- "campos_recopilados": el estado ACUMULADO de todos los datos que ya se tienen (los de antes más lo nuevo que hayas extraído en este mensaje), no solo lo de este turno.
- "campos_faltantes": los datos de "DATOS A RECOPILAR" que aún no tienes.
- "turno_desperdiciado": true si en este mensaje la persona SOLO hizo preguntas o comentarios y NO aportó ningún dato nuevo de la lista de DATOS A RECOPILAR; false si aportó al menos un dato nuevo.
- "respuestas_nuevas": SOLO los datos que se obtuvieron POR PRIMERA VEZ en este mensaje (no repitas los que ya estaban en DATOS YA RECOPILADOS), usando en "pregunta" el texto EXACTO tal cual aparece en DATOS A RECOPILAR. Cuando "pregunta" sea "Nombre completo", en "respuesta" pon únicamente el nombre de pila (y segundo nombre si lo dice) capitalizado de forma estándar, sin apellidos, saludos ni relleno ("Mi nombre es", "Soy", "Me llamo", emojis); y en "genero" indica "Hombre" o "Mujer" solo si el nombre lo sugiere con alta confianza, o "ninguno" si es unisex o ambiguo (ej. Guadalupe, Cruz, Alex) — nunca inventes el género para quedar bien. Para cualquier otra "pregunta", "genero" siempre es "ninguno".`;

async function procesarMensaje(mensaje, manychat, supabase) {
  try {
    const { data: registro, error: errorBusqueda } = await supabase
      .from('chatbot')
      .select('historial_mensajes, vacante_info, campos_requeridos, campos_recopilados, turnos_desperdiciados, candidato_id, vacante_id')
      .eq('manychat_id', manychat)
      .maybeSingle();

    if (errorBusqueda) throw new Error(`Supabase select failed: ${errorBusqueda.message}`);

    const historialPrevio = registro?.historial_mensajes || '';
    const tieneTurnoUsuario = /- usuario: /.test(historialPrevio);

    let preguntasVacante = parsearPreguntas(registro?.campos_requeridos);

    if (preguntasVacante.length === 0 && !tieneTurnoUsuario && registro?.vacante_id) {
      preguntasVacante = await obtenerPreguntasVacante(registro.vacante_id);

      const { error: errorPreguntas } = await supabase
        .from('chatbot')
        .update({ campos_requeridos: JSON.stringify(preguntasVacante) })
        .eq('manychat_id', manychat);
      if (errorPreguntas) console.log(JSON.stringify({ etapa: 'teamtailor_preguntas', estado: 'error_guardado', manychat, mensaje: errorPreguntas.message }));
    }

    const historialConUsuario = historialPrevio
      ? `${historialPrevio}\n${lineaHistorial('usuario', mensaje)}`
      : lineaHistorial('usuario', mensaje);

    const promptSistema = construirPromptSistema(
      registro?.vacante_info,
      preguntasComoTexto(preguntasVacante),
      registro?.campos_recopilados,
    );

    const respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: promptSistema, cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: historialConUsuario },
        ],
        response_format: { type: 'json_schema', json_schema: ESQUEMA_RESPUESTA },
        provider: {
          sort: 'latency',
          zdr: true,
        },
      }),
    });

    const datos = await respuesta.json();

    if (!respuesta.ok) {
      console.log(JSON.stringify({ etapa: 'openrouter', estado: 'error', status: respuesta.status, datos }));
      return;
    }

    const contenidoModelo = datos?.choices?.[0]?.message?.content ?? '';

    let salidaModelo;
    try {
      salidaModelo = JSON.parse(limpiarBloqueCodigo(contenidoModelo));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'openrouter', estado: 'error', mensaje: 'respuesta no es JSON válido', contenidoModelo }));
      salidaModelo = { respuesta: contenidoModelo, campos_recopilados: registro?.campos_recopilados || '', campos_faltantes: [] };
    }

    const respuestaModelo    = salidaModelo.respuesta ?? '';
    const camposRecopilados  = aTextoLegible(salidaModelo.campos_recopilados) || (registro?.campos_recopilados || '');
    const historialFinal     = `${historialConUsuario}\n${lineaHistorial('agente', respuestaModelo)}`;

    const camposFaltantes = Array.isArray(salidaModelo.campos_faltantes) ? salidaModelo.campos_faltantes : [];
    const turnosDesperdiciadosPrevios = registro?.turnos_desperdiciados || 0;
    const turnosDesperdiciados = turnosDesperdiciadosPrevios + (salidaModelo.turno_desperdiciado ? 1 : 0);
    const debeSalir = turnosDesperdiciados >= MAX_TURNOS_DESPERDICIADOS || camposFaltantes.length === 0;
    const respuestaFinal = debeSalir ? 'salida' : respuestaModelo;

    const { error: errorGuardado } = await supabase
      .from('chatbot')
      .upsert({ manychat_id: manychat, historial_mensajes: historialFinal, campos_recopilados: camposRecopilados, turnos_desperdiciados: turnosDesperdiciados });

    if (errorGuardado) throw new Error(`Supabase upsert failed: ${errorGuardado.message}`);

    await subirRespuestasATeamtailor(salidaModelo.respuestas_nuevas, registro?.candidato_id, preguntasVacante);

    await mcCrear('/fb/subscriber/setCustomField', {
      subscriber_id: manychat,
      field_id: CAMPO_MANYCHAT_RESPUESTA,
      field_value: respuestaFinal,
    });

    console.log(JSON.stringify({ etapa: 'completado', estado: 'exito', manychat, mensaje, respuesta: respuestaFinal, campos_faltantes: camposFaltantes, turnos_desperdiciados: turnosDesperdiciados }));
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'error', manychat, mensaje: error.message }));
  }
}

async function procesarInicio(manychat, candidatoId, vacanteId, vacanteInfo, historialInicial, supabase) {
  try {
    const preguntasVacante = await obtenerPreguntasVacante(vacanteId);

    const { error: errorGuardado } = await supabase
      .from('chatbot')
      .upsert({
        manychat_id: manychat,
        candidato_id: candidatoId,
        vacante_id: vacanteId,
        vacante_info: vacanteInfo,
        historial_mensajes: historialInicial,
        campos_requeridos: JSON.stringify(preguntasVacante),
        turnos_desperdiciados: 0,
      });

    if (errorGuardado) throw new Error(`Supabase upsert failed: ${errorGuardado.message}`);

    console.log(JSON.stringify({ etapa: 'completado', estado: 'exito', manychat, candidato_id: candidatoId, vacante_id: vacanteId, preguntas: preguntasVacante.length }));
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'error', manychat, mensaje: error.message }));
  }
}

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

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ── Inicio de conversación: registra candidato/vacante y carga preguntas de TeamTailor ──
  const candidatoId = cuerpo?.candidato_id;
  if (candidatoId && !cuerpo?.mensaje) {
    const manychat = cuerpo?.manychat_id;
    const vacanteId = cuerpo?.vacante_id;

    if (!manychat || !vacanteId) {
      console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing manychat_id or vacante_id' }));
      return res.status(400).json({ ok: false, error: 'missing manychat_id or vacante_id' });
    }

    waitUntil(procesarInicio(manychat, candidatoId, vacanteId, cuerpo?.vacante_info, cuerpo?.historial_mensajes, supabase));

    console.log(JSON.stringify({ etapa: 'request', estado: 'aceptado', tipo: 'inicio', manychat, candidato_id: candidatoId, vacante_id: vacanteId }));
    return res.status(202).json({ ok: true, status: 'processing' });
  }

  const mensaje  = cuerpo?.mensaje;
  const manychat = cuerpo?.manychat;

  if (!mensaje || !manychat) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing mensaje or manychat' }));
    return res.status(400).json({ ok: false, error: 'missing mensaje or manychat' });
  }

  waitUntil(procesarMensaje(mensaje, manychat, supabase));

  console.log(JSON.stringify({ etapa: 'request', estado: 'aceptado', manychat, mensaje }));
  return res.status(202).json({ ok: true, status: 'processing' });
}
