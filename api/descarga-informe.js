import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { waitUntil } from '@vercel/functions';
import { BUCKET_INFORMES, leerToken } from '../lib/informes/enlace.js';
import { avisar, crearRegistro } from '../lib/registro.js';
import { crearSupabase } from '../lib/supabase.js';

// GET /informes/descarga?t=<token>: entrega el PDF de un informe que el agente reclutador mandó por WhatsApp (ver
// lib/informes/enlace.js). Así el enlace es de esta API y no deja ver Supabase. El PDF se lee del bucket privado con
// un enlace firmado de un minuto que nunca sale de aquí, y se manda por partes conforme llega: Vercel no deja contestar
// más de 4.5 MB de una vez y el CV puede pesar más. La función sigue viva mientras se descarga: en vercel.json tiene
// 300 s porque un PDF de 10 MB en un celular con mala señal (menos de 1 Mbps) tarda más de un minuto.
//
// Cada descarga deja una fila en `registros` (origen 'informes', operación 'descarga'), también la de un enlace
// caducado. Un token que no se puede leer no se registra: es ruido de quien toca la URL.

const VIGENCIA_FIRMA_INTERNA_SEGUNDOS = 60;

const pagina = (titulo, texto) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title></head>`
  + `<body style="font-family:Calibri,Carlito,Arial,sans-serif;color:#121D33;max-width:32rem;margin:4rem auto;padding:0 1.5rem"><h1 style="font-size:1.4rem">${titulo}</h1><p>${texto}</p></body></html>`;

const PAGINAS = {
  invalido:    [404, pagina('Enlace no válido', 'Este enlace no es válido. Pídele el informe otra vez al asistente de PowerBell.')],
  caducado:    [410, pagina('El enlace ya caducó', 'Los enlaces de los informes valen 24 horas. Pega otra vez el enlace del candidato en el chat del asistente y te lo vuelve a armar.')],
  sin_archivo: [404, pagina('Informe no disponible', 'Este informe ya no está disponible. Pega otra vez el enlace del candidato en el chat del asistente y te lo vuelve a armar.')],
  error:       [502, pagina('No se pudo descargar', 'Hubo un problema al descargar el informe. Inténtalo de nuevo en un momento.')],
};

// El nombre del archivo con acentos va en `filename*`; `filename` lleva una versión sin acentos para navegadores viejos.
const disposicion = nombre => {
  const sencillo = String(nombre ?? 'Informe.pdf').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '');
  return `attachment; filename="${sencillo}"; filename*=UTF-8''${encodeURIComponent(nombre ?? 'Informe.pdf')}`;
};

const ENCABEZADOS_PRIVADOS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function contestarPagina(res, motivo) {
  const [codigo, html] = PAGINAS[motivo];
  res.writeHead(codigo, { ...ENCABEZADOS_PRIVADOS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// Lo hace todo menos crear el cliente y el registro, para poder probarlo. Devuelve lo que queda en `registros`.
export async function entregarInforme({ req, res, supabase, buscar = fetch }) {
  const enlace = leerToken(req.query?.t ?? new URL(req.url, 'http://x').searchParams.get('t'));
  if (enlace.error) {
    contestarPagina(res, enlace.error);
    return { estado: enlace.error === 'caducado' ? 'omitido' : null, motivo: enlace.error, codigo: PAGINAS[enlace.error][0], postulacion: enlace.postulacion };
  }

  let archivo;
  try {
    const { data, error } = await supabase.storage.from(BUCKET_INFORMES).createSignedUrl(enlace.ruta, VIGENCIA_FIRMA_INTERNA_SEGUNDOS);
    if (error) throw Object.assign(new Error(error.message), { sinArchivo: /not.?found|no existe/i.test(error.message) });
    archivo = await buscar(data.signedUrl);
    if (archivo.status === 404 || archivo.status === 400) throw Object.assign(new Error(`storage ${archivo.status}`), { sinArchivo: true });
    if (!archivo.ok || !archivo.body) throw new Error(`storage ${archivo.status}`);
  } catch (e) {
    const motivo = e.sinArchivo ? 'sin_archivo' : 'error';
    contestarPagina(res, motivo);
    return { estado: motivo === 'sin_archivo' ? 'omitido' : 'error', motivo, codigo: PAGINAS[motivo][0], postulacion: enlace.postulacion, error: e.message };
  }

  const largo = archivo.headers.get('content-length');
  res.writeHead(200, {
    ...ENCABEZADOS_PRIVADOS,
    'Content-Type': 'application/pdf',
    'Content-Disposition': disposicion(enlace.nombre),
    ...(largo ? { 'Content-Length': largo } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    await archivo.body.cancel?.().catch(() => {});
    return { estado: 'ok', codigo: 200, postulacion: enlace.postulacion, solo_encabezados: true };
  }
  await pipeline(Readable.fromWeb(archivo.body), res);
  return { estado: 'ok', codigo: 200, postulacion: enlace.postulacion, bytes: Number(largo) || null };
}

export default async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Método no permitido');
    return;
  }

  const supabase = crearSupabase();
  const inicio   = Date.now();
  let resultado;
  try {
    resultado = await entregarInforme({ req, res, supabase });
  } catch (error) {
    // Falló a medio envío (se cortó la conexión): la respuesta ya empezó, solo queda registrarlo.
    resultado = { estado: 'error', motivo: 'envio', error: error.message };
    if (!res.headersSent) contestarPagina(res, 'error');
    else res.destroy();
  }

  if (!resultado.estado) return; // token ilegible: no se registra
  // La respuesta ya terminó: sin waitUntil, Vercel puede congelar la función antes de guardar la fila.
  waitUntil(registrarDescarga(supabase, resultado, inicio));
}

async function registrarDescarga(supabase, { estado, postulacion, ...detalle }, inicio) {
  const registro = crearRegistro({ origen: 'informes', referencia: postulacion, tipoReferencia: 'postulacion' });
  try {
    registro.log('descarga', { ...detalle, estado, guardar: true, segundos: Number(((Date.now() - inicio) / 1000).toFixed(1)) });
    await registro.guardar(supabase);
  } catch (error) {
    avisar({ etapa: 'registros', estado: 'sin_guardar', error: error.message }); // el registro nunca tumba la descarga
  }
}
