import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { entregarInforme } from '../api/descarga-informe.js';
import { crearToken, enlaceDeDescarga, leerToken } from '../lib/informes/enlace.js';

// Los PDF de los informes se descargan con un enlace de esta API (no el de Supabase): el token va cifrado, no se puede
// alterar y caduca.

before(() => { process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'clave-de-prueba'; });

const ARCHIVO = { ruta: 'informes/candidato-313131-postulacion-987654-1.pdf', nombre: 'Peninsula - Informe Ana López Pérez. Almacenista. Oct26.pdf', postulacion: '987654' };
const PDF = Buffer.from('%PDF-1.7 contenido del informe');

function respuestaFalsa() {
  const partes = [];
  const res = new Writable({ write(parte, _, listo) { partes.push(Buffer.from(parte)); listo(); } });
  res.writeHead = (codigo, encabezados) => { Object.assign(res, { codigo, encabezados, headersSent: true }); return res; };
  res.cuerpo = () => Buffer.concat(partes);
  return res;
}

function supabaseFalso({ error = null } = {}) {
  const firmadas = [];
  return {
    firmadas,
    storage: { from: bucket => ({ createSignedUrl: async (ruta, segundos) => {
      firmadas.push({ bucket, ruta, segundos });
      return error ? { data: null, error: { message: error } } : { data: { signedUrl: `https://proyecto.supabase.co/storage/v1/object/sign/${bucket}/${ruta}?token=x` }, error: null };
    } }) },
  };
}

const pedir = (token, metodo = 'GET') => ({ method: metodo, query: { t: token }, url: `/informes/descarga?t=${token}` });

test('el token esconde el archivo y su nombre, no se puede alterar y caduca', () => {
  const token = crearToken(ARCHIVO, 24 * 60 * 60);
  assert.deepEqual(leerToken(token), ARCHIVO);
  assert.ok(!Buffer.from(token, 'base64url').toString('latin1').includes('López'), 'el nombre del candidato no se puede leer en el enlace');
  assert.ok(!token.includes('987654') && !token.includes('313131'));

  const alterado = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.at(-1);
  assert.deepEqual(leerToken(alterado), { error: 'invalido' });
  assert.deepEqual(leerToken('basura'), { error: 'invalido' });
  assert.deepEqual(leerToken(undefined), { error: 'invalido' });

  const deAyer = crearToken(ARCHIVO, 24 * 60 * 60, Date.now() - 25 * 60 * 60 * 1000);
  assert.deepEqual(leerToken(deAyer), { error: 'caducado', postulacion: '987654' });
});

test('el enlace es de esta API, no de Supabase', () => {
  const enlace = enlaceDeDescarga(ARCHIVO, 60);
  assert.match(enlace, /^https:\/\/[^/]+\/informes\/descarga\?t=[\w-]+$/);
  assert.ok(!enlace.includes('supabase'));
});

test('la descarga entrega el PDF del bucket privado con su nombre, sin que se vea Supabase', async () => {
  const supabase = supabaseFalso();
  const res = respuestaFalsa();
  const pedidas = [];
  const resultado = await entregarInforme({
    req: pedir(crearToken(ARCHIVO, 60)), res, supabase,
    buscar: async url => { pedidas.push(url); return new Response(PDF, { headers: { 'content-length': String(PDF.length) } }); },
  });

  assert.deepEqual(supabase.firmadas, [{ bucket: 'recursos', ruta: 'informes/candidato-313131-postulacion-987654-1.pdf', segundos: 60 }], 'la firma de Supabase es de un minuto y no sale de aquí');
  assert.equal(pedidas.length, 1);
  assert.equal(res.codigo, 200);
  assert.equal(res.encabezados['Content-Type'], 'application/pdf');
  assert.equal(res.encabezados['Cache-Control'], 'private, no-store');
  assert.equal(res.encabezados['Content-Disposition'], `attachment; filename="Peninsula - Informe Ana Lopez Perez. Almacenista. Oct26.pdf"; filename*=UTF-8''${encodeURIComponent(ARCHIVO.nombre)}`);
  assert.deepEqual(res.cuerpo(), PDF);
  assert.ok(!JSON.stringify(res.encabezados).includes('supabase'));
  assert.deepEqual(resultado, { estado: 'ok', codigo: 200, postulacion: '987654', bytes: PDF.length });
});

test('un enlace caducado, alterado o de un archivo que ya no está contesta con una página que explica qué hacer', async () => {
  const caducado = respuestaFalsa();
  const deAyer = crearToken(ARCHIVO, 60, Date.now() - 2 * 60 * 60 * 1000);
  assert.deepEqual(await entregarInforme({ req: pedir(deAyer), res: caducado, supabase: supabaseFalso() }), { estado: 'omitido', motivo: 'caducado', codigo: 410, postulacion: '987654' });
  assert.equal(caducado.codigo, 410);
  assert.match(caducado.cuerpo().toString(), /valen 24 horas/);

  const alterado = respuestaFalsa();
  const resultado = await entregarInforme({ req: pedir('no-es-un-token'), res: alterado, supabase: supabaseFalso() });
  assert.equal(alterado.codigo, 404);
  assert.equal(resultado.estado, null, 'un token ilegible no se registra');

  const borrado = respuestaFalsa();
  const sinArchivo = await entregarInforme({ req: pedir(crearToken(ARCHIVO, 60)), res: borrado, supabase: supabaseFalso({ error: 'Object not found' }) });
  assert.equal(borrado.codigo, 404);
  assert.match(borrado.cuerpo().toString(), /ya no está disponible/);
  assert.deepEqual({ estado: sinArchivo.estado, motivo: sinArchivo.motivo }, { estado: 'omitido', motivo: 'sin_archivo' });
});

test('HEAD (la vista previa de un enlace) solo recibe los encabezados', async () => {
  const res = respuestaFalsa();
  const resultado = await entregarInforme({ req: pedir(crearToken(ARCHIVO, 60), 'HEAD'), res, supabase: supabaseFalso(), buscar: async () => new Response(PDF) });
  assert.equal(res.codigo, 200);
  assert.equal(res.cuerpo().length, 0);
  assert.equal(resultado.solo_encabezados, true);
});
