import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearSupabaseFalso } from './supabase_falso.js';
import { sincronizarVacantes, diferencias } from '../lib/sincronizar_vacantes.js';

const copia = (id, extra = {}) => ({
  id, id_team_tailor: id * 10, vacante: `Cliente - Puesto ${id}`, titulo_externo: `Puesto ${id}`, descripcion: '<p>Hola</p>',
  salario_min: null, salario_max: null, estatus: 'Publicada', contexto: null, ...extra,
});
const atributos = (id, extra = {}) => ({
  'internal-name': `Cliente - Puesto ${id}`, title: `Puesto ${id}`, body: '<p>Hola</p>', 'min-salary': null, 'max-salary': null, status: 'open', ...extra,
});

// TeamTailor falso: el listado devuelve las abiertas/ocultas y el detalle cualquier vacante.
function teamtailorFalso(vacantes) {
  const llamadas = [];
  const obtener = async ruta => {
    llamadas.push(ruta);
    if (ruta.startsWith('/jobs?')) {
      const estado = ruta.match(/filter\[status\]=(\w+)/)?.[1] ?? 'open';
      return { data: Object.entries(vacantes).filter(([, a]) => a.status === estado).map(([id, attributes]) => ({ id, attributes })), links: {} };
    }
    const id = ruta.match(/\/jobs\/(\d+)/)[1];
    if (!vacantes[id]) throw new Error(`TeamTailor GET ${ruta} → 404: no existe`);
    return { data: { id, attributes: vacantes[id] }, included: [] };
  };
  return { obtener, llamadas };
}

test('no escribe nada si las copias ya están al día', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1)] } });
  const { obtener, llamadas } = teamtailorFalso({ 10: atributos(1) });

  assert.deepEqual(await sincronizarVacantes(supabase, { obtener }), { revisadas: 1, actualizadas: 0, cerradas: 0, errores: 0 });
  assert.equal(llamadas.some(ruta => /include=/.test(ruta)), false); // sin cambios no pide el detalle
});

test('actualiza solo lo que cambió', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2)] } });
  const { obtener } = teamtailorFalso({ 10: atributos(1, { body: '<p>Nuevo texto</p>', 'min-salary': 9000 }), 20: atributos(2) });

  const resumen = await sincronizarVacantes(supabase, { obtener });

  assert.equal(resumen.actualizadas, 1);
  assert.equal(supabase.tablas.vacantes[0].descripcion, '<p>Nuevo texto</p>');
  assert.equal(supabase.tablas.vacantes[0].salario_min, 9000);
  assert.equal(supabase.tablas.vacantes[0].vacante, 'Cliente - Puesto 1');
});

test('marca como cerrada la vacante que ya no está abierta y no vuelve a consultar las cerradas', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2, { estatus: 'Cerrada' })] } });
  const { obtener, llamadas } = teamtailorFalso({ 10: atributos(1, { status: 'archived' }), 20: atributos(2, { status: 'archived' }) });

  const resumen = await sincronizarVacantes(supabase, { obtener });

  assert.deepEqual(resumen, { revisadas: 2, actualizadas: 1, cerradas: 1, errores: 0 });
  assert.equal(supabase.tablas.vacantes[0].estatus, 'Cerrada');
  assert.equal(llamadas.some(ruta => ruta === '/jobs/20'), false);
});

test('reabre una vacante cerrada que volvió a estar abierta', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1, { estatus: 'Cerrada' })] } });
  const { obtener } = teamtailorFalso({ 10: atributos(1, { status: 'unlisted' }) });

  await sincronizarVacantes(supabase, { obtener });

  assert.equal(supabase.tablas.vacantes[0].estatus, 'Publicada');
});

test('una vacante que ya no existe en TeamTailor se deja igual y un error no frena a las demás', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2), copia(3)] } });
  const { obtener: base } = teamtailorFalso({ 20: atributos(2, { title: 'Otro título' }), 30: atributos(3, { title: 'Otro título' }) });
  const obtener = async ruta => { if (ruta.startsWith('/jobs/30')) throw new Error('TeamTailor GET → 500'); return base(ruta); };

  const resumen = await sincronizarVacantes(supabase, { obtener });

  assert.deepEqual(resumen, { revisadas: 3, actualizadas: 1, cerradas: 0, errores: 1 });
  assert.equal(supabase.tablas.vacantes[0].estatus, 'Publicada');
});

test('diferencias ignora lo igual y trata null y ausente como lo mismo', () => {
  assert.deepEqual(diferencias(copia(1), atributos(1)), {});
  assert.deepEqual(diferencias(copia(1), atributos(1, { 'internal-name': '', title: 'Puesto 1' })), { vacante: 'Puesto 1' });
});
