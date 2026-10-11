import { esNoEncontrada, ttObtener } from '../../clientes_api.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { extraerContexto } from '../../teamtailor_vacantes.js';
import { normalizarTexto } from '../utilidades.js';
import { claveDeCliente } from './avisos.js';
import { contarCandidatos } from './bandeja.js';
import { diaCdmx, esDelTipo, estadisticasPostulaciones, nombreDelTipo } from './estadisticas.js';

// Consultas del agente reclutador que no son de una sola vacante: listar las publicadas con su bandeja, leer una
// vacante completa (para clonarla o editarla), y las fichas de los clientes.

const MAXIMO_LISTADAS      = 10;  // el resumen sin filtros; pedido por el equipo el 10-oct-2026 (eran 12)
const MAXIMO_REVISADAS     = 40;  // con un filtro, una persona o las etapas se revisan más (las de Laura eran 28)
const CONSULTAS_A_LA_VEZ   = 4;   // TeamTailor limita las peticiones por segundo
const ESTATUS_ACTIVA       = 'Publicada';


// ── Listado de vacantes con su bandeja ───────────────────────────────────────

const FILTROS_DE_LISTA         = ['todas', 'sin_candidatos_nuevos', 'bandeja_vacia'];
const VACANTES_POR_RESPONSABLE = new Map(); // id de usuario de TeamTailor → { cuando, ids }
const VIGENCIA_RESPONSABLE_MS  = 5 * 60 * 1000;
const ESPERA_DE_REINTENTO_MS   = 1_500;

// TeamTailor corta conexiones cuando se le piden muchas vacantes seguidas (el 10-oct-2026 quedaron 4 de 28 sin
// consultar): una segunda oportunidad, con una pausa, casi siempre basta. Una vacante que no existe no se reintenta.
async function conReintento(trabajo) {
  try {
    return await trabajo();
  } catch (error) {
    if (esNoEncontrada(error)) throw error;
    await new Promise(resolver => setTimeout(resolver, ESPERA_DE_REINTENTO_MS));
    return trabajo();
  }
}

async function enLotes(elementos, tamano, trabajo) {
  const resultados = [];
  for (let i = 0; i < elementos.length; i += tamano) resultados.push(...await Promise.all(elementos.slice(i, i + tamano).map(trabajo)));
  return resultados;
}

// filtro: 'todas' | 'sin_candidatos_nuevos' (nadie ha llegado hoy) | 'bandeja_vacia'
// tipo: 'todas' | 'operativa' | 'administrativa' (ver TIPOS_DE_VACANTE)
// soloDe: id de usuario de TeamTailor para dejar solo las vacantes de las que es responsable allá. No sirve la tabla
// `reclutadores_asignados`: al guardar una vacante se le asigna a todos los usuarios, así que no dice de quién es.
// conEtapas: además de la bandeja, cuántas personas activas hay en cada etapa de cada vacante, con los totales ya
// sumados. El 9-oct-2026 el agente sumó por su cuenta el pipeline de 9 vacantes y dio 488 activos en vez de 588.
// Cómo se le muestra la lista a la reclutadora: lo arma el código para que siempre salga igual de legible (el
// 10-oct-2026 el agente mandó doce renglones con nombre, ID y dos cifras pegados, "increíblemente difícil de leer").
// Un dato por renglón, primero las que tuvieron movimiento hoy, sin IDs, y las cifras del día de TODAS las vacantes.
function presentarLista({ vacantes, tipo, publicadas, hoyEnTodas, revisadas }) {
  const titulo = `*Vacantes${tipo === 'operativa' ? ' operativas' : tipo === 'administrativa' ? ' administrativas' : ''}* · ${publicadas} publicadas`;
  const cifras = vacante => [vacante.llegaron_hoy ? `${vacante.llegaron_hoy} hoy` : null, `${vacante.en_bandeja_de_entrada} en bandeja`, vacante.activos != null ? `${vacante.activos} activos` : null].filter(Boolean).join(' · ');
  const renglon = vacante => `• ${vacante.nombre_interno}\n   ${vacante.error ? 'no se pudo consultar' : cifras(vacante)}`;
  const conMovimiento = vacantes.filter(vacante => vacante.llegaron_hoy > 0);
  const sinMovimiento = vacantes.filter(vacante => !(vacante.llegaron_hoy > 0));
  const delDia = hoyEnTodas
    ? `Hoy llegaron *${hoyEnTodas.postulaciones}* postulaciones a ${hoyEnTodas.vacantes_con_postulaciones} ${hoyEnTodas.vacantes_con_postulaciones === 1 ? 'vacante' : 'vacantes'} (de todas, no solo de las de abajo).`
    : null;
  return [
    [titulo, delDia].filter(Boolean).join('\n'),
    conMovimiento.length ? ['*Con postulaciones hoy*', ...conMovimiento.map(renglon)].join('\n') : null,
    sinMovimiento.length ? [conMovimiento.length ? '*Sin postulaciones hoy*' : null, ...sinMovimiento.map(renglon)].filter(Boolean).join('\n') : null,
    publicadas > revisadas ? `_Son ${vacantes.length} de ${publicadas}. Dime un cliente o un puesto para ver otras._` : null,
  ].filter(Boolean).join('\n\n');
}

// Cuántas postulaciones llegaron hoy a TODAS las vacantes, por vacante: una sola consulta por fecha a TeamTailor (unas
// cuantas páginas), sin recorrer vacante por vacante. Si falla, el resumen sale sin ese dato.
async function postulacionesDeHoy(supabase, tipo) {
  try {
    const hoy = diaCdmx(Date.now());
    const resultado = await estadisticasPostulaciones(supabase, { desde: hoy, hasta: hoy, agrupar_por: 'vacante', tipo });
    if (resultado.error || resultado.nota || !Array.isArray(resultado.grupos)) return null; // con cifras parciales no se afirma nada
    return { postulaciones: resultado.total, vacantes_con_postulaciones: resultado.grupos.length, porVacante: new Map(resultado.grupos.map(({ grupo, cantidad }) => [grupo, cantidad])) };
  } catch {
    return null;
  }
}

export async function listarVacantes(supabase, { texto = '', filtro = 'todas', tipo = 'todas', soloDe = null, nombreDelDueno = '', conEtapas = false } = {}) {
  const { data, error } = await supabase.from('vacantes').select('id, id_team_tailor, vacante, estatus, creado, tipo');
  if (error) throw error;

  if (!FILTROS_DE_LISTA.includes(filtro)) filtro = 'todas'; // el modelo a veces lo manda vacío: antes eso dejaba la lista sin vacantes

  // De quién es cada vacante se recorre en TeamTailor (más de 20 peticiones): se recuerda unos minutos, porque después de
  // "las vacantes de Laura" vienen dos o tres preguntas más sobre las mismas.
  let asignadas = null;
  if (soloDe) {
    const recordadas = VACANTES_POR_RESPONSABLE.get(String(soloDe));
    asignadas = recordadas && Date.now() - recordadas.cuando < VIGENCIA_RESPONSABLE_MS ? recordadas.ids : null;
    if (!asignadas) {
      asignadas = new Set();
      for (const filtroTT of ['', '&filter[status]=unlisted']) {
        for (let pagina = 1; pagina <= 20; pagina++) {
          const respuesta = await conReintento(() => ttObtener(`/jobs?include=user&fields[jobs]=internal-name,user&page[size]=30&page[number]=${pagina}${filtroTT}`, pagina > 1));
          for (const vacante of respuesta.data ?? []) if (String(vacante.relationships?.user?.data?.id ?? '') === String(soloDe)) asignadas.add(String(vacante.id));
          if (!respuesta.links?.next) break;
        }
      }
      VACANTES_POR_RESPONSABLE.set(String(soloDe), { cuando: Date.now(), ids: asignadas });
    }
  }

  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const activas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null && fila.estatus === ESTATUS_ACTIVA && esDelTipo(fila, tipo))
    .filter(fila => !asignadas || asignadas.has(String(fila.id_team_tailor)))
    .filter(fila => palabras.every(palabra => normalizarTexto(fila.vacante).includes(palabra)))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  // Con una persona, un cliente o un puesto la lista es corta: las etapas van siempre, y así "¿y cuáles tienen gente en
  // proceso?" se contesta con lo ya consultado.
  conEtapas = conEtapas || Boolean(soloDe) || palabras.length > 0;
  const esResumen = filtro === 'todas' && !conEtapas;
  const revisadas = esResumen ? MAXIMO_LISTADAS : MAXIMO_REVISADAS;

  // En el resumen sin filtros caben pocas: van primero las que recibieron postulaciones hoy (se sabe de todas con
  // una sola consulta) y luego las más recientes. Antes eran solo las más recientes, y "¿cómo van hoy?" dejaba fuera
  // vacantes con movimiento ("de las otras 133 no sé nada", 10-oct-2026).
  const hoyEnTodas = esResumen && activas.length > revisadas ? await postulacionesDeHoy(supabase, tipo) : null;
  const porRevisar = hoyEnTodas
    ? [...activas].sort((a, b) => (hoyEnTodas.porVacante.get(b.vacante) ?? 0) - (hoyEnTodas.porVacante.get(a.vacante) ?? 0))
    : activas;
  const consultadas = await enLotes(porRevisar.slice(0, revisadas), CONSULTAS_A_LA_VEZ, async fila => {
    try {
      const conteo = await conReintento(() => contarCandidatos(Number(fila.id_team_tailor)));
      return conteo && {
        id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), publicada_el: String(fila.creado ?? '').slice(0, 10), en_bandeja_de_entrada: conteo.total, llegaron_hoy: conteo.hoy,
        ...(conEtapas ? { activos: conteo.etapas.reduce((suma, etapa) => suma + etapa.personas, 0), por_etapa: conteo.etapas.filter(etapa => etapa.personas > 0) } : {}),
      };
    } catch {
      return { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), error: 'No se pudo consultar' };
    }
  });

  const vacantes = consultadas.filter(Boolean)
    .filter(vacante => vacante.error
      || filtro === 'todas'
      || (filtro === 'sin_candidatos_nuevos' && vacante.llegaron_hoy === 0)
      || (filtro === 'bandeja_vacia' && vacante.en_bandeja_de_entrada === 0))
    .sort((a, b) => (b.llegaron_hoy ?? 0) - (a.llegaron_hoy ?? 0));

  // Los totales los suma el código: el modelo se equivoca al sumar listas largas.
  const contadas = vacantes.filter(vacante => !vacante.error);
  const sumaPorEtapa = new Map();
  for (const vacante of contadas) for (const { etapa, personas } of vacante.por_etapa ?? []) sumaPorEtapa.set(etapa, (sumaPorEtapa.get(etapa) ?? 0) + personas);
  return {
    ...(asignadas ? { solo: `las vacantes de las que ${nombreDelDueno || 'esa persona'} es responsable en TeamTailor` } : {}),
    publicadas_en_total: activas.length,
    ...(hoyEnTodas ? { hoy_en_todas_las_vacantes: { postulaciones: hoyEnTodas.postulaciones, vacantes_con_postulaciones: hoyEnTodas.vacantes_con_postulaciones, nota: 'Cubre TODAS las vacantes publicadas y cerradas, no solo las listadas: es la cifra del día.' } } : {}),
    presentacion: presentarLista({ vacantes, tipo, publicadas: activas.length, hoyEnTodas, revisadas }),
    nota_de_presentacion: 'Si te pidió la lista o un resumen, manda `presentacion` TAL CUAL como tu mensaje (ya viene ordenada y legible): no la reescribas, no le agregues IDs ni la juntes en un párrafo. Puedes añadir UNA línea al final. Si solo preguntó un dato, contesta ese dato.',
    vacantes,
    totales: {
      vacantes_revisadas: contadas.length,
      ...(vacantes.length > contadas.length ? { vacantes_sin_poder_consultar: vacantes.length - contadas.length } : {}),
      en_bandeja_de_entrada: contadas.reduce((suma, vacante) => suma + vacante.en_bandeja_de_entrada, 0),
      llegaron_hoy: contadas.reduce((suma, vacante) => suma + vacante.llegaron_hoy, 0),
      ...(conEtapas ? { activos: contadas.reduce((suma, vacante) => suma + vacante.activos, 0), por_etapa: [...sumaPorEtapa].map(([etapa, personas]) => ({ etapa, personas })) } : {}),
      nota: 'Totales ya sumados por el sistema: dalos tal cual, nunca sumes tú.',
    },
    // El 9-oct-2026 el agente dijo que "las otras 52" no habían recibido candidatos sin haberlas revisado.
    ...(activas.length > revisadas ? { nota: hoyEnTodas
      ? `Hay ${activas.length} vacantes publicadas y se revisó la bandeja de ${revisadas}: las que recibieron postulaciones hoy y, después, las más recientes. De las otras ${activas.length - revisadas} solo sabes lo del día (\`hoy_en_todas_las_vacantes\`): no afirmes nada de su bandeja. Para otro periodo usa consultar_estadisticas (revisa todas). Si no, ofrece acotar por cliente o puesto.`
      : `Hay ${activas.length} vacantes publicadas y SOLO se revisaron las ${revisadas} más recientes: de las otras ${activas.length - revisadas} no sabes nada, no afirmes nada sobre ellas. Para saber a cuáles llegaron candidatos hoy o en un periodo usa consultar_estadisticas (revisa todas). Si no, ofrece acotar por cliente o puesto.` } : {}),
  };
}

// ── Una vacante completa, para clonarla o editarla ───────────────────────────

export async function leerVacanteCompleta(id) {
  let detalle;
  try {
    detalle = await ttObtener(`/jobs/${id}?include=custom-field-values,custom-fields,locations`);
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }
  const atributos = detalle.data.attributes ?? {};
  const ubicacion = (detalle.included ?? []).find(item => item.type === 'locations')?.attributes;
  return {
    id:             Number(id),
    nombre_interno: atributos['internal-name'] ?? '',
    titulo:         atributos.title ?? '',
    estatus:        atributos.status ?? '',
    creada_el:      String(atributos['created-at'] ?? '').slice(0, 10),
    ubicacion:      ubicacion?.name ?? ubicacion?.city ?? '',
    descripcion:    atributos.body ?? '',
    contexto:       extraerContexto(detalle) ?? '',
  };
}

// ── Fichas de clientes ───────────────────────────────────────────────────────
// La ficha vive en la tabla `empresas` (columnas `giro` y `notas`).
// Si esas columnas todavía no existen, el agente sigue sin fichas.

const SIN_FICHAS = { error: 'Todavía no hay fichas de clientes disponibles.' };

async function buscarEmpresa(supabase, cliente) {
  const clave = claveDeCliente(cliente);
  if (!clave) return { empresa: null };
  const { data, error } = await supabase.from('empresas').select('id, nombre, giro, notas');
  if (error) return { error };
  const empresas = data ?? [];
  // El nombre exacto o, si no, la única empresa cuyo nombre lo contiene ("Convert" → "Convert Solutions").
  // Con o sin espacios es el mismo cliente ("Dollar City" y "DollarCity").
  const exacta   = empresas.find(empresa => claveDeCliente(empresa.nombre) === clave)
    ?? empresas.find(empresa => claveDeCliente(empresa.nombre).replace(/ /g, '') === clave.replace(/ /g, ''));
  const parecidas = exacta ? [] : empresas.filter(empresa => ` ${claveDeCliente(empresa.nombre)} `.includes(` ${clave} `));
  return { empresa: exacta ?? (parecidas.length === 1 ? parecidas[0] : null), parecidas: parecidas.length > 1 ? parecidas.map(empresa => empresa.nombre) : [] };
}

const fichaDe = empresa => ({ cliente: empresa.nombre, giro: empresa.giro ?? '', notas: empresa.notas ?? '' });

// Lo que el cliente ofrece en sus otras vacantes (sueldo, prestaciones, horario): de ahí salen las prestaciones y el
// nivel de una vacante nueva sin tener que preguntárselos a la reclutadora ni abrir los anuncios uno por uno.
const MAXIMO_VACANTES_DEL_CLIENTE = 10;
const RENGLONES_DE_OFERTA = 8;
const ES_OFERTA = /sueldo|salario|\$|prestacion|bono|vales|seguro|aguinaldo|vacaciones|fondo de ahorro|comedor|transporte|utilidades|imss|infonavit|contratacion|beneficio|descanso|horario|lunes|comision|capacitacion|crecimiento/;

function ofertaDe(descripcionHtml) {
  const renglones = limpiarHtmlParaWhatsApp(descripcionHtml).split('\n').map(renglon => renglon.replace(/^[•\-\s]+/, '').replace(/[*_]/g, '').trim());
  return [...new Set(renglones.filter(renglon => renglon.length > 3 && renglon.length <= 160 && ES_OFERTA.test(normalizarTexto(renglon))))].slice(0, RENGLONES_DE_OFERTA);
}

async function vacantesDelCliente(supabase, empresa) {
  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, titulo_externo, descripcion, contexto, estatus, creado, tipo, id_empresa');
  if (error) return [];
  const clave = claveDeCliente(empresa.nombre).replace(/ /g, '');
  let conContexto = 0;
  return (data ?? [])
    .filter(fila => fila.id_team_tailor != null && (fila.id_empresa === empresa.id || claveDeCliente(String(fila.vacante ?? '').split(' - ')[0]).replace(/ /g, '') === clave))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')))
    .slice(0, MAXIMO_VACANTES_DEL_CLIENTE)
    .map(fila => {
      // Los contextos más completos de sus vacantes recientes: el de la vacante nueva sigue su estructura (10-oct-2026).
      const contexto = String(fila.contexto ?? '').replace(/\s+/g, ' ').trim();
      const llevaContexto = contexto.length >= LARGO_MINIMO_CONTEXTO && conContexto < CONTEXTOS_DEL_CLIENTE && ++conContexto;
      return { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), estatus: fila.estatus, ofrece: ofertaDe(fila.descripcion), ...(llevaContexto ? { contexto: contexto.slice(0, LARGO_MAXIMO_CONTEXTO) } : {}) };
    });
}
const CONTEXTOS_DEL_CLIENTE   = 3;
const LARGO_MINIMO_CONTEXTO   = 200; // los de una línea ("fácil acceso a Tepotzotlán") no sirven de modelo
const LARGO_MAXIMO_CONTEXTO   = 1_500;

const NOTA_DE_VACANTES = 'vacantes_del_cliente: lo que publica en sus otras vacantes. Úsalo para las prestaciones y el nivel de la vacante nueva (toma lo que se repite en las de nivel y tipo parecido) y anótalo en "datos_supuestos". Los SUELDOS de otras vacantes no se copian: el sueldo solo lo da la reclutadora. Las que traen "contexto" son el modelo del contexto de la vacante nueva: toma el de la vacante más parecida (mismo puesto o nivel) y sigue su estructura (descripción general del puesto y la empresa, a quién priorizar, a quién descartar y qué validar en la entrevista), adaptándola al puesto nuevo; los criterios que copies de ahí van en "datos_supuestos".';

export async function verFichaCliente(supabase, { cliente }) {
  const { empresa, parecidas, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;
  if (!empresa && parecidas?.length) return { ficha: null, nota: `Hay varios clientes con ese nombre: ${parecidas.join(', ')}. Pregúntale cuál.` };
  if (!empresa) return { ficha: null, nota: 'Ese cliente no tiene ficha: si ella no te dice a qué se dedica la empresa, no lo supongas.' };

  const vacantes = await vacantesDelCliente(supabase, empresa);
  const conVacantes = vacantes.length ? { vacantes_del_cliente: vacantes, como_usarlas: NOTA_DE_VACANTES } : {};
  if (!empresa.giro && !empresa.notas) return { ficha: fichaDe(empresa), nota: 'El cliente está registrado pero su ficha está vacía: no supongas a qué se dedica.', ...conVacantes };
  return { ficha: fichaDe(empresa), ...conVacantes };
}

export const MAXIMO_NOTAS_CLIENTE = 4_000;
const mismaNota = (a, b) => normalizarTexto(a).replace(/[^a-z0-9]+/g, ' ').trim() === normalizarTexto(b).replace(/[^a-z0-9]+/g, ' ').trim();

// Guarda lo que la reclutadora cuenta de un cliente; si la empresa no existe, la crea. El giro se reemplaza cuando da
// uno nuevo. Las notas se van sumando (una por línea, sin repetir) para no perder lo anterior; con `reemplazar_notas`
// quedan solo las nuevas, que es como se corrige o se borra algo.
export async function guardarFichaCliente(supabase, { cliente, giro, notas, reemplazar_notas: reemplazar }) {
  if (!claveDeCliente(cliente)) return { error: 'Falta el nombre del cliente.' };

  const { empresa, parecidas, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;
  if (!empresa && parecidas?.length) return { error: `Hay varios clientes con ese nombre: ${parecidas.join(', ')}. Pregúntale cuál.` };

  const previas = String(empresa?.notas ?? '').split('\n').map(linea => linea.trim()).filter(Boolean);
  const nuevas  = String(notas ?? '').split('\n').map(linea => linea.trim()).filter(Boolean);
  const todas   = reemplazar === true ? nuevas : [...previas, ...nuevas.filter(nueva => !previas.some(previa => mismaNota(previa, nueva)))];
  if (todas.join('\n').length > MAXIMO_NOTAS_CLIENTE) {
    return { error: `La ficha de ese cliente ya no tiene espacio (máximo ${MAXIMO_NOTAS_CLIENTE} caracteres). Resume las notas que ya tiene junto con lo nuevo y guárdalas con reemplazar_notas en true.`, notas_actuales: previas.join('\n') };
  }

  const ficha = {
    giro:  giro?.trim() || empresa?.giro || '',
    notas: todas.join('\n'),
  };
  const { error: errorGuardado } = empresa
    ? await supabase.from('empresas').update(ficha).eq('id', empresa.id)
    : await supabase.from('empresas').insert({ nombre: cliente.trim(), ...ficha });
  return errorGuardado ? SIN_FICHAS : { guardada: true, ficha: { cliente: empresa?.nombre ?? cliente.trim(), ...ficha } };
}
