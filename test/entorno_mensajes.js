// Entorno simulado para probar los flujos del chatbot sin red: Supabase en memoria y un `fetch`
// falso para OpenRouter, ManyChat y TeamTailor. Los tests describen lo que "responde" el modelo.

import { createCanvas } from 'canvas';
import { procesarMensajeCandidato } from '../api/mensajes.js';
import { procesarCreacionVacante } from '../lib/chatbot/vacantes/flujo.js';

export const ID_CAMPO_MENSAJE = 14851295;  // ID_CAMPO_MENSAJE_CANDIDATO: el texto que se le manda al candidato
const ID_CAMPO_IMAGEN = 15021836;          // ID_CAMPO_IMAGEN_VACANTE: la URL de la imagen que se muestra a la reclutadora
// PNG válido generado al vuelo (la imagen real la produce OpenRouter)
const PNG_BASE64 = createCanvas(8, 2).toBuffer('image/png').toString('base64');

// Supabase en memoria. `select` devuelve una copia (como la base real), y `update` admite filtros
// encadenados (`eq`/`is`) y `select()` para saber cuántas filas cambió, igual que el cliente real.
function crearSupabase(filaInicial) {
  const tablas = { chatbot: [filaInicial], evaluaciones: [] };
  const subidas = [];

  const filtrar = (filas, filtros) => filas.filter(f => filtros.every(([columna, valor]) => (f[columna] ?? null) === valor));

  return {
    tablas,
    subidas,
    storage: {
      from: () => ({
        upload: async ruta => { subidas.push(ruta); return { error: null }; },
        createSignedUrl: async ruta => ({ data: { signedUrl: `https://firmada.test/${ruta}` }, error: null }),
      }),
    },
    from(nombre) {
      const filas = tablas[nombre];
      return {
        select: () => {
          const filtros = [];
          const consulta = {
            eq: (columna, valor) => { filtros.push([columna, valor]); return consulta; },
            maybeSingle: async () => {
              const fila = filtrar(filas, filtros)[0];
              return { data: fila ? structuredClone(fila) : null, error: null };
            },
          };
          return consulta;
        },
        update: cambios => {
          const filtros = [];
          const aplicar = () => {
            const afectadas = filtrar(filas, filtros);
            afectadas.forEach(f => Object.assign(f, structuredClone(cambios)));
            return afectadas;
          };
          const consulta = {
            eq: (columna, valor) => { filtros.push([columna, valor]); return consulta; },
            is: (columna, valor) => { filtros.push([columna, valor]); return consulta; },
            select: async () => ({ data: aplicar().map(f => ({ id: f.id })), error: null }),
            then: (resolver, rechazar) => Promise.resolve().then(() => { aplicar(); return { error: null }; }).then(resolver, rechazar),
          };
          return consulta;
        },
        insert: async nuevas => { filas.push(...nuevas); return { error: null }; },
      };
    },
  };
}

// `encolarModelo` es una cola: cada llamada de chat a OpenRouter saca la siguiente. Una función recibe la
// petición (para armar la respuesta según el prompt); un objeto es el argumento de la herramienta;
// un texto es una respuesta de texto plano. Las imágenes no consumen la cola.
export function crearEntorno({ fila, respuestasTeamTailor = {} }) {
  const supabase = crearSupabase({ id: 1, telefono: '5213300000000', manychat: 99, conversacion: null, preguntas: null, reintentos: 0, recordatorios: 0, ...fila });
  const mensajesEnviados = [];
  const imagenesEnviadas = [];
  const peticionesModelo = [];
  const llamadasTeamTailor = [];
  const cola = [];
  let imagenesGeneradas = 0;

  const fetchOriginal = globalThis.fetch;
  const json = cuerpo => ({ ok: true, status: 200, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) });

  globalThis.fetch = async (url, opciones = {}) => {
    const cuerpo = typeof opciones.body === 'string' ? JSON.parse(opciones.body) : null;

    if (url.startsWith('https://openrouter.ai/api/v1/images')) {
      imagenesGeneradas++;
      return json({ data: [{ b64_json: PNG_BASE64 }] });
    }

    if (url.startsWith('https://openrouter.ai')) {
      peticionesModelo.push(cuerpo);
      if (cola.length === 0) throw new Error(`El modelo simulado no tiene respuestas en cola (${cuerpo.tools?.[0]?.function.name ?? 'texto'})`);
      let siguiente = cola.shift();
      if (typeof siguiente === 'function') siguiente = siguiente(cuerpo);

      const herramienta = cuerpo.tools?.[0]?.function.name;
      const mensaje = herramienta
        ? { tool_calls: [{ function: { name: herramienta, arguments: JSON.stringify(siguiente) } }] }
        : { content: siguiente };
      return json({ choices: [{ message: mensaje }] });
    }

    if (url.startsWith('https://api.manychat.com')) {
      if (entorno.fallarEnvioSi?.(cuerpo?.field_value)) return { ok: false, status: 500, json: async () => ({}), text: async () => 'fallo simulado de ManyChat' };
      if (url.endsWith('/setCustomField') && cuerpo.field_id === ID_CAMPO_MENSAJE) mensajesEnviados.push(cuerpo.field_value);
      if (url.endsWith('/setCustomField') && cuerpo.field_id === ID_CAMPO_IMAGEN) imagenesEnviadas.push(cuerpo.field_value);
      return json({ status: 'success' });
    }

    if (url.startsWith('https://api.na.teamtailor.com')) {
      const ruta = url.replace('https://api.na.teamtailor.com/v1', '');
      llamadasTeamTailor.push(`${opciones.method ?? 'GET'} ${ruta}`);
      if (entorno.fallarTeamTailorSi?.(opciones.method ?? 'GET', ruta)) return { ok: false, status: 500, json: async () => ({}), text: async () => 'fallo simulado de TeamTailor' };
      if (respuestasTeamTailor[ruta]) return json(respuestasTeamTailor[ruta]);
      if (ruta === '/files') return json({ uri: 'https://archivo.transitorio/x.pdf' });
      if (ruta === '/jobs' && opciones.method === 'POST') return json({ data: { id: '777', attributes: {}, links: { 'careersite-job-url': 'https://carreras.test/jobs/777' } } });
      return json({ data: { id: '777', attributes: {} } });
    }

    throw new Error(`Petición inesperada en el test: ${url}`);
  };

  const registros = [];
  const log = (etapa, extra = {}) => registros.push({ etapa, ...extra });

  const entorno = {
    fallarEnvioSi: null,       // (texto) => boolean: hace fallar el envío por ManyChat de ese mensaje
    fallarTeamTailorSi: null,  // (metodo, ruta) => boolean: hace fallar esa llamada a TeamTailor
    supabase,
    fila: supabase.tablas.chatbot[0],
    mensajesEnviados,
    imagenesEnviadas,
    peticionesModelo,
    llamadasTeamTailor,
    registros,
    get imagenesGeneradas() { return imagenesGeneradas; },
    encolarModelo: (...respuestas) => cola.push(...respuestas),
    restaurar: () => { globalThis.fetch = fetchOriginal; },

    // Simula que el candidato escribe `mensaje` (o que ManyChat manda "Irresponsivo").
    async escribir(mensaje, { esNuevo = false } = {}) {
      await procesarMensajeCandidato({ supabase, fila: supabase.tablas.chatbot[0], esNuevo, idSuscriptor: 99, telefono: '5213300000000', mensaje, log });
    },

    // Simula que la reclutadora autorizada escribe `mensaje` en el flujo de creación de vacantes.
    async escribirComoReclutadora(mensaje) {
      await procesarCreacionVacante({ supabase, telefono: '5213300000000', mensaje, idSuscriptor: 99, log });
    },
  };
  return entorno;
}

export const item = (id, respuesta = '', extra = {}) => ({ id, texto: `Pregunta ${id}`, respuesta, tipo: 'text', enviado: false, ...extra });
