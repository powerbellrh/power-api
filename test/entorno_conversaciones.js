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

export function crearEntornoConversaciones({ tablas = {}, vacantesTeamTailor = {}, preguntasTeamTailor = {}, aplicacionesTeamTailor = [] } = {}) {
  const supabase = crearSupabaseFalso({
    tablas,
    autoincrementales: ['candidatos', 'postulaciones', 'vacantes', 'preguntas', 'preguntas_seleccionadas', 'respuestas', 'conversaciones', 'usuarios', 'reclutadores_asignados'],
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
      const herramienta = cuerpo.tool_choice?.function?.name ?? 'texto';
      peticionesModelo.push({ herramienta, sistema: cuerpo.messages[0].content, usuario: cuerpo.messages[1].content });
      const cola = colasModelo[herramienta] ?? [];
      if (cola.length === 0) return respuestaHttp({ error: `sin respuesta simulada para ${herramienta}` }, 500);

      const siguiente = cola.shift();
      return respuestaHttp({ choices: [{ message: { tool_calls: [{ function: { name: herramienta, arguments: JSON.stringify(siguiente) } }] } }] });
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
    llamadasTT,
    aplicaciones,
    fallarManyChatSi: null,     // (ruta, cuerpo) => boolean
    fallarTeamTailorSi: null,   // (metodo, ruta, cuerpo) => boolean
    encolarModelo: (herramienta, ...respuestas) => { (colasModelo[herramienta] ??= []).push(...respuestas); },
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
