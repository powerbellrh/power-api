// Entorno simulado para probar los flujos del chatbot sin red: Supabase en memoria y un `fetch`
// falso para OpenRouter, ManyChat y TeamTailor. Los tests describen lo que "responde" el modelo.

import { procesarMensajeCandidato } from '../api/mensajes.js';

export const ID_CAMPO_MENSAJE = 14851295; // ID_CAMPO_MENSAJE_CANDIDATO: el texto que se le manda al candidato

function crearSupabase(filaInicial) {
  const tablas = { chatbot: [filaInicial], evaluaciones: [] };

  return {
    tablas,
    from(nombre) {
      const filas = tablas[nombre];
      return {
        select: () => ({
          eq: (columna, valor) => ({
            maybeSingle: async () => ({ data: filas.find(f => f[columna] === valor) ?? null, error: null }),
          }),
        }),
        update: cambios => ({
          eq: async (columna, valor) => {
            filas.filter(f => f[columna] === valor).forEach(f => Object.assign(f, cambios));
            return { error: null };
          },
        }),
        insert: async nuevas => { filas.push(...nuevas); return { error: null }; },
      };
    },
  };
}

// `respuestasModelo` es una cola: cada llamada a OpenRouter saca la siguiente. Una función recibe la
// petición (para armar la respuesta según el prompt); un objeto es el argumento de la herramienta;
// un texto es una respuesta de texto plano.
export function crearEntorno({ fila, respuestasTeamTailor = {} }) {
  const supabase = crearSupabase({ id: 1, telefono: '5213300000000', manychat: 99, conversacion: null, preguntas: null, reintentos: 0, recordatorios: 0, ...fila });
  const mensajesEnviados = [];
  const peticionesModelo = [];
  const llamadasTeamTailor = [];
  const cola = [];

  const fetchOriginal = globalThis.fetch;
  const json = cuerpo => ({ ok: true, status: 200, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) });

  globalThis.fetch = async (url, opciones = {}) => {
    const cuerpo = typeof opciones.body === 'string' ? JSON.parse(opciones.body) : null;

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
      if (url.endsWith('/setCustomField') && cuerpo.field_id === ID_CAMPO_MENSAJE) mensajesEnviados.push(cuerpo.field_value);
      return json({ status: 'success' });
    }

    if (url.startsWith('https://api.na.teamtailor.com')) {
      const ruta = url.replace('https://api.na.teamtailor.com/v1', '');
      llamadasTeamTailor.push(`${opciones.method ?? 'GET'} ${ruta}`);
      if (respuestasTeamTailor[ruta]) return json(respuestasTeamTailor[ruta]);
      if (ruta === '/files') return json({ uri: 'https://archivo.transitorio/x.pdf' });
      return json({ data: { id: '777', attributes: {} } });
    }

    throw new Error(`Petición inesperada en el test: ${url}`);
  };

  const registros = [];
  const log = (etapa, extra = {}) => registros.push({ etapa, ...extra });

  return {
    supabase,
    fila: supabase.tablas.chatbot[0],
    mensajesEnviados,
    peticionesModelo,
    llamadasTeamTailor,
    registros,
    encolarModelo: (...respuestas) => cola.push(...respuestas),
    restaurar: () => { globalThis.fetch = fetchOriginal; },

    // Simula que el candidato escribe `mensaje` (o que ManyChat manda "Irresponsivo").
    async escribir(mensaje, { esNuevo = false } = {}) {
      await procesarMensajeCandidato({ supabase, fila: supabase.tablas.chatbot[0], esNuevo, idSuscriptor: 99, telefono: '5213300000000', mensaje, log });
    },
  };
}

export const item = (id, respuesta = '', extra = {}) => ({ id, texto: `Pregunta ${id}`, respuesta, tipo: 'text', enviado: false, ...extra });
