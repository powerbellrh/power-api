import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import PDFDocument           from 'pdfkit';
import { waitUntil }        from '@vercel/functions';
import { ttObtener, ttActualizar, ttCrear, ttSubirArchivoTransitorio, mcCrear } from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { dormir }           from '../lib/evaluacion_postulacion.js';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';
import { TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID } from '../lib/config.js';

const __dirname                      = dirname(fileURLToPath(import.meta.url));
const PROMPT_AGENTE_CONVERSACIONAL   = readFileSync(join(__dirname, '../prompts/agente_conversacional.txt'), 'utf-8');
const PROMPT_AGENTE_GENERAL          = readFileSync(join(__dirname, '../prompts/agente_general.txt'), 'utf-8');
const OPENROUTER_MODEL               = 'deepseek/deepseek-v4-flash-0731';
const LIMITE_REINTENTOS              = 5;
const MAXIMO_PREGUNTAS               = 5;
const DESPLAZAMIENTO_CDMX_MS         = 6 * 60 * 60 * 1000; // Ciudad de México es UTC-6 todo el año
const REGEX_VACANTE                  = /#(\d{6,})/; // los ids de vacante tienen 6+ dígitos; evita falsos positivos con números de calle
const REGEX_BAJA                     = /\bbaja\b/i; // palabra usada para solicitar la eliminación de datos
const MENSAJE_IRRESPONSIVO           = 'Irresponsivo'; // valor fijo que manda ManyChat cuando pasa 1h sin respuesta del candidato

const FOTO_PERFIL_DEFAULT      = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';
const FOTO_PERFIL_HOMBRE       = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
const FOTO_PERFIL_MUJER        = 'https://i.ibb.co/6CdjYbv/fotomujer.png';
const URL_CANAL_WHATSAPP = 'https://whatsapp.com/channel/0029VbDRL604NVifiRhMHX3P';
const NOTA_CANAL_WHATSAPP = 'Únete a nuestro canal de WhatsApp para enterarte de otras vacantes que podrían interesarte 👇';
const MENSAJE_DESPEDIDA_COMPLETADO = `¡Felicidades! Tu postulación ha sido registrada. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🥳\n\n${NOTA_CANAL_WHATSAPP}\n${URL_CANAL_WHATSAPP}`;
const MENSAJE_RECORDATORIO_COMPLETADO = 'Tu postulación ya quedó registrada, una reclutadora te contactará lo más pronto posible 🙂';
const MENSAJE_FALLBACK_ERROR = 'Tuvimos un problema para procesar tu mensaje, ¿podrías escribirlo de nuevo?';
const MENSAJE_LIMITE_PREGUNTAS_GENERALES = 'Para dudas más específicas, una reclutadora podrá ayudarte con más detalle 🙂';

// Mensaje que ManyChat manda automáticamente 1s después del primer mensaje del
// candidato (incluye saludo y consentimiento de privacidad); no lo enviamos
// nosotros, pero se registra en la conversación para mantener el historial completo.
const MENSAJE_BIENVENIDA_MANYCHAT = 'Hola 👋 Soy PowerBot, una IA de PowerBell RH.\n\nUsamos tu número y los datos que nos compartas para completar tu postulación a esta vacante. Puedes consultar nuestro aviso de privacidad presionando el boton de abajo 👇\n\n_Si prefieres eliminar tu información, puedes escribir BAJA en cualquier momento 😊_\n\nhttps://careers.powerbellrh.com/privacy-policy';

const URL_VACANTES = 'https://talento.powerbellrh.com/';
const NOTA_VACANTES = 'Puedes checar nuestras vacantes activas con el siguiente enlace 👇';

const FLOW_NS_RESPUESTA          = 'content20260807162104_695716';
const ID_CAMPO_MENSAJE_CANDIDATO = 14851295;

const ID_PREGUNTA_NOMBRE    = 'nombre';
const ID_PREGUNTA_DOMICILIO = String(TEAMTAILOR_ADDRESS_QUESTION_ID);
const ID_PREGUNTA_EDAD      = String(TEAMTAILOR_EDAD_QUESTION_ID);
const ID_PREGUNTA_EMPLEO    = String(TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID);

// Preguntas de cajón que siempre van primero, en este orden.
const PREGUNTAS_OBLIGATORIAS_INICIO = [
  { id: ID_PREGUNTA_NOMBRE,    texto: 'Nombre (nombre solo, o nombre y apellidos, cualquiera está bien)', respuesta: '', tipo: 'nombre', enviado: false },
  { id: ID_PREGUNTA_DOMICILIO, texto: 'Domicilio completo: calle, colonia y municipio',                   respuesta: '', tipo: 'text',   enviado: false },
  { id: ID_PREGUNTA_EDAD,      texto: '¿Cuál es tu edad?', respuesta: '', tipo: 'number', enviado: false },
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

// El teléfono se guarda desde el primer mensaje (el consentimiento de privacidad ya
// se resuelve del lado de ManyChat antes de llegar aquí), así que la fila se puede
// localizar por `telefono` o por `manychat` (id de suscriptor) indistintamente.
async function obtenerOCrearContacto(supabase, idSuscriptor, telefono) {
  const { data: porTelefono, error: errorPorTelefono } = await supabase
    .from('chatbot')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle();
  if (errorPorTelefono) throw errorPorTelefono;
  if (porTelefono) return { fila: porTelefono, esNuevo: false };

  const { data: porSuscriptor, error: errorPorSuscriptor } = await supabase
    .from('chatbot')
    .select('*')
    .eq('manychat', idSuscriptor)
    .maybeSingle();
  if (errorPorSuscriptor) throw errorPorSuscriptor;
  if (porSuscriptor) {
    if (porSuscriptor.telefono) return { fila: porSuscriptor, esNuevo: false };

    const { data: actualizado, error: errorTelefono } = await supabase
      .from('chatbot')
      .update({ telefono })
      .eq('id', porSuscriptor.id)
      .select()
      .single();
    if (errorTelefono) throw errorTelefono;
    return { fila: actualizado, esNuevo: false };
  }

  const { data: creado, error: errorInsercion } = await supabase
    .from('chatbot')
    .insert({ manychat: idSuscriptor, telefono, creado: timestampCdmx() })
    .select()
    .single();
  if (errorInsercion) throw errorInsercion;
  return { fila: creado, esNuevo: true };
}

// Registra en Supabase el momento en que el candidato pidió eliminar sus datos
// (palabra clave "BAJA", en cualquier contexto del mensaje).
async function registrarSolicitudEliminacion(supabase, fila, log) {
  if (fila.solicitud_eliminacion) return;

  const ahora = timestampCdmx();
  const { error } = await supabase.from('chatbot').update({ solicitud_eliminacion: ahora }).eq('id', fila.id);
  if (error) {
    log('supabase_baja', { estado: 'error', error: error.message });
    return;
  }

  fila.solicitud_eliminacion = ahora;
  log('supabase_baja', { estado: 'ok' });
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

// Guarda la respuesta de la IA en el campo personalizado "Mensaje para el candidato"
// y dispara el flujo de ManyChat que se lo muestra al candidato (imágenes y botones
// del flujo ya están definidos del lado de ManyChat).
async function enviarRespuestaCandidato(idSuscriptor, texto) {
  await mcCrear('/fb/subscriber/setCustomField', {
    subscriber_id: idSuscriptor,
    field_id:      ID_CAMPO_MENSAJE_CANDIDATO,
    field_value:   texto,
  });
  await mcCrear('/fb/sending/sendFlow', {
    subscriber_id: idSuscriptor,
    flow_ns:       FLOW_NS_RESPUESTA,
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

// Crea el candidato en TeamTailor desde el primer mensaje, antes de conocer su
// nombre o la vacante: usa el teléfono como nombre y la foto default, igual que
// el script de migración de candidatos rezagados.
async function crearCandidatoTeamTailorTemprano(telefono) {
  const respuestaCandidato = await ttCrear('/candidates', {
    data: {
      type: 'candidates',
      attributes: {
        'first-name':    telefono,
        'sourced':       true,
        'referring-url': 'WhatsApp',
        'phone':         telefono,
        'picture':       FOTO_PERFIL_DEFAULT,
      },
    },
  });
  return Number(respuestaCandidato.data.id);
}

// Actualiza el nombre y la foto de un candidato ya creado en TeamTailor una vez
// que el candidato confirma su nombre (y, de paso, su género aproximado).
async function actualizarCandidatoTeamTailor(candidatoId, nombre, genero) {
  const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  await ttActualizar(`/candidates/${candidatoId}`, {
    data: {
      type:       'candidates',
      id:         candidatoId.toString(),
      attributes: { 'first-name': nombre, 'picture': fotoPerfil },
    },
  });
}

function esRegistroNoEncontrado(e) {
  return /404/.test(e.message) && /Record not found/i.test(e.message);
}

// Si el candidato ya no existe en TeamTailor (p. ej. se borró manualmente),
// lo vuelve a crear con los datos que ya tenemos y reintenta la operación una vez.
async function conCandidatoValido(candidatoIdActual, ejecutar, { nombre, genero, telefono, idVacante, log }) {
  try {
    return { candidatoId: candidatoIdActual, resultado: await ejecutar(candidatoIdActual) };
  } catch (e) {
    if (!esRegistroNoEncontrado(e) || !nombre || !idVacante) throw e;

    const nuevoCandidatoId = await crearCandidatoTeamTailor(nombre, genero, telefono, idVacante);
    log('candidato_recreado', { estado: 'ok', candidato_id_anterior: candidatoIdActual, candidato_id: nuevoCandidatoId, idVacante });

    return { candidatoId: nuevoCandidatoId, resultado: await ejecutar(nuevoCandidatoId) };
  }
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
    return partes.length >= 3 ? partes.slice(0, 3).join(', ') : '';
  }

  return respuesta.trim();
}

function generarDespedida(nombre) {
  const inicio = nombre ? `${nombre}, gracias` : 'Gracias';
  return `${inicio} por tu tiempo. Una reclutadora se pondrá en contacto contigo lo más pronto posible para continuar con tu proceso.`.slice(0, 250);
}

async function formatearVacanteParaWhatsApp(informacionVacante, log) {
  try {
    const datos = await orChatCompletion({
      model:     OPENROUTER_MODEL,
      reasoning: { enabled: false },
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
    log('formato_vacante', { estado: 'error', error: e.message });
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

async function generarRespuestaAgenteGeneral(conversacion) {
  const datos = await orChatCompletion({
    model:     OPENROUTER_MODEL,
    reasoning: { effort: 'low' },
    messages: [
      { role: 'system', content: PROMPT_AGENTE_GENERAL },
      { role: 'user',   content: conversacion },
    ],
  });

  const texto = datos?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('OpenRouter no devolvió una respuesta válida');
  return texto.slice(0, 250);
}

// ============================================================================
// HANDLER
// ============================================================================

// Detecta un id de vacante (#123456) en el mensaje, carga/reenvía su información y,
// si es necesario, reinicia las preguntas de postulación. Devuelve `true` cuando ya
// se le respondió por completo al candidato y no debe seguir al agente conversacional
// (p. ej. se le pidió el nombre, o se autocompletó su postulación).
async function detectarYCargarVacante({ supabase, fila, idSuscriptor, telefono, mensaje, log }) {
  // El regex evita falsos positivos con números de calle (p. ej. "Calle Independencia
  // #123, colonia Centro"), ya que los ids de vacante tienen 6+ dígitos.
  const coincidencia = mensaje.match(REGEX_VACANTE);
  if (!coincidencia) return false;

  const idVacanteTexto = coincidencia[1];
  const idVacanteNum   = parseInt(idVacanteTexto, 10);

  let datosVacante = null;
  try {
    const respuestaTt = await ttObtener(`/jobs/${idVacanteTexto}`);
    datosVacante = respuestaTt.data.attributes;
  } catch (e) {
    log('deteccion_vacante', { estado: 'falso_positivo', texto: coincidencia[0], error: e.message });
  }
  if (!datosVacante) return false;

  // Si pide la misma vacante que ya tiene cargada, igual se le vuelve a mandar
  // la info completa (imagen + descripción); solo se evita reiniciar preguntas
  // y volver a crear la postulación cuando es exactamente la misma vacante.
  const esVacanteNueva = fila.vacante !== idVacanteNum;
  log('inicio', { idVacante: idVacanteNum, vacanteNueva: esVacanteNueva });

  // Se lanza en paralelo con el formateo/envío de la info de la vacante: no depende
  // de esos resultados y solo se usa más abajo, así que no hay razón para esperarla.
  const preguntasVacantePromise = esVacanteNueva
    ? extraerPreguntasVacante(idVacanteTexto).catch(e => {
        log('teamtailor_preguntas', { estado: 'error', error: e.message });
        return [];
      })
    : null;

  const informacionVacanteCruda = limpiarHtmlParaWhatsApp(datosVacante.body);
  const informacionVacante      = await formatearVacanteParaWhatsApp(informacionVacanteCruda, log);
  log('teamtailor', { estado: 'ok', titulo: datosVacante.title, chars: informacionVacante.length });

  try {
    const textoInfo = `Aquí tienes la información de la vacante 👇:\n\n${informacionVacante}`;
    await enviarRespuestaCandidato(idSuscriptor, textoInfo);
    await agregarMensajeConversacion(supabase, fila, 'agente', textoInfo);
    log('manychat_envio', { estado: 'ok', idVacante: idVacanteNum });
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return true;
  }

  if (esVacanteNueva) {
    const nuevosItemsVacante = await preguntasVacantePromise;

    // Las preguntas de cajón van al inicio y al final; se conserva lo ya respondido antes.
    const itemsPrevios = fila.preguntas ?? [];
    const conHistorial = p => {
      const previa = itemsPrevios.find(i => i.id === p.id);
      return previa ? { ...p, respuesta: previa.respuesta, enviado: previa.enviado ?? false } : { ...p };
    };
    const inicioConHistorial = PREGUNTAS_OBLIGATORIAS_INICIO.map(conHistorial);
    const finConHistorial    = conHistorial(PREGUNTA_OBLIGATORIA_FIN);

    const esRegreso            = fila.vacante != null;
    let   candidatoIdExistente = fila.candidato ?? null;
    const nombreConocido       = itemsPrevios.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;

    // El candidato se sube a TeamTailor en cuanto se detecta una vacante (nombre =
    // teléfono, foto default), igual que el script de migración de rezagados —
    // que también exige una vacante antes de crear el candidato. Así se evitan
    // candidatos "huérfanos" sin ninguna postulación.
    if (!candidatoIdExistente) {
      try {
        candidatoIdExistente = await crearCandidatoTeamTailorTemprano(telefono);
        fila.candidato = candidatoIdExistente;
        const { error } = await supabase.from('chatbot').update({ candidato: candidatoIdExistente }).eq('id', fila.id);
        if (error) log('supabase_candidato', { estado: 'error', error: error.message });
        log('candidato_creado_temprano', { estado: 'ok', candidato_id: candidatoIdExistente });
      } catch (e) {
        log('candidato_creado_temprano', { estado: 'error', error: e.message });
      }
    }

    // Se postula al candidato a la vacante nueva; si ya no existe en TeamTailor,
    // se recrea con los datos que ya tenemos.
    if (candidatoIdExistente) {
      try {
        const { candidatoId: candidatoIdValido } = await conCandidatoValido(
          candidatoIdExistente,
          id => crearPostulacionTeamTailor(id, idVacanteNum),
          { nombre: nombreConocido || telefono, genero: null, telefono, idVacante: idVacanteNum, log },
        );
        fila.candidato = candidatoIdValido;
        log('postulacion_creada', { estado: 'ok', candidato_id: candidatoIdValido, idVacante: idVacanteNum });
      } catch (e) {
        log('postulacion_creada', { estado: 'error', error: e.message });
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
        candidato:  fila.candidato ?? null,
        ...(esRegreso ? { conversacion: null } : {}),
      })
      .eq('id', fila.id);
    if (errorReinicio) log('supabase_preguntas', { estado: 'error', error: errorReinicio.message });
    else log('supabase_preguntas', { estado: 'ok', idVacante: idVacanteNum, preguntas: fila.preguntas.length });

    if (esRegreso) {
      const quedanPendientes = fila.preguntas.some(item => !item.respuesta);

      if (!quedanPendientes) {
        const avisoAutomatico = `Ya contamos con tu información, así que llenamos tu postulación de forma automática. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🙂\n\n${NOTA_CANAL_WHATSAPP}\n${URL_CANAL_WHATSAPP}`;
        try {
          await enviarRespuestaCandidato(idSuscriptor, avisoAutomatico);
          await agregarMensajeConversacion(supabase, fila, 'agente', avisoAutomatico);
        } catch (e) {
          log('manychat_envio', { estado: 'error', error: e.message });
          return true;
        }

        log('completado', { estado: 'ok', automatico: true });
        return true;
      }

      const avisoTexto = 'Voy a usar los datos que ya nos habías compartido antes. Solo me faltan algunas cosas para tu nueva postulación.';
      try {
        await enviarRespuestaCandidato(idSuscriptor, avisoTexto);
        await agregarMensajeConversacion(supabase, fila, 'agente', avisoTexto);
      } catch (e) {
        log('manychat_envio', { estado: 'error', error: e.message });
      }
    }
  } else {
    // Solicitar de nuevo la info de la vacante también reinicia los reintentos.
    fila.reintentos = 0;
    const { error: errorReintentos } = await supabase.from('chatbot').update({ reintentos: 0 }).eq('id', fila.id);
    if (errorReintentos) log('supabase_preguntas', { estado: 'error', error: errorReintentos.message });
    log('info_reenviada', { estado: 'ok', idVacante: idVacanteNum });
  }

  const nombreYaConocido = fila.preguntas.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;
  if (!nombreYaConocido) {
    await dormir(3000);
    const bienvenida = 'Para comenzar, ¿podrías darme tu nombre? 🙂';
    try {
      await enviarRespuestaCandidato(idSuscriptor, bienvenida);
      await agregarMensajeConversacion(supabase, fila, 'agente', bienvenida);
    } catch (e) {
      log('manychat_envio', { estado: 'error', error: e.message });
      return true;
    }

    log('completado', { estado: 'ok', bienvenida: true });
    return true;
  }

  return false;
}

// Candidato sin vacante cargada (o cuyo flujo de preguntas aún no existe): se
// responden sus dudas generales sobre PowerBell RH con el agente de preguntas
// generales, siempre invitándolo a ver las vacantes activas. Igual que en el
// flujo de postulación, después de 5 reintentos sin avance se corta al LLM y
// se manda una respuesta fija.
async function procesarCandidatoSinVacante({ supabase, fila, idSuscriptor, log }) {
  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    const mensajeLimite = `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${NOTA_VACANTES}\n${URL_VACANTES}`;
    try {
      await enviarRespuestaCandidato(idSuscriptor, mensajeLimite);
      await agregarMensajeConversacion(supabase, fila, 'agente', mensajeLimite);
    } catch (e) {
      log('manychat_envio', { estado: 'error', error: e.message });
      return;
    }
    log('agente_general', { estado: 'limite_reintentos', reintentos: fila.reintentos });
    return;
  }

  let respuestaAgente;
  try {
    respuestaAgente = await generarRespuestaAgenteGeneral(fila.conversacion);
  } catch (e) {
    log('agente_general_llm', { estado: 'error', error: e.message });
    respuestaAgente = MENSAJE_FALLBACK_ERROR;
  }

  const mensajeConEnlace = `${respuestaAgente}\n\n${NOTA_VACANTES}\n${URL_VACANTES}`;
  try {
    await enviarRespuestaCandidato(idSuscriptor, mensajeConEnlace);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeConEnlace);
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return;
  }

  const nuevosReintentos = (fila.reintentos ?? 0) + 1;
  fila.reintentos = nuevosReintentos;
  const { error } = await supabase.from('chatbot').update({ reintentos: nuevosReintentos }).eq('id', fila.id);
  if (error) log('supabase_preguntas', { estado: 'error', error: error.message });

  log('agente_general', { estado: 'ok', reintentos: nuevosReintentos });
}

// Candidato con una vacante y preguntas de postulación cargadas: avanza el flujo de
// preguntas con el agente conversacional y sincroniza el progreso con TeamTailor.
export async function procesarCandidatoConVacante({ supabase, fila, idSuscriptor, telefono, log }) {
  const itemsPreguntas = fila.preguntas;

  // Postulación ya completada: responde sus dudas con el agente general (el mismo
  // que atiende a candidatos sin vacante) recordándole que ya quedó registrada,
  // hasta 5 reintentos; después de eso se corta al LLM y se manda el recordatorio fijo.
  const yaCompletado = itemsPreguntas.every(item => item.respuesta);
  if (yaCompletado) {
    if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
      const recordatorioConEnlace = `${MENSAJE_RECORDATORIO_COMPLETADO}\n\n${NOTA_VACANTES}\n${URL_VACANTES}`;
      try {
        await enviarRespuestaCandidato(idSuscriptor, recordatorioConEnlace);
        await agregarMensajeConversacion(supabase, fila, 'agente', recordatorioConEnlace);
      } catch (e) {
        log('manychat_envio', { estado: 'error', error: e.message });
        return;
      }
      log('agente', { estado: 'completado_limite_reintentos', reintentos: fila.reintentos });
      return;
    }

    let respuestaAgente;
    try {
      respuestaAgente = await generarRespuestaAgenteGeneral(fila.conversacion);
    } catch (e) {
      log('agente_general_llm', { estado: 'error', error: e.message });
      respuestaAgente = MENSAJE_FALLBACK_ERROR;
    }

    const mensajeConRecordatorio = `${respuestaAgente}\n\n${MENSAJE_RECORDATORIO_COMPLETADO}`;
    try {
      await enviarRespuestaCandidato(idSuscriptor, mensajeConRecordatorio);
      await agregarMensajeConversacion(supabase, fila, 'agente', mensajeConRecordatorio);
    } catch (e) {
      log('manychat_envio', { estado: 'error', error: e.message });
      return;
    }

    const nuevosReintentos = (fila.reintentos ?? 0) + 1;
    fila.reintentos = nuevosReintentos;
    const { error } = await supabase.from('chatbot').update({ reintentos: nuevosReintentos }).eq('id', fila.id);
    if (error) log('supabase_preguntas', { estado: 'error', error: error.message });

    log('agente', { estado: 'completado_respuesta', reintentos: nuevosReintentos });
    return;
  }

  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    log('agente', { estado: 'silenciado', reintentos: fila.reintentos });
    return;
  }

  let resultadoAgente;
  try {
    resultadoAgente = await generarRespuestaAgente({
      items:        itemsPreguntas,
      conversacion: fila.conversacion,
    });
  } catch (e) {
    log('agente_llm', { estado: 'error', error: e.message });

    const reintentosPorError = (fila.reintentos ?? 0) + 1;
    fila.reintentos = reintentosPorError;
    const { error: errorReintentos } = await supabase.from('chatbot').update({ reintentos: reintentosPorError }).eq('id', fila.id);
    if (errorReintentos) log('supabase_preguntas', { estado: 'error', error: errorReintentos.message });

    try {
      await enviarRespuestaCandidato(idSuscriptor, MENSAJE_FALLBACK_ERROR);
      await agregarMensajeConversacion(supabase, fila, 'agente', MENSAJE_FALLBACK_ERROR);
    } catch (e2) {
      log('manychat_envio', { estado: 'error', error: e2.message });
    }
    return;
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

  if (todasRespondidas) {
    mensajeAgente     = MENSAJE_DESPEDIDA_COMPLETADO;
    reintentosFinales = 0;
  } else if (nuevoReintentos >= LIMITE_REINTENTOS) {
    const nombreCandidato = itemsActualizados.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;
    mensajeAgente = generarDespedida(nombreCandidato);
  }

  // ── Sincronización con TeamTailor: alta de candidato/postulación + respuestas ──
  let candidatoId = fila.candidato ?? null;
  const itemNombre = itemsActualizados.find(item => item.id === ID_PREGUNTA_NOMBRE);
  const genero = resultadoAgente.genero && resultadoAgente.genero !== 'ninguno' ? resultadoAgente.genero : null;

  // El candidato ya existe en TeamTailor desde su primer mensaje (nombre = teléfono,
  // foto default); aquí solo se actualiza con su nombre real y foto según género. Si
  // por algún motivo no se creó antes (p. ej. falló esa llamada), se crea aquí como respaldo.
  if (itemNombre?.respuesta && !itemNombre.enviado) {
    try {
      if (candidatoId) {
        const { candidatoId: candidatoIdValido } = await conCandidatoValido(
          candidatoId,
          id => actualizarCandidatoTeamTailor(id, itemNombre.respuesta, genero),
          { nombre: itemNombre.respuesta, genero, telefono, idVacante: fila.vacante, log },
        );
        candidatoId = candidatoIdValido;
        log('candidato_actualizado', { estado: 'ok', candidato_id: candidatoId, genero });
      } else if (fila.vacante) {
        candidatoId = await crearCandidatoTeamTailor(itemNombre.respuesta, genero, telefono, fila.vacante);
        log('candidato_creado', { estado: 'ok', candidato_id: candidatoId, idVacante: fila.vacante, genero });
      }
      itemNombre.enviado = true;
    } catch (e) {
      log('candidato_actualizado', { estado: 'error', error: e.message });
    }
  }

  if (candidatoId) {
    for (const item of itemsActualizados) {
      if (item.tipo === 'nombre' || !item.respuesta || item.enviado) continue;
      try {
        const { candidatoId: candidatoIdValido } = await conCandidatoValido(
          candidatoId,
          id => enviarRespuestaTeamTailor(id, item),
          { nombre: itemNombre?.respuesta, genero, telefono, idVacante: fila.vacante, log },
        );
        candidatoId = candidatoIdValido;
        item.enviado = true;
        log('respuesta_teamtailor', { estado: 'ok', candidato_id: candidatoId, id_pregunta: item.id });
      } catch (e) {
        log('respuesta_teamtailor', { estado: 'error', id_pregunta: item.id, error: e.message });
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
  if (errorProgreso) log('supabase_preguntas', { estado: 'error', error: errorProgreso.message });

  log('agente', { estado: 'ok', avanzo, todasRespondidas, reintentos: reintentosFinales });

  if (todasRespondidas && candidatoId) {
    try {
      const { candidatoId: candidatoIdValido } = await conCandidatoValido(
        candidatoId,
        id => subirConversacionTeamTailor(id, fila.conversacion),
        { nombre: itemNombre?.respuesta, genero, telefono, idVacante: fila.vacante, log },
      );
      if (candidatoIdValido !== candidatoId) {
        candidatoId = candidatoIdValido;
        await supabase.from('chatbot').update({ candidato: candidatoId }).eq('id', fila.id);
      }
      log('conversacion_pdf', { estado: 'ok', candidato_id: candidatoId });
    } catch (e) {
      log('conversacion_pdf', { estado: 'error', error: e.message });
    }
  }

  try {
    await enviarRespuestaCandidato(idSuscriptor, mensajeAgente);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeAgente);
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return;
  }

  log('completado', { estado: 'ok' });
}

// ManyChat manda "Irresponsivo" cuando pasa 1h sin respuesta del candidato. Se le
// pregunta si quiere continuar, recordándole la pregunta donde se quedó, hasta el
// mismo límite de reintentos que el resto del flujo (comparten el contador).
async function procesarRecordatorioInactividad({ supabase, fila, idSuscriptor, log }) {
  const itemsPreguntas = fila.preguntas ?? [];
  const pendiente      = itemsPreguntas.find(item => !item.respuesta);

  if (!pendiente) {
    log('recordatorio_inactividad', { estado: 'saltado', razon: 'sin_pregunta_pendiente' });
    return;
  }

  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    log('recordatorio_inactividad', { estado: 'silenciado', reintentos: fila.reintentos });
    return;
  }

  const mensajeRecordatorio = `Hola! ¿Quisieras continuar con tu postulación?\n\n${pendiente.texto}`;
  try {
    await enviarRespuestaCandidato(idSuscriptor, mensajeRecordatorio);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeRecordatorio);
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return;
  }

  const nuevosReintentos = (fila.reintentos ?? 0) + 1;
  fila.reintentos = nuevosReintentos;
  const { error } = await supabase.from('chatbot').update({ reintentos: nuevosReintentos }).eq('id', fila.id);
  if (error) log('supabase_preguntas', { estado: 'error', error: error.message });

  log('recordatorio_inactividad', { estado: 'ok', reintentos: nuevosReintentos, pregunta_id: pendiente.id });
}

async function procesarMensaje({ idSuscriptor, telefono, mensaje, log }) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let fila, esNuevo;
  try {
    ({ fila, esNuevo } = await obtenerOCrearContacto(supabase, idSuscriptor, telefono));
  } catch (e) {
    log('supabase_contacto', { estado: 'error', error: e.message });
    return;
  }

  if (mensaje === MENSAJE_IRRESPONSIVO) {
    await procesarRecordatorioInactividad({ supabase, fila, idSuscriptor, log });
    return;
  }

  if (REGEX_BAJA.test(mensaje)) {
    await registrarSolicitudEliminacion(supabase, fila, log);
  }

  await agregarMensajeConversacion(supabase, fila, 'usuario', mensaje, { actualizarTimestamp: true });
  if (esNuevo) {
    await agregarMensajeConversacion(supabase, fila, 'agente', MENSAJE_BIENVENIDA_MANYCHAT);
  }

  const respondidoPorDeteccion = await detectarYCargarVacante({ supabase, fila, idSuscriptor, telefono, mensaje, log });
  if (respondidoPorDeteccion) return;

  const itemsPreguntas = fila.preguntas ?? [];
  if (itemsPreguntas.length === 0) {
    await procesarCandidatoSinVacante({ supabase, fila, idSuscriptor, log });
    return;
  }

  await procesarCandidatoConVacante({ supabase, fila, idSuscriptor, telefono, log });
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

  const idSuscriptor = cuerpo?.id;
  const telefono      = cuerpo?.telefono != null ? String(cuerpo.telefono) : null;
  const mensaje        = cuerpo?.mensaje != null ? String(cuerpo.mensaje) : '';

  const log = (etapa, extra = {}) => console.log(JSON.stringify({ etapa, idSuscriptor, mensajeCandidato: mensaje, ...extra }));

  if (!idSuscriptor || !telefono) {
    log('validacion', { estado: 'error', error: 'missing id or telefono' });
    return res.status(400).json({ ok: false, error: 'missing id or telefono' });
  }

  // Fire-and-forget: se responde de inmediato a ManyChat y el procesamiento
  // (llamadas a OpenRouter, TeamTailor, envíos de WhatsApp) sigue en segundo
  // plano, sin que ManyChat tenga que esperar los ~5-60s que puede tardar.
  waitUntil(procesarMensaje({ idSuscriptor, telefono, mensaje, log }));

  return res.status(202).json({ ok: true, processing: true });
}
