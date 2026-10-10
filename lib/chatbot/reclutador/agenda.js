import { normalizarTexto } from '../utilidades.js';
import { diaCdmx, leerRango, lunesDe, nombreDelTipo } from './estadisticas.js';

// Agenda: las personas que cada reclutador le envió a un cliente (tabla `agenda`). Cada fila es una cita con el cliente:
//   `creado`     el día en que se agendó la cita; en el equipo se le dice "enviados" ("¿cuántos envió Ana hoy?")
//   `entrevista` la fecha y hora de la entrevista con el cliente
// De aquí solo salen totales y grupos (por reclutador, cliente, vacante, estatus, día, semana, mes). El nombre de la
// persona citada y los comentarios de la cita nunca se leen de la tabla, así que no pueden llegar al modelo. Los nombres
// que sí salen son los de los reclutadores (personal de la empresa) y los de los clientes.

export const FECHAS_DE_AGENDA       = ['enviados', 'entrevista'];
export const AGRUPACIONES_DE_AGENDA = ['reclutador', 'cliente', 'vacante', 'estatus', 'tipo', 'dia', 'semana', 'mes'];

const TAMANO_PAGINA      = 1000; // máximo de filas por petición en Supabase
const TAMANO_LOTE        = 300;  // ids por consulta de postulaciones
const MAXIMO_GRUPOS      = 30;
const CLIENTES_POR_RECLUTADOR = 6;
const DIAS_PARA_COBERTURA     = 60; // quien no ha capturado ninguna cita en este tiempo no usa la agenda
const ULTIMOS = { dia: 31, semana: 26, mes: 24 }; // de los desgloses por fecha se entregan los más recientes

const sumar = (conteos, clave) => conteos.set(clave, (conteos.get(clave) ?? 0) + 1);
const contiene = (texto, buscado) => !buscado || normalizarTexto(texto).includes(buscado);
// "pendiente" y "Pendiente" son el mismo estatus.
const estatusDe = fila => { const texto = String(fila.estatus ?? '').trim(); return texto ? texto[0].toUpperCase() + texto.slice(1) : 'Sin estatus'; };

function armar(conteos, agrupacion) {
  const grupos = [...conteos].map(([grupo, cantidad]) => ({ grupo, cantidad }));
  if (ULTIMOS[agrupacion]) return grupos.sort((a, b) => a.grupo.localeCompare(b.grupo)).slice(-ULTIMOS[agrupacion]);
  return grupos.sort((a, b) => b.cantidad - a.cantidad).slice(0, MAXIMO_GRUPOS);
}

async function leerTodo(consulta) {
  const filas = [];
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await consulta().range(desde, desde + TAMANO_PAGINA - 1);
    if (error) throw error;
    filas.push(...(data ?? []));
    if ((data ?? []).length < TAMANO_PAGINA) return filas;
  }
}

export async function consultarAgenda(supabase, { fecha = 'enviados', desde = '', hasta = '', agrupar_por = 'reclutador', reclutador = '', cliente = '' } = {}) {
  if (!FECHAS_DE_AGENDA.includes(fecha)) return { error: `fecha debe ser uno de: ${FECHAS_DE_AGENDA.join(', ')}.` };
  if (!AGRUPACIONES_DE_AGENDA.includes(agrupar_por)) return { error: `agrupar_por debe ser uno de: ${AGRUPACIONES_DE_AGENDA.join(', ')}.` };
  const rango = leerRango({ desde, hasta });
  if (rango.error) return { error: rango.error };

  const columna = fecha === 'entrevista' ? 'entrevista' : 'creado';
  const citas = await leerTodo(() => {
    let consulta = supabase.from('agenda').select('id_usuario, id_postulacion, creado, entrevista, estatus').order('id');
    if (rango.desde) consulta = consulta.gte(columna, new Date(rango.desde).toISOString());
    if (rango.hasta) consulta = consulta.lte(columna, new Date(rango.hasta).toISOString());
    return consulta;
  });

  // cita → postulación → vacante → empresa (el cliente).
  const idsPostulacion = [...new Set(citas.map(cita => cita.id_postulacion).filter(id => id != null))];
  const vacanteDePostulacion = new Map();
  for (let i = 0; i < idsPostulacion.length; i += TAMANO_LOTE) {
    const { data, error } = await supabase.from('postulaciones').select('id, id_vacante').in('id', idsPostulacion.slice(i, i + TAMANO_LOTE));
    if (error) throw error;
    for (const postulacion of data ?? []) vacanteDePostulacion.set(String(postulacion.id), String(postulacion.id_vacante));
  }

  const leer = async (tabla, columnas) => { const { data, error } = await supabase.from(tabla).select(columnas); if (error) throw error; return data ?? []; };
  const vacantes = new Map((await leer('vacantes', 'id, vacante, id_empresa, tipo')).map(vacante => [String(vacante.id), vacante]));
  const empresas = new Map((await leer('empresas', 'id, nombre')).map(empresa => [empresa.id, empresa.nombre]));
  const usuarios = new Map((await leer('usuarios', 'id, nombre')).map(usuario => [usuario.id, usuario.nombre]));

  const buscaReclutador = normalizarTexto(reclutador).trim();
  const buscaCliente    = normalizarTexto(cliente).trim();

  const conteos = Object.fromEntries(AGRUPACIONES_DE_AGENDA.map(agrupacion => [agrupacion, new Map()]));
  const clientesDe = new Map(); // reclutador → Map(cliente → cantidad)
  let total = 0;

  for (const cita of citas) {
    const vacante = vacantes.get(vacanteDePostulacion.get(String(cita.id_postulacion)));
    const grupos = {
      reclutador: usuarios.get(cita.id_usuario) ?? 'Sin reclutador',
      cliente:    empresas.get(vacante?.id_empresa) ?? (String(vacante?.vacante ?? '').split(' - ')[0].trim() || 'Sin cliente'),
      vacante:    vacante?.vacante ?? 'Sin vacante',
      estatus:    estatusDe(cita),
      tipo:       nombreDelTipo(vacante ?? {}),
    };
    if (!contiene(grupos.reclutador, buscaReclutador) || !contiene(grupos.cliente, buscaCliente)) continue;

    const momento = Date.parse(cita[columna]);
    const dia = Number.isNaN(momento) ? null : diaCdmx(momento);
    Object.assign(grupos, { dia: dia ?? 'sin fecha', semana: dia ? lunesDe(dia) : 'sin fecha', mes: dia?.slice(0, 7) ?? 'sin fecha' });

    total++;
    for (const agrupacion of AGRUPACIONES_DE_AGENDA) sumar(conteos[agrupacion], grupos[agrupacion]);
    if (!clientesDe.has(grupos.reclutador)) clientesDe.set(grupos.reclutador, new Map());
    sumar(clientesDe.get(grupos.reclutador), grupos.cliente);
  }

  // Lo que más se pregunta: cuántas personas envió cada reclutador, en total y por cliente.
  const porReclutador = armar(conteos.reclutador, 'reclutador').map(({ grupo, cantidad }) => {
    const clientes = [...clientesDe.get(grupo)].map(([nombre, enviados]) => ({ cliente: nombre, cantidad: enviados })).sort((a, b) => b.cantidad - a.cantidad);
    const resto = clientes.slice(CLIENTES_POR_RECLUTADOR);
    return {
      reclutador: grupo, total: cantidad, clientes: clientes.slice(0, CLIENTES_POR_RECLUTADOR),
      ...(resto.length ? { otros_clientes: resto.length, personas_en_otros_clientes: resto.reduce((suma, c) => suma + c.cantidad, 0) } : {}),
    };
  });

  // Quién captura sus citas en la agenda. El 9-oct-2026 el agente dijo que Laura había enviado 0 ese día, y sí envió:
  // ella (como el resto del equipo administrativo) no registra sus citas en esta tabla, así que aquí nunca aparece.
  const haceUnTiempo = new Date(Date.now() - DIAS_PARA_COBERTURA * 24 * 60 * 60 * 1000).toISOString();
  const conCitas = new Set((await leerTodo(() => supabase.from('agenda').select('id_usuario').gte('creado', haceUnTiempo).order('id'))).map(cita => cita.id_usuario));
  const registran   = [...usuarios].filter(([id]) => conCitas.has(id)).map(([, nombre]) => nombre);
  const noRegistran = [...usuarios].filter(([id]) => !conCitas.has(id)).map(([, nombre]) => nombre);
  const preguntaPorQuienNoRegistra = buscaReclutador && noRegistran.some(nombre => contiene(nombre, buscaReclutador)) && !registran.some(nombre => contiene(nombre, buscaReclutador));

  return {
    recurso: 'agenda',
    cobertura: {
      registran_sus_citas: registran,
      sin_citas_registradas: noRegistran,
      nota: `Solo cuenta las citas capturadas en la agenda. Quienes están en "sin_citas_registradas" no han capturado ninguna en ${DIAS_PARA_COBERTURA} días (el equipo administrativo no usa la agenda): sus envíos no aparecen aquí. Si te preguntan por el total del equipo, aclara en una frase que no incluye a esas personas; si preguntan por una de ellas, di que no hay registro de sus envíos en la agenda, nunca que envió 0.`,
    },
    ...(preguntaPorQuienNoRegistra ? { aviso: `${reclutador} no captura sus citas en la agenda: no hay registro de sus envíos. No digas que envió 0.` } : {}),
    se_cuenta_por: fecha === 'entrevista' ? 'fecha de la entrevista con el cliente' : 'día en que se agendó la cita con el cliente (enviados)',
    ...(desde || hasta ? { periodo: { desde: desde || 'el inicio', hasta: hasta || 'hoy' } } : { periodo: 'todo el histórico' }),
    ...(buscaReclutador ? { solo_reclutador: reclutador } : {}),
    ...(buscaCliente ? { solo_cliente: cliente } : {}),
    total,
    agrupado_por: agrupar_por,
    grupos: armar(conteos[agrupar_por], agrupar_por),
    por_reclutador: porReclutador,
    desgloses: Object.fromEntries(AGRUPACIONES_DE_AGENDA.filter(agrupacion => agrupacion !== agrupar_por).map(agrupacion => [agrupacion, armar(conteos[agrupacion], agrupacion)])),
    nota: `Cada desglose trae como mucho ${MAXIMO_GRUPOS} grupos (los de mayor cantidad); por día van los últimos ${ULTIMOS.dia}, por semana las últimas ${ULTIMOS.semana}. Para ver más, acota el periodo, el reclutador o el cliente.`,
  };
}
