// Comprobaciones que comparten los endpoints que se llaman con la clave de la API: que la solicitud sea POST y
// que traiga la clave (en `x-api-key` o como `Authorization: Bearer`). Si la solicitud no pasa, responde y
// devuelve true para que el endpoint termine:
//
//   if (rechazarSolicitud(req, res)) return;
//
// Si la variable de entorno de la clave no está definida no se exige (igual que antes de centralizarlo).
export function rechazarSolicitud(req, res, { clave = process.env.POWERBELL_API_KEY } = {}) {
  if (req.method !== 'POST') {
    console.log(JSON.stringify({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` }));
    res.status(405).json({ error: 'Método no permitido, usa POST' });
    return true;
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (clave && claveApi !== clave) {
    console.log(JSON.stringify({ etapa: 'auth', estado: 'error', mensaje: 'unauthorized' }));
    res.status(401).json({ error: 'Unauthorized' });
    return true;
  }

  return false;
}
