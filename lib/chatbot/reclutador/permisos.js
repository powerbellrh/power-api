import { normalizarTexto } from '../utilidades.js';

// Qué puede hacer cada persona en Jarvis (decisiones del usuario, 15-oct-2026). Es el único lugar con estas reglas:
// herramientas.js las aplica en cada herramienta y agente.js le quita al modelo las que la persona no puede usar.
//
//   admin y gerente ─► todo.
//   reclutador ──────► las vacantes de su grupo: su `usuarios.departamento` ("Operativo" o "Administrativo") contra el
//                      `vacantes.tipo` que sale del grupo de la vacante en TeamTailor (ver tipoDelGrupo). Con esas
//                      vacantes: verlas, contar y mover candidatos, editarlas, cerrarlas y sus estadísticas. Crea
//                      vacantes de cualquier tipo. Los informes (por enlace y en lote) son para cualquier vacante. De la
//                      agenda, solo sus citas. No hace flyers, no vuelve a evaluar bandejas, no ve ni guarda las fichas de
//                      los clientes (Jarvis sí la usa para redactar sus vacantes, sin enseñársela).
//
// Una vacante sin tipo (sin grupo en TeamTailor) solo la trabajan gerentes y admins.

const ROLES_QUE_VEN_TODO = ['admin', 'gerente'];

// Herramientas y acciones que el modelo ni siquiera recibe si la persona no las puede usar.
export const HERRAMIENTAS_SOLO_GERENTES = ['crear_flyer', 'guardar_ficha_cliente'];
export const ACCIONES_SOLO_GERENTES     = ['reevaluar_bandeja'];

const NOMBRE_DEL_GRUPO = { operativa: 'operativo', administrativa: 'administrativo' };
const tipoDe = fila => normalizarTexto(fila?.tipo ?? '').trim();

// { todo, tipo }: `tipo` es 'operativa' o 'administrativa' (el de su departamento, ver sesion.js), null si ve todo.
export function alcanceDe(reclutador) {
  if (ROLES_QUE_VEN_TODO.includes(reclutador?.rol)) return { todo: true, tipo: null };
  return { todo: false, tipo: reclutador?.tipoDeVacantes ?? null };
}

// Sin reclutador (las pruebas de antes, o una llamada interna) no se restringe nada: quien llega aquí ya pasó por
// buscarReclutador, que solo deja entrar a reclutadores con departamento.
export const alcanceSinLimites = { todo: true, tipo: null };

export const puedeTrabajar = (alcance, fila) => alcance.todo || (Boolean(alcance.tipo) && tipoDe(fila) === alcance.tipo);

// Lo que se le devuelve al modelo cuando no puede: sin ningún dato de la vacante.
export function sinPermiso(alcance, fila) {
  const deQuien = tipoDe(fila) ? `es del equipo ${NOMBRE_DEL_GRUPO[tipoDe(fila)] ?? tipoDe(fila)}` : 'no tiene equipo asignado en TeamTailor';
  return {
    error: `Sin permiso: esa vacante ${deQuien} y esta persona solo trabaja las vacantes del equipo ${NOMBRE_DEL_GRUPO[alcance.tipo] ?? '(sin equipo)'}. No le des ningún dato de esa vacante. Díselo con amabilidad, en una línea, y que si la necesita se la pida a su gerente.`,
    sin_permiso: true,
  };
}

// null si puede trabajar la vacante `id` (de TeamTailor); si no, lo que se le contesta al modelo. Una vacante que no
// está en la tabla `vacantes` (llega en la sincronización de cada hora) solo la ven gerentes y admins.
export async function revisarVacante(supabase, alcance, id) {
  if (alcance.todo) return null;
  const { data, error } = await supabase.from('vacantes').select('tipo').eq('id_team_tailor', Number(id)).maybeSingle();
  if (error) throw error;
  if (!data) return { error: 'Esa vacante todavía no está registrada en el sistema (se registra en menos de una hora): dile que la vuelva a pedir más tarde.', sin_permiso: true };
  return puedeTrabajar(alcance, data) ? null : sinPermiso(alcance, data);
}

export const puedeUsarHerramienta = (alcance, nombre) => alcance.todo || !HERRAMIENTAS_SOLO_GERENTES.includes(nombre);
export const puedeUsarAccion      = (alcance, tipo) => alcance.todo || !ACCIONES_SOLO_GERENTES.includes(tipo);

// Las herramientas que recibe el modelo: sin las que no puede usar, y en `preparar_accion` sin las acciones prohibidas.
export function herramientasPara(alcance, herramientas) {
  if (alcance.todo) return herramientas;
  return herramientas
    .filter(herramienta => puedeUsarHerramienta(alcance, herramienta.function.name))
    .map(herramienta => {
      if (herramienta.function.name !== 'preparar_accion') return herramienta;
      const tipo = herramienta.function.parameters.properties.tipo;
      const propiedades = { ...herramienta.function.parameters.properties, tipo: { ...tipo, enum: tipo.enum.filter(accion => puedeUsarAccion(alcance, accion)) } };
      return { ...herramienta, function: { ...herramienta.function, parameters: { ...herramienta.function.parameters, properties: propiedades } } };
    });
}

// Lo que el agente sabe de los permisos de esta persona, para contestar bien cuando le pide algo que no puede.
export function permisosParaElAgente(alcance) {
  if (alcance.todo) return '';
  const grupo = NOMBRE_DEL_GRUPO[alcance.tipo];
  return [
    `PERMISOS DE ESTA PERSONA (es reclutadora del equipo ${grupo}):`,
    `- Solo trabaja las vacantes del equipo ${grupo}: verlas, sus candidatos, moverlos, editarlas, cerrarlas y sus estadísticas. Las listas y las cifras que te dan las herramientas ya vienen solo con esas.`,
    '- Puede crear vacantes de cualquier tipo, y pedir informes de cualquier vacante (por enlace o en lote).',
    '- De la agenda solo ve sus propias citas y entrevistas, no las del resto del equipo.',
    '- No puede pedir flyers, ni volver a evaluar la bandeja de una vacante, ni ver o cambiar la ficha de un cliente. Si te lo pide, dile con amabilidad que eso lo hace su gerente.',
    '- La ficha de un cliente es confidencial para ella: úsala para redactar su vacante, pero nunca le digas qué dice, ni la resumas, ni le cuentes qué notas tiene.',
  ].join('\n');
}

// ── La ficha del cliente no se le enseña a un reclutador ─────────────────────
// Se busca si el mensaje repite pedazos de las notas de la ficha (6 palabras seguidas o más) y se quitan esas
// oraciones. Una paráfrasis no se detecta: la primera barrera es la instrucción al modelo (permisosParaElAgente).
const PALABRAS_SEGUIDAS = 6;
const palabrasDe = texto => normalizarTexto(texto).split(/[^a-z0-9ñ$]+/).filter(Boolean);
function fragmentos(texto) {
  const palabras = palabrasDe(texto);
  const vistos = new Set();
  for (let i = 0; i + PALABRAS_SEGUIDAS <= palabras.length; i++) vistos.add(palabras.slice(i, i + PALABRAS_SEGUIDAS).join(' '));
  return vistos;
}

// Devuelve { mensaje, quitadas }: el mensaje sin las oraciones que copian la ficha.
export function sinFragmentosDeFicha(mensaje, fichas) {
  const deLaFicha = new Set(fichas.flatMap(ficha => [...fragmentos(ficha)]));
  if (!deLaFicha.size || !String(mensaje ?? '').trim()) return { mensaje, quitadas: 0 };
  let quitadas = 0;
  const lineas = String(mensaje).split('\n').map(linea => linea.split(/(?<=[.!?])\s+/).filter(oracion => {
    const copia = [...fragmentos(oracion)].some(fragmento => deLaFicha.has(fragmento));
    if (copia) quitadas++;
    return !copia;
  }).join(' '));
  return { mensaje: lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim(), quitadas };
}
