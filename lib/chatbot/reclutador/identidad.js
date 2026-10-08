// El agente reclutador atiende a quien tiene su teléfono en la tabla `usuarios` con rol de gerente o administrador.
// Los usuarios con rol de reclutador se tratan como cualquier candidato. El teléfono se compara por los últimos 10
// dígitos porque ManyChat lo manda con lada de país ("521...") y en `usuarios` se guarda sin ella.

const diezDigitos = telefono => String(telefono ?? '').replace(/\D/g, '').slice(-10);

const ROLES_CON_AGENTE = ['gerente', 'admin']; // nombres de la tabla `roles`

// Devuelve { id, nombre, rol } del usuario, o null si a ese teléfono no le corresponde el agente.
export async function buscarReclutador(supabase, telefono) {
  const buscado = diezDigitos(telefono);
  if (buscado.length < 10) return null;

  const { data, error } = await supabase.from('usuarios').select('id, nombre, telefono, id_rol');
  if (error) throw error;

  const usuario = (data ?? []).find(fila => fila.telefono != null && diezDigitos(fila.telefono) === buscado);
  if (!usuario) return null;

  const { data: rol, error: errorRol } = await supabase.from('roles').select('nombre').eq('id', usuario.id_rol).maybeSingle();
  if (errorRol) throw errorRol;

  return ROLES_CON_AGENTE.includes(rol?.nombre) ? { id: usuario.id, nombre: usuario.nombre ?? '', rol: rol.nombre } : null;
}
