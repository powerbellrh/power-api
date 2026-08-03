import { generarFelicitacion } from '../lib/canvas_felicitacion.js';
import { subirYFirmar } from '../lib/storage_powerid.js';
import { ttCrear } from '../lib/clientes_api.js';

const BUCKET = 'felicitaciones';
const NOTA_GOOGLE = 'Para nosotros es importante saber cómo te sentiste durante tu proceso, ¿podrías compartirnos tu experiencia sobre nuestro servicio en Google?: https://maps.app.goo.gl/P7Ss6t3jpwRqJWDS7';

function validarCuerpo(cuerpo) {
  const { candidato, nombre } = cuerpo;

  if (!Number.isInteger(candidato) || candidato <= 0) return 'candidato debe ser un entero positivo';
  if (typeof nombre !== 'string' || nombre.trim().length < 2 || nombre.trim().length > 100) return 'nombre inválido';

  return null;
}

function relacionesNota(candidato) {
  return {
    candidate: { data: { id: String(candidato), type: 'candidates' } },
    user:      { data: { id: process.env.TEAMTAILOR_USER_ID || '43720', type: 'users' } },
  };
}

async function crearNotasTeamtailor(candidato, imageUrl) {
  await ttCrear('/notes', {
    data: { type: 'notes', attributes: { note: `Imagen de felicitación: ${imageUrl}` }, relationships: relacionesNota(candidato) },
  });
  await ttCrear('/notes', {
    data: { type: 'notes', attributes: { note: NOTA_GOOGLE }, relationships: relacionesNota(candidato) },
  });
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

  let cuerpo;
  try {
    cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  } catch {
    return res.status(400).json({ error: 'JSON inválido en el body' });
  }

  const errorValidacion = validarCuerpo(cuerpo);
  if (errorValidacion) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: errorValidacion }));
    return res.status(400).json({ error: errorValidacion });
  }

  const { candidato, nombre } = cuerpo;

  try {
    const buffer = await generarFelicitacion(nombre);
    const ruta = `${candidato}/felicitacion-${candidato}-${Date.now()}.png`;
    const url = await subirYFirmar(BUCKET, ruta, buffer);

    console.log(JSON.stringify({ etapa: 'felicitacion_generada', estado: 'ok', candidato_id: candidato }));

    try {
      await crearNotasTeamtailor(candidato, url);
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'teamtailor_nota', estado: 'error', candidato_id: candidato, mensaje: e.message }));
    }

    return res.status(201).json({ ok: true, url, action: 'created' });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'felicitacion_generada', estado: 'error', candidato_id: candidato, mensaje: error.message }));
    return res.status(500).json({ error: 'Error al generar la felicitación', details: error.message });
  }
}
