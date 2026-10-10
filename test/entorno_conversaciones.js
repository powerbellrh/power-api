import { crearSupabaseFalso } from './supabase_falso.js';

// Entorno simulado para probar /conversaciones sin red: Supabase en memoria y un `fetch` falso para OpenRouter,
// ManyChat y TeamTailor. Los tests describen lo que "responde" el modelo (una cola por herramienta) y lo que
// existe en TeamTailor (vacantes y sus preguntas).

export const CAMPO_MENSAJE = 15041599;
export const CAMPO_IMAGEN  = 15021836;

const respuestaHttp = (cuerpo, estado = 200) => ({
  ok: estado < 400, status: estado,
  json: async () => cuerpo,
  text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
});

const ahora = () => new Date().toISOString();

// `respuestasTeamTailor` son respuestas fijas de un GET por su ruta, con o sin los parámetros (ej. '/jobs/1/stages').
export function crearEntornoConversaciones({ tablas = {}, vacantesTeamTailor = {}, preguntasTeamTailor = {}, aplicacionesTeamTailor = [], respuestasTeamTailor = {} } = {}) {
  const supabase = crearSupabaseFalso({
    tablas,
    autoincrementales: ['candidatos', 'postulaciones', 'vacantes', 'preguntas', 'preguntas_seleccionadas', 'respuestas', 'conversaciones', 'usuarios', 'reclutadores_asignados', 'registros'],
    unicos: {
      conversaciones: ['telefono', 'manychat'],
      candidatos:     ['telefono'],
      vacantes:       ['id_team_tailor'],
      preguntas:      ['id_teamtailor'],
    },
    defaults: {
      conversaciones: () => ({
        paso: 'sin_vacante', temporal: {}, intentos: 0, recordatorios: 0, version: 0, flujo_enviado: null, enviado_en: null,
        historial: null, solicitud_eliminacion: null, id_candidato: null, id_vacante: null, id_postulacion: null, creado: ahora(), actualizado: ahora(),
      }),
    },
  });

  const colasModelo   = {};
  const peticionesModelo = [];
  const peticionesModeloCrudas = [];  // el cuerpo completo de cada petición al agente con herramientas
  const peticionesDescripcion = [];
  const colaDecisiones = [];
  const peticionesDecision = [];
  const envios        = [];           // lo que ManyChat mostró: { flow_ns, campos: { [field_id]: valor } }
  const etiquetas     = [];
  const llamadasTT    = [];           // { metodo, ruta, cuerpo }
  const camposManyChat = {};          // último valor de cada campo por suscriptor
  const aplicaciones  = [...aplicacionesTeamTailor]; // { id, candidato, vacante }
  let siguienteCandidato = 5000;
  let siguienteAplicacion = 9000;

  const fetchOriginal = globalThis.fetch;

  globalThis.fetch = async (url, opciones = {}) => {
    const metodo = opciones.method ?? 'GET';
    const cuerpo = typeof opciones.body === 'string' ? JSON.parse(opciones.body) : null;

    if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
      // Agente con varias herramientas (tool_choice "required"): cada respuesta simulada dice cuál llama, { herramienta, argumentos }.
      if (typeof cuerpo.tool_choice === 'string') {
        peticionesModeloCrudas.push(cuerpo);
        peticionesModelo.push({ herramienta: 'agente', sistema: cuerpo.messages[0].content, usuario: cuerpo.messages[1].content, mensajes: cuerpo.messages });
        const llamada = (colasModelo.agente ?? []).shift();
        if (!llamada) return respuestaHttp({ error: 'sin respuesta simulada para el agente' }, 500);
        return respuestaHttp({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `llamada_${peticionesModelo.length}`, type: 'function', function: { name: llamada.herramienta, arguments: JSON.stringify(llamada.argumentos) } }] } }] });
      }

      const herramienta = cuerpo.tool_choice?.function?.name ?? 'texto';
      // La descripción de lo que escribió una reclutadora (para `registros`) va aparte: no cuenta como petición del
      // chatbot, y sin respuesta simulada falla, que es como se queda sin descripción.
      if (herramienta === 'describir_texto') {
        peticionesDescripcion.push({ sistema: cuerpo.messages[0].content, texto: cuerpo.messages[1].content });
        const descripcion = (colasModelo.describir_texto ?? []).shift();
        if (!descripcion) return respuestaHttp({ error: 'sin descripción simulada' }, 500);
        return respuestaHttp({ choices: [{ message: { tool_calls: [{ function: { name: herramienta, arguments: JSON.stringify(descripcion) } }] } }], usage: { cost: 0.0002 } });
      }
      peticionesModelo.push({ herramienta, sistema: cuerpo.messages[0].content, usuario: cuerpo.messages[1].content });
      const cola = colasModelo[herramienta] ?? [];
      if (cola.length === 0) return respuestaHttp({ error: `sin respuesta simulada para ${herramienta}` }, 500);

      const siguiente = cola.shift();
      if (siguiente instanceof Error) return respuestaHttp({ error: siguiente.message }, 500); // un fallo pasajero del proveedor
      return respuestaHttp({ choices: [{ message: { tool_calls: [{ function: { name: herramienta, arguments: JSON.stringify(siguiente) } }] } }] });
    }

    // Clasificador de mensajes: cada respuesta simulada son las `answers` de una petición; se toma la primera que
    // sea de las preguntas que se hicieron. Las preguntas de sí/no que el test no contestó salen en 0 (el modelo
    // siempre las contesta todas). Sin respuesta simulada falla, que es como se prueba que todo sigue funcionando
    // con las reglas cuando el clasificador no contesta.
    if (url.startsWith('https://openrouter.ai/api/alpha/decisions')) {
      peticionesDecision.push(cuerpo);
      const indice = colaDecisiones.findIndex(respuestas => Object.keys(respuestas).every(pregunta => pregunta in cuerpo.questions));
      if (indice < 0) return respuestaHttp({ error: 'sin decisión simulada' }, 500);
      const sinContestar = Object.entries(cuerpo.questions).filter(([, pregunta]) => pregunta.type === 'noul').map(([clave]) => [clave, { type: 'noul', noul: 0 }]);
      return respuestaHttp({ answers: { ...Object.fromEntries(sinContestar), ...colaDecisiones.splice(indice, 1)[0] } });
    }

    if (url.startsWith('https://api.manychat.com')) {
      const ruta = url.replace('https://api.manychat.com', '');
      if (entorno.fallarManyChatSi?.(ruta, cuerpo)) return respuestaHttp('fallo simulado de ManyChat', 500);

      if (ruta === '/fb/subscriber/setCustomFields') {
        camposManyChat[cuerpo.subscriber_id] = { ...(camposManyChat[cuerpo.subscriber_id] ?? {}), ...Object.fromEntries(cuerpo.fields.map(c => [c.field_id, c.field_value])) };
      } else if (ruta === '/fb/subscriber/setCustomField') {
        camposManyChat[cuerpo.subscriber_id] = { ...(camposManyChat[cuerpo.subscriber_id] ?? {}), [cuerpo.field_id]: cuerpo.field_value };
      } else if (ruta === '/fb/sending/sendFlow') {
        envios.push({ suscriptor: cuerpo.subscriber_id, flow_ns: cuerpo.flow_ns, campos: { ...(camposManyChat[cuerpo.subscriber_id] ?? {}) } });
      } else if (ruta === '/fb/subscriber/addTag') {
        etiquetas.push(cuerpo);
      }
      return respuestaHttp({ status: 'success' });
    }

    if (url.startsWith('https://api.na.teamtailor.com')) {
      const ruta = url.replace('https://api.na.teamtailor.com/v1', '');
      llamadasTT.push({ metodo, ruta, cuerpo });
      if (entorno.fallarTeamTailorSi?.(metodo, ruta, cuerpo)) return respuestaHttp('fallo simulado de TeamTailor', 500);

      const fija = metodo === 'GET' && Object.entries(respuestasTeamTailor).find(([clave]) => ruta === clave || ruta.startsWith(`${clave}?`));
      if (fija) return respuestaHttp(fija[1]);
      if (metodo === 'POST' && ruta === '/jobs') return respuestaHttp({ data: { id: '777001', links: { 'careersite-job-url': 'https://careers.test/jobs/777001' } } });

      const trabajo = ruta.match(/^\/jobs\/(\d+)(?:\?.*)?$/);
      if (metodo === 'GET' && trabajo) {
        const vacante = vacantesTeamTailor[trabajo[1]];
        return vacante ? respuestaHttp({ data: { id: trabajo[1], attributes: vacante.attributes }, included: vacante.included ?? [] }) : respuestaHttp('Record not found', 404);
      }
      const preguntas = ruta.match(/^\/jobs\/(\d+)\/questions/);
      if (metodo === 'GET' && preguntas) return respuestaHttp({ data: preguntasTeamTailor[preguntas[1]] ?? [] });

      const delCandidato = ruta.match(/^\/candidates\/(\d+)\/job-applications/);
      if (metodo === 'GET' && delCandidato) {
        return respuestaHttp({ data: aplicaciones.filter(a => String(a.candidato) === delCandidato[1]).map(a => ({ id: String(a.id), relationships: { job: { data: { id: String(a.vacante) } } } })) });
      }

      if (metodo === 'POST' && ruta === '/candidates')       return respuestaHttp({ data: { id: String(siguienteCandidato++) } });
      if (metodo === 'POST' && ruta === '/job-applications') {
        const aplicacion = { id: siguienteAplicacion++, candidato: Number(cuerpo.data.relationships.candidate.data.id), vacante: Number(cuerpo.data.relationships.job.data.id) };
        aplicaciones.push(aplicacion);
        return respuestaHttp({ data: { id: String(aplicacion.id) } });
      }
      if (metodo === 'POST' && ruta === '/files')            return respuestaHttp({ uri: 'https://archivo.transitorio/x.pdf' });
      return respuestaHttp({ data: { id: '1', attributes: {} } });
    }

    throw new Error(`Petición inesperada en el test: ${url}`);
  };

  const registros = [];
  const entorno = {
    supabase,
    registros,
    log: (etapa, extra = {}) => registros.push({ etapa, ...extra }),
    envios,
    etiquetas,
    peticionesModelo,
    peticionesModeloCrudas,
    peticionesDescripcion,
    llamadasTT,
    aplicaciones,
    fallarManyChatSi: null,     // (ruta, cuerpo) => boolean
    fallarTeamTailorSi: null,   // (metodo, ruta, cuerpo) => boolean
    encolarModelo: (herramienta, ...respuestas) => { (colasModelo[herramienta] ??= []).push(...respuestas); },
    peticionesDecision,
    encolarDecision: (...respuestas) => { colaDecisiones.push(...respuestas); },
    restaurar: () => { globalThis.fetch = fetchOriginal; },

    // Mensajes que ManyChat le mostró al candidato, en orden.
    get mensajes() { return envios.map(envio => envio.campos[CAMPO_MENSAJE]); },
    llamadasTT_(metodo, patron) { return llamadasTT.filter(l => l.metodo === metodo && patron.test(l.ruta)); },
  };
  return entorno;
}

// Vacante de TeamTailor tal como la devuelve `/jobs/{id}?include=...`.
export const vacanteTeamTailor = ({ titulo = 'Almacenista', cuerpo = '<p><strong>Vacante:</strong> Almacenista</p>', reclutador = '1', contexto = null } = {}) => ({
  attributes: { title: titulo, 'internal-name': `Cliente - ${titulo}`, body: cuerpo, 'min-salary': 8000, 'max-salary': 9000, 'created-at': '2026-10-01T00:00:00Z' },
  included: [
    { type: 'users', id: reclutador, attributes: {} },
    ...(contexto ? [{ type: 'custom-fields', id: '8036', attributes: {} }, { type: 'custom-field-values', id: '1', attributes: { value: contexto } }] : []),
  ],
});

export const preguntaTeamTailor = (id, titulo, tipo = 'Text') => ({ id: String(id), attributes: { title: titulo, 'question-type': tipo } });
