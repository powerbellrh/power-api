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

// TeamTailor falso: el listado devuelve las abiertas/ocultas y el detalle cualquier vacante. `grupos` (id → nombre del
// grupo) imita a TeamTailor: el grupo solo viene si se pidió con include=team.
const GRUPOS = { 'Reclutamiento Operativo': '615', 'Reclutamiento Administrativo': '616' };
function teamtailorFalso(vacantes, grupos = {}) {
  const llamadas = [];
  const conGrupo = (ruta, id, attributes) => {
    const pidioGrupo = /include=[^&]*team/.test(ruta);
    const grupo = pidioGrupo && grupos[id] ? { id: GRUPOS[grupos[id]], type: 'teams' } : null;
    return { vacante: { id, attributes, relationships: { team: { data: grupo } } }, incluido: grupo ? [{ type: 'teams', id: grupo.id, attributes: { name: grupos[id] } }] : [] };
  };
  const obtener = async ruta => {
    llamadas.push(ruta);
    if (ruta.startsWith('/jobs?')) {
      const estado = ruta.match(/filter\[status\]=(\w+)/)?.[1] ?? 'open';
      const listadas = Object.entries(vacantes).filter(([, a]) => a.status === estado).map(([id, attributes]) => conGrupo(ruta, id, attributes));
      return { data: listadas.map(l => l.vacante), included: listadas.flatMap(l => l.incluido), links: {} };
    }
    const id = ruta.match(/\/jobs\/(\d+)/)[1];
    if (!vacantes[id]) throw new Error(`TeamTailor GET ${ruta} → 404: no existe`);
    const { vacante, incluido } = conGrupo(ruta, id, vacantes[id]);
    return { data: vacante, included: incluido };
  };
  return { obtener, llamadas };
}

test('no escribe nada si las copias ya están al día', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1)] } });
  const { obtener, llamadas } = teamtailorFalso({ 10: atributos(1) });

  assert.deepEqual(await sincronizarVacantes(supabase, { obtener, crear: null, detectores: null }), { revisadas: 1, actualizadas: 0, cerradas: 0, errores: 0 });
  assert.equal(llamadas.some(ruta => /^\/jobs\/\d+/.test(ruta)), false); // sin cambios no pide el detalle
});

test('actualiza solo lo que cambió', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2)] } });
  const { obtener } = teamtailorFalso({ 10: atributos(1, { body: '<p>Nuevo texto</p>', 'min-salary': 9000 }), 20: atributos(2) });

  const resumen = await sincronizarVacantes(supabase, { obtener, crear: null, detectores: null });

  assert.equal(resumen.actualizadas, 1);
  assert.equal(supabase.tablas.vacantes[0].descripcion, '<p>Nuevo texto</p>');
  assert.equal(supabase.tablas.vacantes[0].salario_min, 9000);
  assert.equal(supabase.tablas.vacantes[0].vacante, 'Cliente - Puesto 1');
});

test('marca como cerrada la vacante que ya no está abierta y no vuelve a consultar las cerradas', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2, { estatus: 'Cerrada' })] } });
  const { obtener, llamadas } = teamtailorFalso({ 10: atributos(1, { status: 'archived' }), 20: atributos(2, { status: 'archived' }) });

  const resumen = await sincronizarVacantes(supabase, { obtener, crear: null, detectores: null });

  assert.deepEqual(resumen, { revisadas: 2, actualizadas: 1, cerradas: 1, errores: 0 });
  assert.equal(supabase.tablas.vacantes[0].estatus, 'Cerrada');
  assert.equal(llamadas.some(ruta => ruta === '/jobs/20'), false);
});

test('reabre una vacante cerrada que volvió a estar abierta', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1, { estatus: 'Cerrada' })] } });
  const { obtener } = teamtailorFalso({ 10: atributos(1, { status: 'unlisted' }) });

  await sincronizarVacantes(supabase, { obtener, crear: null, detectores: null });

  assert.equal(supabase.tablas.vacantes[0].estatus, 'Publicada');
});

test('una vacante que ya no existe en TeamTailor se deja igual y un error no frena a las demás', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [copia(1), copia(2), copia(3)] } });
  const { obtener: base } = teamtailorFalso({ 20: atributos(2, { title: 'Otro título' }), 30: atributos(3, { title: 'Otro título' }) });
  const obtener = async ruta => { if (ruta.startsWith('/jobs/30')) throw new Error('TeamTailor GET → 500'); return base(ruta); };

  const resumen = await sincronizarVacantes(supabase, { obtener, crear: null, detectores: null });

  assert.deepEqual(resumen, { revisadas: 3, actualizadas: 1, cerradas: 0, errores: 1 });
  assert.equal(supabase.tablas.vacantes[0].estatus, 'Publicada');
});

test('el tipo sigue al grupo de TeamTailor: lo corrige si cambió y lo deja si la vacante no tiene grupo', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [
    copia(1, { tipo: 'Operativa' }),       // le cambiaron el grupo a administrativo
    copia(2, { tipo: 'Administrativa' }),  // sin grupo: se queda como estaba
    copia(3, { tipo: 'Operativa' }),       // oculta y fuera del listado: se consulta sola, también con su grupo
  ] } });
  const { obtener, llamadas } = teamtailorFalso(
    { 10: atributos(1), 20: atributos(2), 30: atributos(3, { status: 'unlisted' }) },
    { 10: 'Reclutamiento Administrativo', 30: 'Reclutamiento Administrativo' },
  );
  const sinOcultas = async ruta => (ruta.includes('unlisted') ? { data: [], links: {} } : obtener(ruta));

  const resumen = await sincronizarVacantes(supabase, { obtener: sinOcultas, crear: null, detectores: null });

  assert.deepEqual(supabase.tablas.vacantes.map(fila => fila.tipo), ['Administrativa', 'Administrativa', 'Administrativa']);
  assert.equal(resumen.actualizadas, 2);
  assert.ok(llamadas.includes('/jobs/30?include=team'));
});

test('diferencias ignora lo igual y trata null y ausente como lo mismo', () => {
  assert.deepEqual(diferencias(copia(1), atributos(1)), {});
  assert.deepEqual(diferencias(copia(1), atributos(1, { 'internal-name': '', title: 'Puesto 1' })), { vacante: 'Puesto 1' });
});

test('agrega las vacantes de TeamTailor que faltan y completa cliente, periodo, tipo, habilidades, ubicación y contexto', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    vacantes: [copia(1, { vacante: 'Península - Puesto 1', tipo: null, creado: '2026-10-01T00:00:00Z', habilidades: null, id_empresa: null, salario_periodo: null })],
    empresas: [{ id: 7, nombre: 'Península' }, { id: 8, nombre: 'Convert Solutions' }],
    ubicaciones_seleccionadas: [],
  } });
  const vacantes = {
    10: atributos(1, { 'internal-name': 'Península - Puesto 1', 'salary-time-unit': 'monthly' }),
    20: atributos(2, { 'internal-name': 'Convert - Puesto 2' }),
  };
  const { obtener } = teamtailorFalso(vacantes, { 10: 'Reclutamiento Operativo', 20: 'Reclutamiento Operativo' });
  const creadas = [];
  const crear = async (_, id) => { creadas.push(id); supabase.tablas.vacantes.push(copia(2, { id_team_tailor: id, vacante: 'Convert - Puesto 2', tipo: 'Operativa', creado: '2026-10-02T00:00:00Z' })); return true; };
  const detectores = { habilidad: async () => 'Almacén', ubicacion: async () => 55 };

  const resumen = await sincronizarVacantes(supabase, { obtener, crear, detectores });

  assert.deepEqual(creadas, [20]);
  assert.deepEqual({ nuevas: resumen.nuevas, pendientes: resumen.pendientes, completadas: resumen.completadas, errores: resumen.errores }, { nuevas: 1, pendientes: 0, completadas: 2, errores: 0 });
  const [primera, segunda] = supabase.tablas.vacantes;
  assert.deepEqual({ id_empresa: primera.id_empresa, salario_periodo: primera.salario_periodo, tipo: primera.tipo, habilidades: primera.habilidades },
    { id_empresa: 7, salario_periodo: 'Mensual', tipo: 'Operativa', habilidades: 'Almacén' });
  assert.equal(segunda.id_empresa, 8, '"Convert" es el único cliente cuyo nombre lo contiene');
  assert.deepEqual(supabase.tablas.ubicaciones_seleccionadas.map(fila => [fila.id_ubicacion, fila.id_vacante]), [[55, 1], [55, 2]]);

  // Una segunda corrida ya no tiene nada que hacer.
  const otra = await sincronizarVacantes(supabase, { obtener, crear, detectores });
  assert.deepEqual({ nuevas: otra.nuevas, actualizadas: otra.actualizadas, completadas: otra.completadas }, { nuevas: 0, actualizadas: 0, completadas: 0 });
});
