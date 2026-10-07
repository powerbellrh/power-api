// Ayudantes compartidos para leer una vacante de TeamTailor y guardarla en Supabase (los usan el backfill
// de la agenda y la sincronización del chatbot).

// Mismo catálogo que usa `historial.js`/las herramientas de migración para clasificar
// el tipo de vacante según el reclutador (id de usuario) asignado en Teamtailor.
export const RECLUTADORES_OPERATIVA = new Set([
  '42381', '82313', '46016', '107180', '64360', '76703',
  '45146', '45147', '46250', '68768', '44696',
]);

export const CONTEXTO_CUSTOM_FIELD_ID = '8036';

export function extraerIncluidos(detalle, tipo) {
  return (detalle.included ?? []).filter(item => item.type === tipo);
}

// Ver nota equivalente en `migrar_vacantes_teamtailor.py::extraer_contexto`: Teamtailor
// no regresa el linkage custom-field-value -> custom-field, así que se asume que el
// (único) custom-field-value incluido es el de "contexto" cuando ese campo está incluido.
export function extraerContexto(detalle) {
  const tieneContexto = extraerIncluidos(detalle, 'custom-fields').some(campo => campo.id === CONTEXTO_CUSTOM_FIELD_ID);
  if (!tieneContexto) return null;

  const valores = extraerIncluidos(detalle, 'custom-field-values');
  return valores[0]?.attributes?.value ?? null;
}

// Vacante recién creada: se asigna a todos los usuarios excepto los de id_rol 1 (admin), para que
// cualquier reclutador/gerente ya la vea sin tener que asignarla a mano.
export async function asignarReclutadoresATodaLaVacante(supabase, idVacante) {
  const { data: usuarios, error: errorUsuarios } = await supabase
    .from('usuarios').select('id').neq('id_rol', 1);
  if (errorUsuarios) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_asignacion', estado: 'error', mensaje: errorUsuarios.message }));
    return;
  }
  if (!usuarios?.length) return;

  const { error: errorInsert } = await supabase
    .from('reclutadores_asignados')
    .insert(usuarios.map(u => ({ id_vacante: idVacante, id_usuario: u.id })));
  if (errorInsert) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_asignacion', estado: 'error', mensaje: errorInsert.message }));
  }
}
