import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actualizarEstatusPostulacion } from '../api/historial.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// `postulaciones.estatus` sigue al webhook de cambios de etapa de TeamTailor (job_application.update): 'rechazada'
// cuando trae `rejected_at`, 'activa' cuando no (también si se deshace el rechazo).

const crear = () => crearSupabaseFalso({ tablas: { postulaciones: [
  { id: 1, id_team_tailor: '9000', estatus: 'activa' },
  { id: 2, id_team_tailor: '9001', estatus: 'activa' },
] } });
const estatus = supabase => supabase.tablas.postulaciones.map(p => [p.id_team_tailor, p.estatus]);

test('un rechazo marca la postulación como rechazada; las demás no se tocan', async () => {
  const supabase = crear();
  await actualizarEstatusPostulacion(supabase, { id: 9000, rejected_at: '2026-10-11T18:00:00Z', stage_name: 'Inbox' });
  assert.deepEqual(estatus(supabase), [['9000', 'rechazada'], ['9001', 'activa']]);
});

test('si se deshace el rechazo vuelve a quedar activa', async () => {
  const supabase = crear();
  await actualizarEstatusPostulacion(supabase, { id: 9000, rejected_at: '2026-10-11T18:00:00Z' });
  await actualizarEstatusPostulacion(supabase, { id: 9000, rejected_at: null, stage_name: 'Entrevista' });
  assert.deepEqual(estatus(supabase), [['9000', 'activa'], ['9001', 'activa']]);
});

test('una postulación que no está en Supabase no hace nada ni falla', async () => {
  const supabase = crear();
  await actualizarEstatusPostulacion(supabase, { id: 123, rejected_at: '2026-10-11T18:00:00Z' });
  assert.deepEqual(estatus(supabase), [['9000', 'activa'], ['9001', 'activa']]);
});
