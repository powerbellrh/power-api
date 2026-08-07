import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import { ttObtener, mcCrear } from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';

const __dirname                      = dirname(fileURLToPath(import.meta.url));
const PROMPT_AGENTE_CONVERSACIONAL   = readFileSync(join(__dirname, '../prompts/agente_conversacional.txt'), 'utf-8');
const OPENROUTER_MODEL               = 'deepseek/deepseek-v4-flash-0731';
const MC_LIMITE_CARACTERES_TEXTO     = 2000;
const LIMITE_REINTENTOS              = 3;
const MAXIMO_PREGUNTAS               = 5;

const ACTUALIZAR_PROGRESO_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_progreso',
    description: 'Genera la respuesta para el candidato y registra el estado más reciente de cada pregunta de postulación.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Respuesta a enviar al candidato por WhatsApp. Máximo 250 caracteres.',
        },
        preguntas: {
          type:        'array',
          description: 'TODAS las preguntas de postulación, con la respuesta más completa conocida hasta ahora.',
          items: {
            type: 'object',
            properties: {
              id:        { type: 'integer', description: 'id de la pregunta, tal como se recibió.' },
              respuesta: { type: 'string',  description: 'Respuesta del candidato. Cadena vacía si aún no se conoce.' },
            },
            required: ['id', 'respuesta'],
          },
        },
      },
      required: ['mensaje', 'preguntas'],
    },
  },
};

// ============================================================================
// HELPERS — Supabase
// ============================================================================

async function obtenerOCrearContacto(supabase, telefono) {
  const { data: existente, error: errorConsulta } = await supabase
    .from('chatbot')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle();
  if (errorConsulta) throw errorConsulta;
  if (existente) return existente;

  const { data: creado, error: errorInsercion } = await supabase
    .from('chatbot')
    .insert({ telefono })
    .select()
    .single();
  if (errorInsercion) throw errorInsercion;
  return creado;
}

async function agregarMensajeConversacion(supabase, fila, actor, texto) {
  const linea = `[${new Date().toISOString()}] ${actor}: ${texto}`;
  const conversacion = fila.conversacion ? `${fila.conversacion}\n${linea}` : linea;

  const { error } = await supabase.from('chatbot').update({ conversacion }).eq('id', fila.id);
  if (error) console.log(JSON.stringify({ etapa: 'supabase_conversacion', estado: 'error', mensaje: error.message, actor }));

  fila.conversacion = conversacion;
}

// ============================================================================
// HELPERS — Texto / ManyChat
// ============================================================================

function trocearTexto(texto, limite = MC_LIMITE_CARACTERES_TEXTO) {
  const parrafos = texto.split('\n');
  const bloques = [];
  let actual = '';

  for (const parrafo of parrafos) {
    const candidato = actual ? `${actual}\n${parrafo}` : parrafo;
    if (candidato.length > limite && actual) {
      bloques.push(actual);
      actual = parrafo;
    } else {
      actual = candidato;
    }
  }
  if (actual) bloques.push(actual);

  return bloques;
}

async function enviarWhatsApp(idSuscriptor, texto) {
  await mcCrear('/fb/sending/sendContent', {
    subscriber_id: idSuscriptor,
    data: {
      version: 'v2',
      content: {
        type:          'whatsapp',
        messages:      trocearTexto(texto).map(bloque => ({ type: 'text', text: bloque })),
        actions:       [],
        quick_replies: [],
      },
    },
  });
}

// ============================================================================
// HELPERS — Preguntas de postulación / agente
// ============================================================================

async function extraerPreguntasVacante(idVacante) {
  const respuestaTt = await ttObtener(`/jobs/${idVacante}/questions`);
  const preguntas = (respuestaTt.data ?? []).filter(p => p.attributes['question-type'] === 'Text');
  return preguntas.slice(0, MAXIMO_PREGUNTAS).map(p => ({ id: +p.id, texto: p.attributes.title ?? '', respuesta: '' }));
}

function detectarAvance(itemsAnteriores, itemsNuevos) {
  const respuestaPrevia = new Map(itemsAnteriores.map(p => [p.id, p.respuesta]));
  return itemsNuevos.some(p => !respuestaPrevia.get(p.id) && p.respuesta);
}

async function generarRespuestaAgente({ tituloVacante, descripcionVacante, items, conversacion }) {
  const listaPreguntas = items
    .map(p => `- (id ${p.id}) ${p.texto} → ${p.respuesta ? `respondida: "${p.respuesta}"` : 'PENDIENTE'}`)
    .join('\n');

  const prompt = PROMPT_AGENTE_CONVERSACIONAL
    .replace('{{titulo_vacante}}',     tituloVacante || '(sin título)')
    .replace('{{preguntas}}',          listaPreguntas)
    .replace('{{descripcion_vacante}}', descripcionVacante || '(sin descripción)');

  const datos = await orChatCompletion({
    model:       OPENROUTER_MODEL,
    reasoning:   { effort: 'low' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user',   content: conversacion },
    ],
    tools:       [ACTUALIZAR_PROGRESO_TOOL],
    tool_choice: { type: 'function', function: { name: 'actualizar_progreso' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'actualizar_progreso');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  return typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
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

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  const idSuscriptor = cuerpo?.id;
  const telefono      = cuerpo?.telefono != null ? String(cuerpo.telefono) : null;
  const mensaje        = cuerpo?.mensaje ?? '';

  if (!idSuscriptor || !telefono) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing id or telefono' }));
    return res.status(400).json({ ok: false, error: 'missing id or telefono' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let fila;
  try {
    fila = await obtenerOCrearContacto(supabase, telefono);
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'supabase_contacto', estado: 'error', mensaje: e.message }));
    return res.status(500).json({ ok: false, error: 'Supabase error' });
  }

  await agregarMensajeConversacion(supabase, fila, 'usuario', mensaje);

  // ── Detección de vacante (#id) — envía la info completa y reinicia el progreso ──
  const coincidencia = mensaje.match(/#(\d+)/);
  if (coincidencia) {
    const idVacante = coincidencia[1];
    console.log(JSON.stringify({ etapa: 'inicio', idSuscriptor, idVacante }));

    let datosVacante;
    try {
      const respuestaTt = await ttObtener(`/jobs/${idVacante}`);
      datosVacante = respuestaTt.data.attributes;
    } catch (e) {
      const mensajeError = e?.message ?? '';
      if (mensajeError.includes('404')) {
        console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'not_found', idVacante }));
        return res.status(200).json({ ok: false, error: 'job not found' });
      }
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: mensajeError }));
      return res.status(502).json({ ok: false, error: 'TeamTailor error' });
    }

    const informacionVacante = limpiarHtmlParaWhatsApp(datosVacante.body);
    console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', titulo: datosVacante.title, chars: informacionVacante.length }));

    try {
      await enviarWhatsApp(idSuscriptor, informacionVacante);
      await agregarMensajeConversacion(supabase, fila, 'agente', informacionVacante);
      console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'ok', idVacante }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
      return res.status(502).json({ ok: false, error: 'ManyChat error' });
    }

    let itemsPreguntas = [];
    try {
      itemsPreguntas = await extraerPreguntasVacante(idVacante);
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'teamtailor_preguntas', estado: 'error', mensaje: e.message }));
    }

    fila.preguntas  = { id_vacante: idVacante, titulo: datosVacante.title, descripcion: informacionVacante, items: itemsPreguntas };
    fila.reintentos = 0;

    const { error: errorReinicio } = await supabase
      .from('chatbot')
      .update({ preguntas: fila.preguntas, reintentos: 0 })
      .eq('id', fila.id);
    if (errorReinicio) console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'error', mensaje: errorReinicio.message }));
    else console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'ok', idVacante, preguntas: itemsPreguntas.length }));
  }

  // ── Agente conversacional — solo si ya hay una vacante con preguntas cargadas ──
  const itemsPreguntas = fila.preguntas?.items ?? [];
  if (itemsPreguntas.length === 0) {
    console.log(JSON.stringify({ etapa: 'agente', estado: 'omitido', razon: 'sin_preguntas_cargadas' }));
    return res.status(200).json({ ok: true, vacante: !!coincidencia });
  }

  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    console.log(JSON.stringify({ etapa: 'agente', estado: 'silenciado', reintentos: fila.reintentos }));
    return res.status(200).json({ ok: true, silenciado: true });
  }

  let resultadoAgente;
  try {
    resultadoAgente = await generarRespuestaAgente({
      tituloVacante:      fila.preguntas.titulo,
      descripcionVacante: fila.preguntas.descripcion,
      items:              itemsPreguntas,
      conversacion:       fila.conversacion,
    });
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'agente_llm', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ ok: false, error: 'OpenRouter error' });
  }

  const avanzo        = detectarAvance(itemsPreguntas, resultadoAgente.preguntas ?? []);
  const nuevoReintentos = avanzo ? 0 : (fila.reintentos ?? 0) + 1;

  const itemsActualizados = itemsPreguntas.map(item => {
    const actualizado = resultadoAgente.preguntas?.find(p => p.id === item.id);
    return { ...item, respuesta: actualizado?.respuesta || item.respuesta };
  });

  fila.preguntas  = { ...fila.preguntas, items: itemsActualizados };
  fila.reintentos = nuevoReintentos;

  const { error: errorProgreso } = await supabase
    .from('chatbot')
    .update({ preguntas: fila.preguntas, reintentos: nuevoReintentos })
    .eq('id', fila.id);
  if (errorProgreso) console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'error', mensaje: errorProgreso.message }));

  console.log(JSON.stringify({ etapa: 'agente', estado: 'ok', avanzo, reintentos: nuevoReintentos }));

  const mensajeAgente = (resultadoAgente.mensaje ?? '').slice(0, 250);
  try {
    await enviarWhatsApp(idSuscriptor, mensajeAgente);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeAgente);
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ ok: false, error: 'ManyChat error' });
  }

  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idSuscriptor }));
  return res.status(200).json({ ok: true, vacante: !!coincidencia, avanzo, reintentos: nuevoReintentos });
}
