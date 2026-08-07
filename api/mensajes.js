import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import PDFDocument           from 'pdfkit';
import { ttObtener, ttCrear, ttSubirArchivoTransitorio, mcCrear } from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { dormir }           from '../lib/evaluacion_postulacion.js';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';
import { TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID } from '../lib/config.js';

const __dirname                      = dirname(fileURLToPath(import.meta.url));
const PROMPT_AGENTE_CONVERSACIONAL   = readFileSync(join(__dirname, '../prompts/agente_conversacional.txt'), 'utf-8');
const OPENROUTER_MODEL               = 'deepseek/deepseek-v4-flash-0731';
const MC_LIMITE_CARACTERES_TEXTO     = 2000;
const LIMITE_REINTENTOS              = 5;
const MAXIMO_PREGUNTAS               = 5;
const DESPLAZAMIENTO_CDMX_MS         = 6 * 60 * 60 * 1000; // Ciudad de México es UTC-6 todo el año
const REGEX_VACANTE                  = /#(\d{6,})/; // los ids de vacante tienen 6+ dígitos; evita falsos positivos con números de calle

const FOTO_PERFIL_DEFAULT      = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';
const FOTO_PERFIL_HOMBRE       = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
const FOTO_PERFIL_MUJER        = 'https://i.ibb.co/6CdjYbv/fotomujer.png';
const IMAGEN_POWERBOT          = 'https://i.ibb.co/Tq2fTbqr/Power-Bot.png';
const IMAGEN_SOLICITUD_COMPLETA = 'https://i.ibb.co/p9vf7QX/Solicitud-completada.png';
const MENSAJE_DESPEDIDA_COMPLETADO = '¡Felicidades! Tu postulación ha sido registrada. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🥳';
const MENSAJE_RECORDATORIO_COMPLETADO = 'Tu postulación ya quedó registrada, una reclutadora te contactará lo más pronto posible 🙂';

const ID_PREGUNTA_NOMBRE    = 'nombre';
const ID_PREGUNTA_DOMICILIO = String(TEAMTAILOR_ADDRESS_QUESTION_ID);
const ID_PREGUNTA_EDAD      = String(TEAMTAILOR_EDAD_QUESTION_ID);
const ID_PREGUNTA_EMPLEO    = String(TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID);

// Preguntas de cajón que siempre van primero, en este orden.
const PREGUNTAS_OBLIGATORIAS_INICIO = [
  { id: ID_PREGUNTA_NOMBRE,    texto: 'Nombre (nombre solo, o nombre y apellidos, cualquiera está bien)', respuesta: '', tipo: 'nombre', enviado: false },
  { id: ID_PREGUNTA_DOMICILIO, texto: 'Domicilio completo: calle, colonia y municipio',                   respuesta: '', tipo: 'text',   enviado: false },
  { id: ID_PREGUNTA_EDAD,      texto: '¿Cuál es tu edad?',                                                respuesta: '', tipo: 'number', enviado: false },
];

// Pregunta de cajón que siempre va al final, después de las específicas de la vacante.
const PREGUNTA_OBLIGATORIA_FIN = {
  id: ID_PREGUNTA_EMPLEO,
  texto: 'Último(s) empleo(s): empresa, puesto y actividades (con 1 empleo es suficiente, 2 es lo ideal)',
  respuesta: '',
  tipo: 'text',
  enviado: false,
};

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
        genero: {
          type:        'string',
          enum:        ['Hombre', 'Mujer', 'ninguno'],
          description: 'Género del candidato según su nombre, solo con alta confianza según uso común en México. "ninguno" si es dudoso, unisex o el nombre aún no se conoce.',
        },
        preguntas: {
          type:        'array',
          description: 'TODAS las preguntas de postulación, con la respuesta más completa conocida hasta ahora.',
          items: {
            type: 'object',
            properties: {
              id:        { type: 'string', description: 'id de la pregunta, tal como se recibió.' },
              respuesta: { type: 'string', description: 'Respuesta del candidato. Cadena vacía si aún no se conoce.' },
            },
            required: ['id', 'respuesta'],
          },
        },
      },
      required: ['mensaje', 'genero', 'preguntas'],
    },
  },
};

// ============================================================================
// HELPERS — Tiempo
// ============================================================================

function timestampCdmx() {
  return new Date(Date.now() - DESPLAZAMIENTO_CDMX_MS).toISOString().replace('Z', '-06:00');
}

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
    .insert({ telefono, creado: timestampCdmx() })
    .select()
    .single();
  if (errorInsercion) throw errorInsercion;
  return creado;
}

async function agregarMensajeConversacion(supabase, fila, actor, texto, { actualizarTimestamp = false } = {}) {
  const linea = `[${timestampCdmx()}] ${actor}: ${texto}`;
  const conversacion = fila.conversacion ? `${fila.conversacion}\n${linea}` : linea;

  const cambios = { conversacion };
  if (actualizarTimestamp) cambios.actualizado = timestampCdmx();

  const { error } = await supabase.from('chatbot').update(cambios).eq('id', fila.id);
  if (error) console.log(JSON.stringify({ etapa: 'supabase_conversacion', estado: 'error', mensaje: error.message, actor }));

  Object.assign(fila, cambios);
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

async function enviarImagenWhatsApp(idSuscriptor, url) {
  await mcCrear('/fb/sending/sendContent', {
    subscriber_id: idSuscriptor,
    data: {
      version: 'v2',
      content: {
        type:          'whatsapp',
        messages:      [{ type: 'image', url }],
        actions:       [],
        quick_replies: [],
      },
    },
  });
}

// ============================================================================
// HELPERS — TeamTailor: candidato / postulación / respuestas
// ============================================================================

async function crearPostulacionTeamTailor(candidatoId, idVacante) {
  await ttCrear('/job-applications', {
    data: {
      type:       'job-applications',
      attributes: { sourced: true },
      relationships: {
        candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
        job:       { data: { id: idVacante.toString(),   type: 'jobs'       } },
      },
    },
  });
}

async function crearCandidatoTeamTailor(nombre, genero, telefono, idVacante) {
  const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  const respuestaCandidato = await ttCrear('/candidates', {
    data: {
      type: 'candidates',
      attributes: {
        'first-name':    nombre,
        'sourced':       true,
        'referring-url': 'WhatsApp',
        'phone':         telefono,
        'picture':       fotoPerfil,
      },
    },
  });
  const candidatoId = Number(respuestaCandidato.data.id);

  await crearPostulacionTeamTailor(candidatoId, idVacante);

  return candidatoId;
}

function quitarEmojis(texto) {
  return texto.replace(/[\p{Extended_Pictographic}️‍]/gu, '');
}

function generarPdfConversacion(conversacion) {
  return new Promise((resolve, reject) => {
    const documento = new PDFDocument({ margin: 40 });
    const bloques = [];
    documento.on('data', bloque => bloques.push(bloque));
    documento.on('end', () => resolve(Buffer.concat(bloques)));
    documento.on('error', reject);

    documento.fontSize(16).text('Conversación', { underline: true });
    documento.moveDown();
    documento.fontSize(10).text(quitarEmojis(conversacion || '(sin mensajes)'));
    documento.end();
  });
}

async function subirConversacionTeamTailor(candidatoId, conversacion) {
  const fecha = timestampCdmx().slice(0, 10);
  const nombreArchivo = `Conversacion ${fecha}.pdf`;

  const bufferPdf = await generarPdfConversacion(conversacion);
  const archivoTransitorio = await ttSubirArchivoTransitorio(bufferPdf, nombreArchivo, 'application/pdf', true);
  const uriTransitoria = archivoTransitorio?.uri;
  if (!uriTransitoria) throw new Error('TeamTailor no devolvió una URI transitoria válida');

  await ttCrear('/uploads', {
    data: {
      type:       'uploads',
      attributes: { url: uriTransitoria, 'file-name': nombreArchivo },
      relationships: {
        candidate: { data: { type: 'candidates', id: candidatoId.toString() } },
      },
    },
  }, true);
}

async function enviarRespuestaTeamTailor(candidatoId, item) {
  const atributo = item.tipo === 'number' ? { number: parseInt(item.respuesta, 10) } : { text: item.respuesta };

  await ttCrear('/answers', {
    data: {
      type:       'answers',
      attributes: atributo,
      relationships: {
        candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
        question:  { data: { id: item.id.toString(),     type: 'questions'  } },
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
  return preguntas.slice(0, MAXIMO_PREGUNTAS).map(p => ({ id: String(p.id), texto: p.attributes.title ?? '', respuesta: '', tipo: 'text', enviado: false }));
}

function detectarAvance(itemsAnteriores, itemsNuevos) {
  const respuestaPrevia = new Map(itemsAnteriores.map(p => [p.id, p.respuesta]));
  return itemsNuevos.some(p => p.respuesta && p.respuesta !== respuestaPrevia.get(p.id));
}

function normalizarRespuesta(id, respuesta) {
  if (!respuesta) return '';

  if (id === ID_PREGUNTA_NOMBRE) {
    return respuesta.trim();
  }

  if (id === ID_PREGUNTA_EDAD) {
    const digitos = respuesta.match(/\d{1,3}/);
    return digitos ? digitos[0] : '';
  }

  if (id === ID_PREGUNTA_DOMICILIO) {
    const partes = respuesta.split(',').map(parte => parte.trim()).filter(Boolean);
    return partes.length >= 3 ? respuesta.trim() : '';
  }

  return respuesta.trim();
}

function generarDespedida(nombre) {
  const inicio = nombre ? `${nombre}, gracias` : 'Gracias';
  return `${inicio} por tu tiempo. Una reclutadora se pondrá en contacto contigo lo más pronto posible para continuar con tu proceso.`.slice(0, 250);
}

async function formatearVacanteParaWhatsApp(informacionVacante) {
  try {
    const datos = await orChatCompletion({
      model:     OPENROUTER_MODEL,
      reasoning: { effort: 'low' },
      messages: [
        {
          role:    'system',
          content: 'Reformatea el siguiente texto de una vacante para que se vea bien en WhatsApp: cada título de sección debe llevar negritas usando asteriscos, por ejemplo *Responsabilidades*. No cambies, resumas, traduzcas ni agregues ninguna palabra del contenido original; solo ajusta el formato.',
        },
        { role: 'user', content: informacionVacante },
      ],
    });

    const texto = datos?.choices?.[0]?.message?.content?.trim();
    return texto || informacionVacante;
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'formato_vacante', estado: 'error', mensaje: e.message }));
    return informacionVacante;
  }
}

async function generarRespuestaAgente({ items, conversacion }) {
  const listaPreguntas = items
    .map(p => `- (id ${p.id}) ${p.texto} → ${p.respuesta ? `respondida: "${p.respuesta}"` : 'PENDIENTE'}`)
    .join('\n');

  const prompt = PROMPT_AGENTE_CONVERSACIONAL.replace('{{preguntas}}', listaPreguntas);

  const datos = await orChatCompletion({
    model:       OPENROUTER_MODEL,
    reasoning:   { effort: 'medium' },
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

  await agregarMensajeConversacion(supabase, fila, 'usuario', mensaje, { actualizarTimestamp: true });

  // ── Detección de vacante (#id) — separa vacantes reales de falsos positivos ──
  // (p. ej. "Calle Independencia #123, colonia Centro") sin romper el flujo del chat.
  const coincidencia = mensaje.match(REGEX_VACANTE);
  if (coincidencia) {
    const idVacanteTexto = coincidencia[1];
    const idVacanteNum   = parseInt(idVacanteTexto, 10);

    if (fila.vacante !== idVacanteNum) {
      let datosVacante = null;
      try {
        const respuestaTt = await ttObtener(`/jobs/${idVacanteTexto}`);
        datosVacante = respuestaTt.data.attributes;
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'deteccion_vacante', estado: 'falso_positivo', texto: coincidencia[0], mensaje: e.message }));
      }

      if (datosVacante) {
        console.log(JSON.stringify({ etapa: 'inicio', idSuscriptor, idVacante: idVacanteNum }));

        const informacionVacanteCruda = limpiarHtmlParaWhatsApp(datosVacante.body);
        const informacionVacante      = await formatearVacanteParaWhatsApp(informacionVacanteCruda);
        console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', titulo: datosVacante.title, chars: informacionVacante.length }));

        try {
          await enviarImagenWhatsApp(idSuscriptor, IMAGEN_POWERBOT);
          await agregarMensajeConversacion(supabase, fila, 'agente', '[imagen: PowerBot]');

          const textoInfo = `Aquí tienes la información de la vacante 👇:\n\n${informacionVacante}`;
          await enviarWhatsApp(idSuscriptor, textoInfo);
          await agregarMensajeConversacion(supabase, fila, 'agente', textoInfo);
          console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'ok', idVacante: idVacanteNum }));
        } catch (e) {
          console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
          return res.status(502).json({ ok: false, error: 'ManyChat error' });
        }

        let nuevosItemsVacante = [];
        try {
          nuevosItemsVacante = await extraerPreguntasVacante(idVacanteTexto);
        } catch (e) {
          console.log(JSON.stringify({ etapa: 'teamtailor_preguntas', estado: 'error', mensaje: e.message }));
        }

        // Las preguntas de cajón van al inicio y al final; se conserva lo ya respondido antes.
        const itemsPrevios = fila.preguntas ?? [];
        const conHistorial = p => {
          const previa = itemsPrevios.find(i => i.id === p.id);
          return previa ? { ...p, respuesta: previa.respuesta, enviado: previa.enviado ?? false } : { ...p };
        };
        const inicioConHistorial = PREGUNTAS_OBLIGATORIAS_INICIO.map(conHistorial);
        const finConHistorial    = conHistorial(PREGUNTA_OBLIGATORIA_FIN);

        const esRegreso            = fila.vacante != null;
        const candidatoIdExistente = fila.candidato ?? null;

        // Reutiliza el candidato ya existente en TeamTailor (columna `candidato`)
        // en vez de crear uno nuevo para la misma persona.
        if (esRegreso && candidatoIdExistente) {
          try {
            await crearPostulacionTeamTailor(candidatoIdExistente, idVacanteNum);
            console.log(JSON.stringify({ etapa: 'postulacion_creada', candidato_id: candidatoIdExistente, idVacante: idVacanteNum }));
          } catch (e) {
            console.log(JSON.stringify({ etapa: 'postulacion_creada', estado: 'error', mensaje: e.message }));
          }
        }

        fila.vacante    = idVacanteNum;
        fila.preguntas  = [...inicioConHistorial, ...nuevosItemsVacante, finConHistorial];
        fila.reintentos = 0;
        if (esRegreso) fila.conversacion = null;

        const { error: errorReinicio } = await supabase
          .from('chatbot')
          .update({
            vacante:    fila.vacante,
            preguntas:  fila.preguntas,
            reintentos: 0,
            ...(esRegreso ? { conversacion: null } : {}),
          })
          .eq('id', fila.id);
        if (errorReinicio) console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'error', mensaje: errorReinicio.message }));
        else console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'ok', idVacante: idVacanteNum, preguntas: fila.preguntas.length }));

        if (esRegreso) {
          const quedanPendientes = fila.preguntas.some(item => !item.respuesta);

          if (!quedanPendientes) {
            const avisoAutomatico = 'Ya contamos con tu información, así que llenamos tu postulación de forma automática. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🙂';
            try {
              await enviarWhatsApp(idSuscriptor, avisoAutomatico);
              await agregarMensajeConversacion(supabase, fila, 'agente', avisoAutomatico);
            } catch (e) {
              console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
              return res.status(502).json({ ok: false, error: 'ManyChat error' });
            }

            console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idSuscriptor, automatico: true }));
            return res.status(200).json({ ok: true, vacante: true, automatico: true });
          }

          const avisoTexto = 'Voy a usar los datos que ya nos habías compartido antes. Solo me faltan algunas cosas para tu nueva postulación.';
          try {
            await enviarWhatsApp(idSuscriptor, avisoTexto);
            await agregarMensajeConversacion(supabase, fila, 'agente', avisoTexto);
          } catch (e) {
            console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
          }
        }

        const nombreYaConocido = fila.preguntas.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;
        if (!nombreYaConocido) {
          await dormir(3000);
          const bienvenida = 'Hola, soy PowerBot, un asistente de IA que te ayudará con tu postulación, para comenzar ¿Podrías darme tu nombre? 🙂';
          try {
            await enviarWhatsApp(idSuscriptor, bienvenida);
            await agregarMensajeConversacion(supabase, fila, 'agente', bienvenida);
          } catch (e) {
            console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
            return res.status(502).json({ ok: false, error: 'ManyChat error' });
          }

          console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idSuscriptor, bienvenida: true }));
          return res.status(200).json({ ok: true, vacante: true, bienvenida: true });
        }
      }
    }
  }

  // ── Agente conversacional — solo si ya hay una vacante con preguntas cargadas ──
  const itemsPreguntas = fila.preguntas ?? [];
  if (itemsPreguntas.length === 0) {
    const yaSeHabiaPresentado = (fila.conversacion ?? '').includes('] agente:');
    if (!yaSeHabiaPresentado) {
      const presentacion = 'Hola, soy PowerBot, una inteligencia artificial de PowerBell RH, una agencia de reclutamiento con base en Guadalajara. ¿En qué puedo ayudarte? Un reclutador podrá atenderte lo más pronto posible.';
      try {
        await enviarWhatsApp(idSuscriptor, presentacion);
        await agregarMensajeConversacion(supabase, fila, 'agente', presentacion);
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
        return res.status(502).json({ ok: false, error: 'ManyChat error' });
      }
    }
    console.log(JSON.stringify({ etapa: 'agente', estado: 'omitido', razon: 'sin_preguntas_cargadas', presentacion: !yaSeHabiaPresentado }));
    return res.status(200).json({ ok: true, vacante: !!coincidencia });
  }

  const yaCompletado = itemsPreguntas.every(item => item.respuesta);
  if (yaCompletado) {
    try {
      await enviarWhatsApp(idSuscriptor, MENSAJE_RECORDATORIO_COMPLETADO);
      await agregarMensajeConversacion(supabase, fila, 'agente', MENSAJE_RECORDATORIO_COMPLETADO);
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
      return res.status(502).json({ ok: false, error: 'ManyChat error' });
    }
    console.log(JSON.stringify({ etapa: 'agente', estado: 'completado_recordatorio' }));
    return res.status(200).json({ ok: true, completado: true });
  }

  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    console.log(JSON.stringify({ etapa: 'agente', estado: 'silenciado', reintentos: fila.reintentos }));
    return res.status(200).json({ ok: true, silenciado: true });
  }

  let resultadoAgente;
  try {
    resultadoAgente = await generarRespuestaAgente({
      items:        itemsPreguntas,
      conversacion: fila.conversacion,
    });
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'agente_llm', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ ok: false, error: 'OpenRouter error' });
  }

  const itemsActualizados = itemsPreguntas.map(item => {
    const respuestaCruda = resultadoAgente.preguntas?.find(p => String(p.id) === String(item.id))?.respuesta ?? '';
    const respuestaValidada = normalizarRespuesta(item.id, respuestaCruda);
    return { ...item, respuesta: respuestaValidada || item.respuesta };
  });

  const avanzo           = detectarAvance(itemsPreguntas, itemsActualizados);
  const todasRespondidas = itemsActualizados.every(item => item.respuesta);
  const nuevoReintentos  = avanzo ? 0 : (fila.reintentos ?? 0) + 1;

  let mensajeAgente     = (resultadoAgente.mensaje ?? '').slice(0, 250);
  let reintentosFinales = nuevoReintentos;
  let enviarImagenFinal = null;

  if (todasRespondidas) {
    mensajeAgente     = MENSAJE_DESPEDIDA_COMPLETADO;
    reintentosFinales = 0;
    enviarImagenFinal = IMAGEN_SOLICITUD_COMPLETA;
  } else if (nuevoReintentos >= LIMITE_REINTENTOS) {
    const nombreCandidato = itemsActualizados.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;
    mensajeAgente = generarDespedida(nombreCandidato);
  }

  // ── Sincronización con TeamTailor: alta de candidato/postulación + respuestas ──
  let candidatoId = fila.candidato ?? null;
  const itemNombre = itemsActualizados.find(item => item.id === ID_PREGUNTA_NOMBRE);
  const genero = resultadoAgente.genero && resultadoAgente.genero !== 'ninguno' ? resultadoAgente.genero : null;

  if (!candidatoId && itemNombre?.respuesta && !itemNombre.enviado && fila.vacante) {
    try {
      candidatoId = await crearCandidatoTeamTailor(itemNombre.respuesta, genero, telefono, fila.vacante);
      itemNombre.enviado = true;
      console.log(JSON.stringify({ etapa: 'candidato_creado', candidato_id: candidatoId, idVacante: fila.vacante, genero }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'candidato_creado', estado: 'error', mensaje: e.message }));
    }
  }

  if (candidatoId) {
    for (const item of itemsActualizados) {
      if (item.tipo === 'nombre' || !item.respuesta || item.enviado) continue;
      try {
        await enviarRespuestaTeamTailor(candidatoId, item);
        item.enviado = true;
        console.log(JSON.stringify({ etapa: 'respuesta_teamtailor', estado: 'ok', candidato_id: candidatoId, id_pregunta: item.id }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'respuesta_teamtailor', estado: 'error', id_pregunta: item.id, mensaje: e.message }));
      }
    }
  }

  fila.preguntas  = itemsActualizados;
  fila.candidato  = candidatoId;
  fila.reintentos = reintentosFinales;

  const { error: errorProgreso } = await supabase
    .from('chatbot')
    .update({ preguntas: fila.preguntas, candidato: candidatoId, reintentos: reintentosFinales })
    .eq('id', fila.id);
  if (errorProgreso) console.log(JSON.stringify({ etapa: 'supabase_preguntas', estado: 'error', mensaje: errorProgreso.message }));

  console.log(JSON.stringify({ etapa: 'agente', estado: 'ok', avanzo, todasRespondidas, reintentos: reintentosFinales }));

  if (todasRespondidas && candidatoId) {
    try {
      await subirConversacionTeamTailor(candidatoId, fila.conversacion);
      console.log(JSON.stringify({ etapa: 'conversacion_pdf', estado: 'ok', candidato_id: candidatoId }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'conversacion_pdf', estado: 'error', mensaje: e.message }));
    }
  }

  try {
    if (enviarImagenFinal) {
      await enviarImagenWhatsApp(idSuscriptor, enviarImagenFinal);
      await agregarMensajeConversacion(supabase, fila, 'agente', '[imagen: solicitud completada]');
    }
    await enviarWhatsApp(idSuscriptor, mensajeAgente);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeAgente);
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'manychat_envio', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ ok: false, error: 'ManyChat error' });
  }

  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idSuscriptor }));
  return res.status(200).json({ ok: true, vacante: !!coincidencia, avanzo, todasRespondidas, reintentos: reintentosFinales });
}
