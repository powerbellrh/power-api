import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anotarCosto } from '../lib/registro.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// El envoltorio que deja una fila en `registros` por cada solicitud a un endpoint (lib/registro_de_endpoint.js).

const consola = console.log;
function entorno(opciones, manejar) {
  const supabase = crearSupabaseFalso({ autoincrementales: ['registros'] });
  const handler  = conRegistro({ origen: 'prueba', operacion: 'operacion', clienteSupabase: () => supabase, ...opciones }, manejar);
  return {
    supabase,
    async llamar(cuerpo = {}) {
      const respuesta = {};
      const res = { status(codigo) { respuesta.codigo = codigo; return res; }, json(dato) { respuesta.cuerpo = dato; return res; } };
      console.log = () => {};
      try { await handler({ method: 'POST', headers: {}, body: cuerpo }, res); } finally { console.log = consola; }
      return respuesta;
    },
    get filas() { return supabase.tablas.registros; },
  };
}

test('una solicitud que sale bien deja una fila con su referencia, sus cifras y su costo, y la respuesta no cambia', async () => {
  const e = entorno({
    actor: 'manychat', tipoReferencia: 'candidato', referencia: req => req.body.candidato,
    resumen: ({ cuerpo }) => ({ coincidencias: cuerpo.ids.length, nombre: 'Ana López' }),
  }, async (req, res) => { anotarCosto(0.002); return res.status(200).json({ ids: [1, 2, 3] }); });

  assert.deepEqual(await e.llamar({ candidato: 4321 }), { codigo: 200, cuerpo: { ids: [1, 2, 3] } });
  const [fila] = e.filas;
  assert.deepEqual(
    { origen: fila.origen, operacion: fila.operacion, estado: fila.estado, referencia: fila.referencia, tipo: fila.tipo_referencia, actor: fila.actor, costo: fila.costo_usd, error: fila.error, detalle: fila.detalle },
    { origen: 'prueba', operacion: 'operacion', estado: 'ok', referencia: '4321', tipo: 'candidato', actor: 'manychat', costo: 0.002, error: null, detalle: { coincidencias: 3, codigo: 200 } },
  );
  assert.ok(fila.segundos >= 0);
});

test('un 400 o más queda como error con su mensaje; si el handler lanza, se contesta 500 y también queda', async () => {
  const validacion = entorno({}, async (req, res) => res.status(400).json({ error: 'missing telefono field' }));
  assert.equal((await validacion.llamar()).codigo, 400);
  assert.deepEqual(validacion.filas.map(f => [f.estado, f.error, f.detalle.codigo]), [['error', 'missing telefono field', 400]]);

  const roto = entorno({ guardarSi: () => false }, async () => { throw new Error('TeamTailor GET /jobs/1 → 500'); });
  assert.deepEqual(await roto.llamar(), { codigo: 500, cuerpo: { error: 'TeamTailor GET /jobs/1 → 500' } });
  assert.deepEqual(roto.filas.map(f => [f.estado, f.error]), [['error', 'TeamTailor GET /jobs/1 → 500']], 'los errores se guardan aunque `guardarSi` diga que no');
});

test('lo que no hizo nada no se guarda, y las solicitudes sin permiso tampoco', async () => {
  const cron = entorno({ guardarSi: ({ cuerpo }) => cuerpo.total_found > 0 }, async (req, res) => res.status(200).json({ total_found: req.body.pendientes }));
  await cron.llamar({ pendientes: 0 });
  assert.equal(cron.filas.length, 0);
  await cron.llamar({ pendientes: 2 });
  assert.equal(cron.filas.length, 1);

  const ajeno = entorno({}, async (req, res) => res.status(401).json({ error: 'Unauthorized' }));
  assert.equal((await ajeno.llamar()).codigo, 401);
  assert.equal(ajeno.filas.length, 0);
});

test('`resumen` puede cambiar el estado, y `desdeElInicio` deja la fila abierta mientras corre', async () => {
  const descartada = entorno({ resumen: ({ cuerpo }) => (cuerpo.status === 'rejected' ? { estado: 'omitido', motivo: 'nombre_es_telefono' } : {}) }, async (req, res) => res.status(200).json({ status: 'rejected' }));
  await descartada.llamar();
  assert.deepEqual(descartada.filas.map(f => [f.estado, f.detalle.motivo]), [['omitido', 'nombre_es_telefono']]);

  let alCorrer;
  const largo = entorno({ desdeElInicio: true, resumen: () => ({ fuente: 'indeed' }) }, async (req, res) => { alCorrer = largo.filas.map(f => f.estado); anotarCosto(0.05); return res.status(200).json({ ok: true }); });
  await largo.llamar();
  assert.deepEqual(alCorrer, ['iniciado']);
  assert.deepEqual(largo.filas.map(f => [f.estado, f.costo_usd, f.detalle.fuente, Boolean(f.terminado)]), [['ok', 0.05, 'indeed', true]]);
});

test('si la tabla falla, la solicitud se contesta igual', async () => {
  const e = entorno({}, async (req, res) => res.status(200).json({ ok: true }));
  e.supabase.fallar = () => 'sin conexión';
  assert.deepEqual(await e.llamar(), { codigo: 200, cuerpo: { ok: true } });
});
