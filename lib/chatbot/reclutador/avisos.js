import { normalizarTexto } from '../utilidades.js';

// Textos que el sistema arma por su cuenta (no el modelo) para que la reclutadora revise una vacante: qué cambió desde
// el último resumen, qué completó el agente por ella y si ya existe una vacante igual.

const MAXIMO_LINEAS = 6;

const textoPlano = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const renglones  = html => [...String(html ?? '').matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(([, contenido]) => textoPlano(contenido));
const esSueldo   = renglon => /sueldo|salario|\$/i.test(renglon);

// Qué cambió entre el borrador que ya se le mostró y el nuevo. '' si no hay nada que decir.
export function resumenDeCambios(previo, nuevo) {
  const lineas = [];
  for (const [campo, etiqueta] of [['nombre_interno', 'Nombre interno'], ['titulo', 'Título'], ['tipo', 'Tipo'], ['ubicacion', 'Ubicación'], ['contexto', 'Contexto']]) {
    if ((previo[campo] ?? '') && (nuevo[campo] ?? '') !== previo[campo]) lineas.push(`${etiqueta}: ${campo === 'contexto' ? 'cambió' : `${previo[campo]} → ${nuevo[campo]}`}`);
  }

  if ((previo.descripcion ?? '') && nuevo.descripcion !== previo.descripcion) {
    const antes = renglones(previo.descripcion);
    const ahora = renglones(nuevo.descripcion);
    const sueldoAntes = antes.find(esSueldo);
    const sueldoAhora = ahora.find(esSueldo);
    if (sueldoAntes && sueldoAhora && sueldoAntes !== sueldoAhora) lineas.push(`Sueldo: ${sueldoAntes} → ${sueldoAhora}`);

    const nuevos = ahora.filter(renglon => !antes.includes(renglon) && renglon !== sueldoAhora);
    const quitados = antes.filter(renglon => !ahora.includes(renglon) && renglon !== sueldoAntes);
    for (const renglon of nuevos)   lineas.push(`Agregué: ${renglon}`);
    for (const renglon of quitados) lineas.push(`Quité: ${renglon}`);
    if (!nuevos.length && !quitados.length && !(sueldoAntes && sueldoAhora && sueldoAntes !== sueldoAhora)) lineas.push('Cambié la redacción del anuncio');
  }

  if (!lineas.length) return '';
  const mostradas = lineas.slice(0, MAXIMO_LINEAS).map(linea => `- ${linea}`);
  if (lineas.length > MAXIMO_LINEAS) mostradas.push(`- y ${lineas.length - MAXIMO_LINEAS} cambios más en el anuncio`);
  return `*Esto cambió desde el último resumen:*\n${mostradas.join('\n')}`;
}

// Lo que el agente completó por su cuenta.
export function resumenDeSupuestos(supuestos) {
  const lista = (Array.isArray(supuestos) ? supuestos : []).map(texto => String(texto ?? '').trim()).filter(Boolean).slice(0, 8);
  return lista.length ? `*Lo que completé yo, revísalo:*\n${lista.map(texto => `- ${texto}`).join('\n')}` : '';
}

// Vacantes publicadas con el mismo cliente y puesto (sin contar la ciudad entre paréntesis).
const baseDelNombre = nombre => normalizarTexto(nombre).replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const ciudadDelNombre = nombre => normalizarTexto(/\(([^)]+)\)\s*$/.exec(String(nombre ?? ''))?.[1] ?? '').trim();

export async function buscarDuplicados(supabase, nombreInterno) {
  const base = baseDelNombre(nombreInterno);
  if (!base) return [];

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, estatus');
  if (error) return [];
  return (data ?? [])
    .filter(fila => fila.id_team_tailor != null && fila.estatus === 'Publicada' && baseDelNombre(fila.vacante) === base)
    // La misma vacante en otra ciudad ("... (Vallarta)" y "... (Guadalajara)") no es un duplicado.
    .filter(fila => !(ciudadDelNombre(fila.vacante) && ciudadDelNombre(nombreInterno) && ciudadDelNombre(fila.vacante) !== ciudadDelNombre(nombreInterno)))
    .slice(0, 3)
    .map(fila => ({ id: fila.id_team_tailor, nombre: fila.vacante }));
}

export function avisoDeDuplicados(duplicados) {
  if (!duplicados.length) return '';
  const lista = duplicados.map(vacante => `${vacante.nombre} (ID ${vacante.id})`).join('; ');
  return `Ojo: ya hay ${duplicados.length === 1 ? 'una vacante publicada igual' : 'vacantes publicadas iguales'}: ${lista}. Si es otra distinta, confirma y la subo; si no, dime y la descartamos.`;
}

// ── Clientes registrados (tabla `empresas`) ──────────────────────────────────

const claveDeCliente = nombre => normalizarTexto(nombre).replace(/[^a-z0-9]+/g, ' ').trim();
export const clienteDeNombre = nombreInterno => String(nombreInterno ?? '').split(' - ')[0].replace(/\(.*\)/, '').trim();

// Si el cliente del nombre interno ya está en `empresas`, se usa su escritura exacta ("peninsula" → "Península"), para
// que el mismo cliente no aparezca escrito de varias formas. `nuevo` es true si no está registrado, y null si no hay
// catálogo que consultar (tabla vacía o con error): entonces el nombre se deja como está.
export async function resolverCliente(supabase, nombreInterno) {
  const cliente = clienteDeNombre(nombreInterno);
  if (!cliente || !String(nombreInterno).includes(' - ')) return { nombre: nombreInterno, cliente, nuevo: null };

  const { data, error } = await supabase.from('empresas').select('nombre');
  if (error || !data?.length) return { nombre: nombreInterno, cliente, nuevo: null };

  // El nombre exacto o, si no, el único cliente cuyo nombre lo contiene ("Convert" → "Convert Solutions"): si no, una
  // vacante escrita con el nombre corto registraba al mismo cliente por segunda vez.
  const clave = claveDeCliente(cliente);
  const parecidas = data.filter(empresa => ` ${claveDeCliente(empresa.nombre)} `.includes(` ${clave} `));
  const registrada = data.find(empresa => claveDeCliente(empresa.nombre) === clave) ?? (parecidas.length === 1 ? parecidas[0] : null);
  if (!registrada) return { nombre: nombreInterno, cliente, nuevo: true };
  return { nombre: `${registrada.nombre}${nombreInterno.slice(nombreInterno.indexOf(' - '))}`, cliente: registrada.nombre, nuevo: false };
}

export const avisoDeClienteNuevo = cliente => `Ojo: "${cliente}" no está registrado como cliente. Si está bien escrito, al subir la vacante lo registro; si no, dime cómo se escribe.`;

// Registra al cliente de una vacante recién creada si todavía no existe. Nunca falla la publicación.
export async function registrarCliente(supabase, nombreInterno) {
  try {
    const { cliente, nuevo } = await resolverCliente(supabase, nombreInterno);
    if (nuevo) await supabase.from('empresas').insert({ nombre: cliente });
  } catch { /* la vacante ya está creada en TeamTailor: el catálogo se puede completar después */ }
}
