import { generarCredencial } from '../lib/canvas_credencial.js';
import { subirYFirmar } from '../lib/storage_powerid.js';
import { ttCrear } from '../lib/clientes_api.js';

const BUCKET = 'powerID';
const REGEX_TELEFONO = /^[0-9+\-\s()]+$/;

function validarCuerpo(cuerpo) {
  const { candidato, nombre, vacante, fotografia, telefono, citado } = cuerpo;

  if (!Number.isInteger(candidato) || candidato <= 0) return 'candidato debe ser un entero positivo';
  if (typeof nombre !== 'string' || nombre.trim().length < 2 || nombre.trim().length > 100) return 'nombre inválido';
  if (typeof vacante !== 'string' || vacante.trim().length < 2 || vacante.trim().length > 100) return 'vacante inválida';
  if (typeof fotografia !== 'string' || !/^https?:\/\//.test(fotografia)) return 'fotografia debe ser una URL válida';
  if (typeof telefono !== 'string' || !REGEX_TELEFONO.test(telefono) || telefono.length < 7 || telefono.length > 20) return 'telefono inválido';
  if (typeof citado !== 'string' || citado.trim().length === 0) return 'citado inválido';

  return null;
}

async function crearNotaTeamtailor(candidato, imageUrl) {
  await ttCrear('/notes', {
    data: {
      type: 'notes',
      attributes: { note: `PowerID: ${imageUrl}` },
      relationships: {
        candidate: { data: { id: String(candidato), type: 'candidates' } },
        user:      { data: { id: process.env.TEAMTAILOR_USER_ID || '43720', type: 'users' } },
      },
    },
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

  const { candidato, nombre, vacante, fotografia, telefono, citado } = cuerpo;

  try {
    const buffer = await generarCredencial({ nombre, vacante, fotografia, telefono, citado });
    const ruta = `${candidato}/candidato-${candidato}-${Date.now()}.png`;
    const url = await subirYFirmar(BUCKET, ruta, buffer);

    console.log(JSON.stringify({ etapa: 'powerid_generado', estado: 'ok', candidato_id: candidato }));

    try {
      await crearNotaTeamtailor(candidato, url);
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'teamtailor_nota', estado: 'error', candidato_id: candidato, mensaje: e.message }));
    }

    return res.status(201).json({ ok: true, url, action: 'created' });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'powerid_generado', estado: 'error', candidato_id: candidato, mensaje: error.message }));
    return res.status(500).json({ error: 'Error al generar el PowerID', details: error.message });
  }
}
