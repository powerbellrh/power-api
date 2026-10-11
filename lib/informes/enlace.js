import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// Enlaces de descarga de los informes en PDF con la dirección de esta API (no la de Supabase): el agente reclutador
// manda `https://<api>/informes/descarga?t=<token>` y api/descarga-informe.js lo entrega desde el bucket privado.
//
// El token va cifrado y firmado (AES-256-GCM): nadie puede leer qué archivo es ni cómo se llama (el nombre trae el
// del candidato), ni cambiarlo, ni alargarle la vigencia. La clave sale de la de servicio de Supabase, así que no hay
// otra variable de entorno que configurar; si esa clave cambia, los enlaces que había dejan de servir (duran un día).

export const BUCKET_INFORMES = 'informes'; // privado: los PDF solo salen por api/descarga-informe.js
const DOMINIO_POR_OMISION = 'power-api-alpha.vercel.app'; // el que usa PowerInforme

const clave = () => {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para firmar los enlaces de informes');
  return createHmac('sha256', base).update('power-api/enlaces-de-informes').digest();
};

const aBase64Url = buffer => buffer.toString('base64url');

// `ruta` es la del archivo en el bucket; `nombre`, el del archivo al descargarlo; `postulacion`, para `registros`.
export function crearToken({ ruta, nombre, postulacion }, vigenciaSegundos, ahora = Date.now()) {
  const datos = JSON.stringify({ r: ruta, n: nombre, p: String(postulacion), e: Math.floor(ahora / 1000) + vigenciaSegundos });
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave(), iv);
  const cifrado = Buffer.concat([cifrador.update(datos, 'utf8'), cifrador.final()]);
  return aBase64Url(Buffer.concat([iv, cifrador.getAuthTag(), cifrado]));
}

// { ruta, nombre, postulacion } si el token es bueno y sigue vigente; { error: 'invalido' | 'caducado' } si no.
export function leerToken(token, ahora = Date.now()) {
  try {
    const crudo = Buffer.from(String(token ?? ''), 'base64url');
    if (crudo.length < 29) return { error: 'invalido' };
    const descifrador = createDecipheriv('aes-256-gcm', clave(), crudo.subarray(0, 12));
    descifrador.setAuthTag(crudo.subarray(12, 28));
    const datos = JSON.parse(Buffer.concat([descifrador.update(crudo.subarray(28)), descifrador.final()]).toString('utf8'));
    if (!datos.r || !Number.isFinite(datos.e)) return { error: 'invalido' };
    if (Math.floor(ahora / 1000) > datos.e) return { error: 'caducado', postulacion: datos.p };
    return { ruta: datos.r, nombre: datos.n, postulacion: datos.p };
  } catch {
    return { error: 'invalido' };
  }
}

export function enlaceDeDescarga(archivo, vigenciaSegundos) {
  const dominio = process.env.VERCEL_PROJECT_PRODUCTION_URL || DOMINIO_POR_OMISION;
  return `https://${dominio}/informes/descarga?t=${crearToken(archivo, vigenciaSegundos)}`;
}
