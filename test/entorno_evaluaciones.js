import { crearSupabaseFalso } from './supabase_falso.js';

// Entorno simulado para probar /evaluaciones sin red: Supabase en memoria y un `fetch` falso para TeamTailor,
// ManyChat y OpenRouter. Cada prueba dice qué hay en TeamTailor y qué contesta el modelo.

export const POSTULACION = 99887766;
export const VACANTE     = 777001;
export const CANDIDATO   = '4321';

const respuestaHttp = (cuerpo, estado = 200) => ({
  ok: estado < 400, status: estado,
  json: async () => cuerpo,
  text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
});

const PREGUNTAS = Array.from({ length: 9 }, (_, i) => `P${i + 1}: ¿Cuál fue tu logro número ${i + 1} en tu último empleo?`).join('\n');
export const RESULTADO_AD   = `Análisis del perfil.\n\nCalificación global: Altamente compatible - 16/20\n\n#PREGUNTAS#\n${PREGUNTAS}\n#PREGUNTAS#`;
export const RESULTADO_BAJO = `Análisis del perfil.\n\nCalificación global: No compatible - 6/20\n\n#PREGUNTAS#\n${PREGUNTAS}\n#PREGUNTAS#`;
export const RESULTADO_OP   = `#✅ APTO#\n\nCumple con lo que pide la vacante.\n\n#PREGUNTAS#\n${PREGUNTAS}\n#PREGUNTAS#`;

export const filaPendiente = (extra = {}) => ({
  postulacion_id: POSTULACION, candidato_nombre: 'Ana López', candidato_telefono: '3312345678', vacante_id: VACANTE, vacante_tipo: 'AD',
  evaluacion_agendada: true, evaluacion_completada: false, intentos: 1, ...extra,
});

// `curriculum`: URL del CV del candidato ('' = sin CV). `respuestas`: sus respuestas del formulario, { titulo: texto }.
// `modelo`: lo que contesta OpenRouter en cada llamada, en orden; un texto es el resultado y un Error es un fallo.
export function crearEntornoEvaluaciones({ fila = filaPendiente(), curriculum = 'https://archivos.teamtailor.test/cv.pdf', respuestas = { '¿Cuál es tu edad?': '31' }, modelo = [RESULTADO_AD], relacionConUsuario = true, manychat = {} } = {}) {
  const supabase = crearSupabaseFalso({ tablas: { evaluaciones: fila ? [fila] : [] }, autoincrementales: ['registros'] });
  const llamadasTT = [];        // { metodo, ruta, cuerpo }
  const llamadasManyChat = [];  // { ruta, cuerpo }
  const peticionesModelo = [];
  const colaModelo = [...modelo];

  const titulos = Object.keys(respuestas);
  const respuestasTT = {
    data: titulos.map((titulo, i) => ({ attributes: { 'question-type': 'text', text: respuestas[titulo] }, relationships: { question: { data: { id: `q${i}` } } } })),
    included: titulos.map((titulo, i) => ({ id: `q${i}`, type: 'questions', attributes: { title: titulo } })),
  };
  const vacanteTT = {
    data: {
      id: String(VACANTE), attributes: { title: 'Analista de datos', 'internal-name': 'Cliente Uno - Analista de datos', body: '<p>Analiza <b>datos</b></p>' },
      relationships: { user: { data: relacionConUsuario ? { id: '45146', type: 'users' } : null } },
    },
    included: [{ type: 'locations', attributes: { name: 'Guadalajara' } }, { type: 'users', id: '45146', attributes: {} }],
  };

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opciones = {}) => {
    const metodo = opciones.method ?? 'GET';
    const cuerpo = typeof opciones.body === 'string' ? JSON.parse(opciones.body) : null;

    if (url.startsWith('https://api.na.teamtailor.com/v1')) {
      const ruta = url.slice('https://api.na.teamtailor.com/v1'.length);
      llamadasTT.push({ metodo, ruta, cuerpo });
      if (metodo !== 'GET') return respuestaHttp({ data: { id: 'creado' } });
      if (ruta.startsWith(`/jobs/${VACANTE}/custom-field-values`)) return respuestaHttp({ data: [{ attributes: { value: 'Buscan a alguien\ncon SQL' }, relationships: { 'custom-field': { data: { id: '8036' } } } }] });
      if (ruta.startsWith(`/jobs/${VACANTE}`)) return respuestaHttp(vacanteTT);
      if (ruta.startsWith(`/job-applications/${POSTULACION}/candidate`)) return respuestaHttp({ data: { id: CANDIDATO, attributes: { resume: curriculum, phone: '33 1234 5678', 'first-name': 'Ana' } } });
      if (ruta.startsWith(`/candidates/${CANDIDATO}/answers`)) return respuestaHttp(respuestasTT);
      return respuestaHttp('no encontrado', 404);
    }

    if (url.startsWith('https://api.manychat.com')) {
      const ruta = url.slice('https://api.manychat.com'.length).split('?')[0];
      llamadasManyChat.push({ ruta, cuerpo });
      if (manychat[ruta] instanceof Error) return respuestaHttp(manychat[ruta].message, 400);
      if (ruta === '/fb/subscriber/createSubscriber') return respuestaHttp({ status: 'success', data: { id: '888' } });
      return respuestaHttp({ status: 'success' });
    }

    if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
      peticionesModelo.push(cuerpo);
      const siguiente = colaModelo.shift();
      if (siguiente === undefined) return respuestaHttp({ error: 'sin respuesta simulada' }, 500);
      if (siguiente instanceof Error) return respuestaHttp({ error: { message: siguiente.message } }, 500);
      return respuestaHttp({ provider: 'Proveedor Uno', choices: [{ message: { content: siguiente, reasoning: 'razonamiento' } }], usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.004 } });
    }

    throw new Error(`fetch no simulado: ${url}`);
  };

  return {
    supabase, llamadasTT, llamadasManyChat, peticionesModelo,
    fila: () => supabase.tablas.evaluaciones.find(f => f.postulacion_id === POSTULACION),
    notas: () => llamadasTT.filter(l => l.metodo === 'POST' && l.ruta === '/notes').map(l => ({ nota: l.cuerpo.data.attributes.note, estrellas: l.cuerpo.data.attributes.rating ?? null, usuario: l.cuerpo.data.relationships.user.data.id })),
    fotos: () => llamadasTT.filter(l => l.metodo === 'PATCH').map(l => l.cuerpo.data.attributes.picture),
    restaurar: () => { globalThis.fetch = fetchOriginal; },
  };
}
