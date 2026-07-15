import { createClient } from '@supabase/supabase-js';
import { timestampMexico } from '../lib/historial_utils.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const lineaHistorial = (rol, mensaje) => `${timestampMexico(new Date().toISOString())} - ${rol}: ${mensaje}`;

const limpiarBloqueCodigo = (texto) => texto.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();

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
    },
    required: ['respuesta', 'campos_recopilados', 'campos_faltantes'],
    additionalProperties: false,
  },
};

const construirPromptSistema = (vacanteInfo, camposRequeridos, camposRecopilados) => `Eres el agente virtual de Powerbell, una agencia de recursos humanos y reclutamiento en Guadalajara. Atiendes por WhatsApp a personas interesadas en una vacante.

INFORMACIÓN VERÍDICA DE LA VACANTE (única fuente permitida para hablar de la vacante):
${vacanteInfo || 'Sin información disponible por el momento.'}

DATOS A RECOPILAR DE LA PERSONA:
${camposRequeridos || 'nombre completo y domicilio'}

DATOS YA RECOPILADOS:
${camposRecopilados || 'Ninguno todavía.'}

TAREAS, EN ORDEN DE PRIORIDAD:
1. Si es el inicio de la conversación, presenta la vacante usando SOLO la información de arriba, en un formato amigable, breve y fácil de leer (evita párrafos largos).
2. Responde preguntas sobre la vacante, la postulación o Powerbell, pero ÚNICAMENTE con datos que puedas respaldar directamente con la información de la vacante que se te dio. Nunca inventes, asumas ni completes datos que no estén ahí.
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
Debes devolver únicamente el objeto JSON que exige el esquema, con estos tres campos:
- "respuesta": el mensaje para la persona, siguiendo las reglas de estilo de arriba.
- "campos_recopilados": el estado ACUMULADO de todos los datos que ya se tienen (los de antes más lo nuevo que hayas extraído en este mensaje), no solo lo de este turno.
- "campos_faltantes": los datos de "DATOS A RECOPILAR" que aún no tienes.`;

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
  const mensaje  = cuerpo?.mensaje;
  const manychat = cuerpo?.manychat;

  if (!mensaje || !manychat) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing mensaje or manychat' }));
    return res.status(400).json({ ok: false, error: 'missing mensaje or manychat' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: registro, error: errorBusqueda } = await supabase
      .from('chatbot')
      .select('historial_mensajes, vacante_info, campos_requeridos, campos_recopilados')
      .eq('manychat_id', manychat)
      .maybeSingle();

    if (errorBusqueda) throw new Error(`Supabase select failed: ${errorBusqueda.message}`);

    const historialPrevio = registro?.historial_mensajes || '';
    const historialConUsuario = historialPrevio
      ? `${historialPrevio}\n${lineaHistorial('usuario', mensaje)}`
      : lineaHistorial('usuario', mensaje);

    const promptSistema = construirPromptSistema(
      registro?.vacante_info,
      registro?.campos_requeridos,
      registro?.campos_recopilados,
    );

    const respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL,
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
      return res.status(500).json({ ok: false, error: 'openrouter request failed' });
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

    const { error: errorGuardado } = await supabase
      .from('chatbot')
      .upsert({ manychat_id: manychat, historial_mensajes: historialFinal, campos_recopilados: camposRecopilados });

    if (errorGuardado) throw new Error(`Supabase upsert failed: ${errorGuardado.message}`);

    console.log(JSON.stringify({ etapa: 'openrouter', estado: 'exito', manychat, mensaje, respuesta: respuestaModelo, campos_faltantes: salidaModelo.campos_faltantes }));
    return res.status(200).json({ ok: true, respuesta: respuestaModelo });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'error', manychat, mensaje: error.message }));
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
