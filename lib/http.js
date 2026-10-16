import { createHash, timingSafeEqual } from 'node:crypto';
import { avisar } from './registro.js';

// Compara en tiempo constante (que no se pueda adivinar la clave midiendo cuánto tarda la respuesta). Sin clave
// configurada nunca coincide: si la variable de entorno falta, se rechaza todo en vez de quedar abierto. Jarvis
// reconoce a la persona solo por el teléfono que manda ManyChat, así que esta clave es lo único que impide hacerse
// pasar por alguien del equipo (16-oct-2026).
export function claveCorrecta(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const huella = texto => createHash('sha256').update(texto).digest();
  return timingSafeEqual(huella(recibida), huella(esperada));
}

// Comprobaciones que comparten los endpoints que se llaman con la clave de la API: que la solicitud sea POST y
// que traiga la clave (en `x-api-key` o como `Authorization: Bearer`). Si la solicitud no pasa, responde y
// devuelve true para que el endpoint termine:
//
//   if (rechazarSolicitud(req, res)) return;
export function rechazarSolicitud(req, res, { clave = process.env.POWERBELL_API_KEY } = {}) {
  if (req.method !== 'POST') {
    avisar({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` });
    res.status(405).json({ error: 'Método no permitido, usa POST' });
    return true;
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (!claveCorrecta(claveApi, clave)) {
    avisar({ etapa: 'auth', estado: 'error', mensaje: clave ? 'unauthorized' : 'falta la clave en las variables de entorno' });
    res.status(401).json({ error: 'Unauthorized' });
    return true;
  }

  return false;
}

// Los cron de Vercel (vercel.json) llegan con `Authorization: Bearer <CRON_SECRET>`. Igual que rechazarSolicitud:
// si la solicitud no pasa, responde y devuelve true.
export function rechazarCron(req, res) {
  if (claveCorrecta(req.headers['authorization'], process.env.CRON_SECRET && `Bearer ${process.env.CRON_SECRET}`)) return false;
  res.status(401).json({ error: 'Unauthorized' });
  return true;
}
