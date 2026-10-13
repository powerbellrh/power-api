import { dormir, esNoEncontrada, ttActualizar, ttObtener } from '../../clientes_api.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { normalizarTexto } from '../utilidades.js';
import { contarCandidatos, nombreDeEtapa } from './bandeja.js';
import { leerVacanteCompleta } from './consultas.js';
import { ETAPAS_DEL_LOTE, MAXIMO_POR_LOTE, hechasDelLote } from './informe.js';
import { normalizarDescripcion, revisarVacante } from './validaciones.js';

// Acciones que cambian algo sobre lo que ya existe: en TeamTailor, editar el anuncio, cerrar una vacante y mover
// candidatos de etapa; en la cola de evaluaciones, volver a evaluar a los de la bandeja de entrada de una vacante.
// También se prepara aquí el lote de informes de los entrevistados de una vacante: no cambia nada, pero cuesta y tarda,
// y por eso se confirma igual (lo arma informe.js).
// Nunca se hacen en el mismo turno en que se piden: `preparar` revisa y devuelve lo que se va a
// hacer (queda guardado en la conversación) y solo `ejecutar` lo hace, cuando la reclutadora confirma ese resumen.

export const VIGENCIA_ACCION_MS = 30 * 60 * 1000;
const MAXIMO_A_MOVER            = 30;
const PAUSA_ENTRE_MOVIMIENTOS   = 300;
const ETAPAS_CON_AVISOS         = ['enviado a cliente', 'enviar agenda', 'hired', 'contratados'];

const error = mensaje => ({ ok: false, error: mensaje });

// ── Editar el anuncio ────────────────────────────────────────────────────────

async function prepararEdicion({ textoReclutadora }, { id, nombre_interno: nombre, titulo, descripcion }) {
  const actual = await leerVacanteCompleta(id);
  if (!actual) return error('No existe una vacante con ese ID.');

  const cambios = {};
  if (titulo?.trim() && titulo.trim() !== actual.titulo)                       cambios.titulo = titulo.trim();
  if (nombre?.trim() && nombre.trim() !== actual.nombre_interno)               cambios.nombre_interno = nombre.trim();
  if (descripcion?.trim() && normalizarDescripcion(descripcion) !== actual.descripcion.trim()) cambios.descripcion = normalizarDescripcion(descripcion);
  if (!Object.keys(cambios).length) return error('No hay ningún cambio respecto a lo que ya tiene la vacante.');

  // Las mismas reglas que al crear: sin nombrar al cliente, sin criterios discriminatorios y sin cifras inventadas.
  const problemas = revisarVacante({
    args: { descripcion: cambios.descripcion ?? '', titulo: cambios.titulo ?? '', nombre_interno: cambios.nombre_interno ?? actual.nombre_interno, contexto: '', escena_imagen: '' },
    textoReclutadora,
    respaldoMontos: `${textoReclutadora}\n${actual.descripcion}`,
  });
  if (problemas.length) return error(`No se puede preparar el cambio: ${problemas.join(' ')}`);

  const resumen = `Editar "${actual.nombre_interno}" (ID ${id}): ${Object.keys(cambios).map(campo => ({ titulo: 'título', nombre_interno: 'nombre interno', descripcion: 'anuncio' })[campo]).join(', ')}`;
  return {
    ok: true,
    pendiente: { tipo: 'editar_vacante', id: Number(id), cambios, resumen, vistaPrevia: cambios.descripcion ? limpiarHtmlParaWhatsApp(cambios.descripcion) : '' },
    vista_previa: `${resumen}. ${cambios.descripcion ? 'El sistema le muestra el anuncio nuevo antes de tu mensaje. ' : ''}Pídele que confirme.`,
  };
}

// ── Cerrar una vacante ───────────────────────────────────────────────────────

async function prepararCierre(_, { id }) {
  const actual = await leerVacanteCompleta(id);
  if (!actual) return error('No existe una vacante con ese ID.');
  if (actual.estatus === 'archived') return error('Esa vacante ya está cerrada.');

  const conteo  = await contarCandidatos(Number(id)).catch(() => null);
  const resumen = `Cerrar "${actual.nombre_interno}" (ID ${id})`;
  return {
    ok: true,
    pendiente: { tipo: 'cerrar_vacante', id: Number(id), nombre: actual.nombre_interno, resumen },
    vista_previa: `${resumen}. Dejará de recibir postulaciones${conteo ? `; tiene ${conteo.total} personas en la bandeja de entrada` : ''}. Pídele que confirme.`,
  };
}

// ── Mover candidatos de etapa ────────────────────────────────────────────────

const ALIAS_DE_ETAPA = { bandeja: 'inbox', 'bandeja de entrada': 'inbox', contratados: 'hired', contratado: 'hired' };

function buscarEtapa(etapas, nombre) {
  const buscado = ALIAS_DE_ETAPA[normalizarTexto(nombre)] ?? normalizarTexto(nombre);
  const nombres = etapa => [etapa.attributes?.name, etapa.attributes?.['legacy-stage-type-name']].map(normalizarTexto);
  return etapas.find(etapa => nombres(etapa).includes(buscado)) ?? etapas.find(etapa => nombres(etapa).some(n => n.includes(buscado)));
}

async function postulacionesActivas(idEtapa, filtroNombre) {
  const encontradas = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const respuesta = await ttObtener(`/stages/${idEtapa}/job-applications?include=candidate&page[size]=30&page[number]=${pagina}`, pagina > 1);
    const candidatos = new Map((respuesta.included ?? []).filter(item => item.type === 'candidates').map(item => [item.id, item.attributes ?? {}]));
    for (const postulacion of respuesta.data ?? []) {
      if (postulacion.attributes?.['rejected-at']) continue;
      const datos  = candidatos.get(postulacion.relationships?.candidate?.data?.id) ?? {};
      const nombre = `${datos['first-name'] ?? ''} ${datos['last-name'] ?? ''}`.trim() || `postulación ${postulacion.id}`;
      if (!filtroNombre || normalizarTexto(nombre).includes(normalizarTexto(filtroNombre))) encontradas.push({ id: postulacion.id, nombre, desde: postulacion.attributes?.['changed-stage-at'] ?? postulacion.attributes?.['created-at'] ?? '' });
    }
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }
  return encontradas;
}

const plural = (cantidad, uno, varios) => `${cantidad} ${cantidad === 1 ? uno : varios}`;

// A quién se mueve: a una persona por su nombre o a toda la etapa. Lo que se le muestra a la reclutadora y al modelo
// son cantidades y el criterio, nunca los nombres. (Mover por evaluación, "los de 5 estrellas", se quitó el
// 11-oct-2026 al empezar `evaluaciones` de cero; se volverá a agregar.)
async function prepararMovimiento(_contexto, { id, etapa_origen: origen, etapa_destino: destino, nombre_candidato: nombreCandidato }) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${id}/stages`)).data ?? [];
  } catch (e) {
    return esNoEncontrada(e) ? error('No existe una vacante con ese ID.') : Promise.reject(e);
  }

  const desde = buscarEtapa(etapas, origen);
  const hasta = buscarEtapa(etapas, destino);
  const disponibles = etapas.map(etapa => etapa.attributes?.name).join(', ');
  if (!desde || !hasta) return error(`No encontré la etapa ${!desde ? `"${origen}"` : `"${destino}"`}. Las etapas de esa vacante son: ${disponibles}.`);
  if (desde.id === hasta.id) return error('La etapa de origen y la de destino son la misma.');

  const nombre   = nombreCandidato?.trim() ?? '';
  const etapa    = nombreDeEtapa(desde);

  const personas = await postulacionesActivas(desde.id, nombre);
  if (!personas.length) return error(`No hay ${nombre ? `a nadie llamado "${nombre}"` : 'personas'} en la etapa "${etapa}" de esa vacante.`);
  // Un nombre que coincide con varias personas no se resuelve a ciegas (ni listando nombres): se pide el completo.
  if (nombre && personas.length > 1) return error(`Hay ${personas.length} personas en "${etapa}" cuyo nombre coincide con "${nombre}". Pídele el nombre completo, con apellidos.`);

  const criterio = nombre ? ` (la que coincide con "${nombre}")` : '';
  const aMover    = personas.slice(0, MAXIMO_A_MOVER);
  const resumen   = `Mover ${plural(aMover.length, 'persona', 'personas')}${criterio} de "${etapa}" a "${nombreDeEtapa(hasta)}" (vacante ${id})`;
  const conAvisos = ETAPAS_CON_AVISOS.includes(normalizarTexto(hasta.attributes.name));
  return {
    ok: true,
    pendiente: { tipo: 'mover_candidatos', id: Number(id), etapaDestinoId: hasta.id, postulaciones: aMover.map(persona => persona.id), resumen },
    vista_previa: `${resumen}.${personas.length > MAXIMO_A_MOVER ? ` Son más de ${MAXIMO_A_MOVER}: solo se mueven las primeras ${MAXIMO_A_MOVER}.` : ''}${conAvisos ? ' Ojo: esa etapa dispara avisos automáticos a los candidatos; adviértelo.' : ''} Dile cuántas personas y con qué criterio, sin nombres, y pídele que confirme.`,
  };
}

// ── Volver a evaluar la bandeja de entrada ───────────────────────────────────

// Cuando cambia el contexto de una vacante, las personas de su bandeja de entrada regresan a la cola de evaluaciones
// (`evaluaciones.estado = 'pendiente'`, con los intentos en cero) y /cola las evalúa otra vez con el contexto de ahora.
// Solo regresan las que ya terminaron: una pendiente o en proceso ya va a tomar el contexto nuevo.
const ESTADOS_REEVALUABLES    = ['completada', 'fallida'];
const EVALUACIONES_POR_MINUTO = 5; // lo que toma /cola en cada corrida (TAMANO_LOTE en api/cola.js)

const minutosDeCola = cantidad => plural(Math.ceil(cantidad / EVALUACIONES_POR_MINUTO), 'minuto', 'minutos');

async function prepararReevaluacion({ supabase }, { id }) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${id}/stages`)).data ?? [];
  } catch (e) {
    return esNoEncontrada(e) ? error('No existe una vacante con ese ID.') : Promise.reject(e);
  }
  const bandeja = etapas.find(etapa => etapa.attributes?.['legacy-stage-type-name'] === 'Inbox');
  if (!bandeja) return error('Esa vacante no tiene bandeja de entrada.');

  const personas = await postulacionesActivas(bandeja.id);
  if (!personas.length) return error('No hay personas en la bandeja de entrada de esa vacante.');

  const { data: filas, error: errorConsulta } = await supabase.from('evaluaciones')
    .select('postulacion_id, estado').in('postulacion_id', personas.map(persona => Number(persona.id)));
  if (errorConsulta) throw new Error(errorConsulta.message);

  const terminadas    = (filas ?? []).filter(fila => ESTADOS_REEVALUABLES.includes(fila.estado));
  const enCola        = (filas ?? []).length - terminadas.length;
  const sinEvaluacion = personas.length - (filas ?? []).length;
  const notas = [
    enCola ? `${plural(enCola, 'persona ya está', 'personas ya están')} en la cola y se evaluarán con el contexto actual.` : '',
    sinEvaluacion ? `${plural(sinEvaluacion, 'persona no tiene', 'personas no tienen')} evaluación registrada y no se pueden volver a evaluar desde aquí.` : '',
  ].filter(Boolean).join(' ');
  if (!terminadas.length) return error(`No hay a quién volver a evaluar en la bandeja de entrada de esa vacante. ${notas}`.trim());

  const resumen = `Volver a evaluar a ${plural(terminadas.length, 'persona', 'personas')} de la bandeja de entrada (vacante ${id})`;
  return {
    ok: true,
    pendiente: { tipo: 'reevaluar_bandeja', id: Number(id), postulaciones: terminadas.map(fila => fila.postulacion_id), resumen },
    vista_previa: `${resumen}. Se evalúan de nuevo con el contexto que la vacante tiene ahora; tarda cerca de ${minutosDeCola(terminadas.length)}. A quien ya recibió preguntas por WhatsApp no se le vuelven a mandar.${notas ? ` ${notas}` : ''} Dile cuántas personas son, sin nombres, y pídele que confirme.`,
  };
}

// ── Informes en lote ─────────────────────────────────────────────────────────

// Los informes de todas las personas activas en una etapa de una vacante: "Entrevistado" (la de siempre, si no dice
// cuál) o "Enviado a cliente"; ninguna otra. Máximo MAXIMO_POR_LOTE por vez: primero las que llevan más tiempo ahí. Las
// que ya recibió en un lote reciente no se repiten, así "arma los que faltan" sigue con las demás; `de_nuevo` las
// vuelve a incluir. Siempre se le dice cuántas personas hay en cada una de las dos etapas. Solo se le pregunta algo
// cuando no dijo la etapa y hay personas en las dos; en cualquier otro caso se arman sin confirmar (informe.js).
const etapaDelLote = pedida => {
  const texto = normalizarTexto(pedida ?? '').trim();
  if (!texto) return { nombre: null };
  if (texto.includes('entrevist')) return { nombre: ETAPAS_DEL_LOTE[0] };
  if (texto.includes('enviad') || texto.includes('cliente')) return { nombre: ETAPAS_DEL_LOTE[1] };
  return { invalida: true };
};

async function prepararInformes({ supabase, loteDeInformes }, { id, etapa_origen: pedida, de_nuevo: deNuevo }) {
  const elegida = etapaDelLote(pedida);
  if (elegida.invalida) return error(`Los informes en lote solo se arman de las etapas ${ETAPAS_DEL_LOTE.map(nombre => `"${nombre}"`).join(' y ')}. Díselo; el informe de alguien en otra etapa se pide pegando el enlace de ese candidato.`);

  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${id}/stages`)).data ?? [];
  } catch (e) {
    return esNoEncontrada(e) ? error('No existe una vacante con ese ID.') : Promise.reject(e);
  }

  const hechas   = deNuevo === true ? [] : hechasDelLote(loteDeInformes, id);
  const porEtapa = [];
  for (const nombre of ETAPAS_DEL_LOTE) {
    const etapa    = buscarEtapa(etapas, nombre);
    const personas = etapa ? (await postulacionesActivas(etapa.id)).sort((a, b) => String(a.desde).localeCompare(String(b.desde))) : [];
    porEtapa.push({ nombre, existe: Boolean(etapa), personas, faltan: personas.filter(persona => !hechas.includes(String(persona.id))) });
  }
  const cuentas = porEtapa.map(etapa => `${etapa.nombre}: ${!etapa.existe ? 'la vacante no tiene esa etapa' : `${plural(etapa.personas.length, 'persona', 'personas')}${etapa.faltan.length !== etapa.personas.length ? ` (${etapa.faltan.length} sin informe todavía)` : ''}`}`).join('; ');
  const enCadaUna = `En esa vacante hay → ${cuentas}.`;

  if (porEtapa.every(etapa => !etapa.personas.length)) return error(`No hay personas en ninguna de las dos etapas de las que se arman informes en lote. ${enCadaUna} Díselo; el informe de alguien en otra etapa se pide pegando el enlace de ese candidato.`);

  // Sin etapa dicha y con personas por armar en las dos, escoge ella: una sola pregunta, con las cifras.
  const conPendientes = porEtapa.filter(una => una.faltan.length);
  if (!elegida.nombre && conPendientes.length > 1) return error(`Hay personas en las dos etapas y no dijo de cuál quiere los informes. ${enCadaUna} Pregúntale de cuál los armas, en UNA sola pregunta y con esas cifras ("Hay 2 personas en Entrevistado y 3 en Enviado a cliente. ¿De cuál te armo los informes?"). Cuando conteste, llama otra vez a esto con esa etapa en etapa_origen: se arman sin más preguntas.`);

  // Sin etapa dicha y con personas en una sola: esa.
  const etapa = elegida.nombre ? porEtapa.find(una => una.nombre === elegida.nombre) : conPendientes[0] ?? porEtapa.find(una => una.personas.length);
  const otra  = porEtapa.find(una => una !== etapa);
  if (!etapa.personas.length) return error(`No hay personas en "${etapa.nombre}" de esa vacante. ${enCadaUna} Díselo y pregúntale si quiere los de "${otra.nombre}".`);
  if (!etapa.faltan.length) return error(`Ya le mandaste los informes de las ${plural(etapa.personas.length, 'persona', 'personas')} que hay en "${etapa.nombre}" de esa vacante. ${enCadaUna} Díselo y pregúntale si quiere que los armes otra vez (llama a esto mismo con de_nuevo en true)${otra.faltan.length ? ` o prefiere los de "${otra.nombre}"` : ''}.`);

  const { data: copia } = await supabase.from('vacantes').select('vacante').eq('id_team_tailor', id).maybeSingle();
  const nombre   = copia?.vacante ?? '';
  const yaHechas = etapa.personas.length - etapa.faltan.length;
  const aArmar   = etapa.faltan.slice(0, MAXIMO_POR_LOTE);
  const resumen  = `Armar ${plural(aArmar.length, 'informe', 'informes')} de ${aArmar.length === 1 ? 'la persona' : 'las personas'} en "${etapa.nombre}" de ${nombre ? `"${nombre}"` : 'la vacante'} (ID ${id})`;
  // Lo que el sistema le dice a ella al empezar: cuántas personas hay en cada etapa y, si no van todas, por qué.
  const aviso = [
    `En ${nombre ? `*${nombre}*` : 'esa vacante'} hay ${porEtapa.map(una => `${plural(una.personas.length, 'persona', 'personas')} en ${una.nombre}`).join(' y ')}.`,
    yaHechas ? `De ${etapa.nombre} ya te mandé ${yaHechas === 1 ? '1 informe, que no se repite' : `${yaHechas} informes, que no se repiten`}.` : '',
    etapa.faltan.length > MAXIMO_POR_LOTE ? `Armo máximo ${MAXIMO_POR_LOTE} por vez: van los de quienes llevan más tiempo en la etapa; cuando los recibas, pídeme los que faltan.` : '',
  ].filter(Boolean).join(' ');
  // No se le pide confirmar (13-oct-2026: "confirma mucho"): al pedirlos ya dijo qué quiere. `directo` hace que se
  // armen al cerrar este mismo turno (turno.js).
  return {
    ok: true,
    pendiente: { tipo: 'armar_informes', id: Number(id), nombre, etapa: etapa.nombre, postulaciones: aArmar.map(persona => persona.id), resumen, directo: true, aviso },
    vista_previa: `${resumen}. ${enCadaUna} YA ESTÁN EN MARCHA: NO le pidas confirmar ni le preguntes nada. El sistema le dice cuántas personas hay en cada etapa, le avisa que ya los está armando y se los manda numerados (Informe 1, Informe 2...) en cerca de un minuto. Cierra el turno con \`responder\` y una frase corta; el sistema no la envía.`,
  };
}

export async function prepararAccion(contexto, { tipo, ...argumentos }) {
  const preparar = { editar_vacante: prepararEdicion, cerrar_vacante: prepararCierre, mover_candidatos: prepararMovimiento, reevaluar_bandeja: prepararReevaluacion, armar_informes: prepararInformes }[tipo];
  if (!preparar) return error('Esa acción no existe.');
  if (!Number.isInteger(Number(argumentos.id)) || Number(argumentos.id) <= 0) return error('Falta el ID de la vacante.');
  return preparar(contexto, argumentos);
}

// ── Ejecutar lo confirmado ───────────────────────────────────────────────────

export const vigente = (pendiente, ahora = Date.now()) => Boolean(pendiente?.tipo) && ahora - Date.parse(pendiente.creada) < VIGENCIA_ACCION_MS;

// Varias acciones preparadas en el mismo turno ("archiva las dos") quedan como una sola pendiente: un solo "sí" las
// hace todas. El 9-oct-2026, al pedir cerrar dos vacantes, la segunda pisó a la primera y hubo que confirmar tres veces.
export function juntarAcciones(anterior, nueva) {
  // La misma acción preparada otra vez (mismo tipo y vacante) reemplaza a la anterior en vez de repetirse.
  const previas = (anterior?.tipo === 'varias' ? anterior.acciones : anterior ? [anterior] : []).filter(accion => !(accion.tipo === nueva.tipo && accion.id === nueva.id && accion.etapaDestinoId === nueva.etapaDestinoId));
  if (!previas.length) return nueva;
  const acciones = [...previas, nueva];
  return {
    tipo: 'varias', acciones,
    resumen: acciones.map(accion => accion.resumen).join('; '),
    vistaPrevia: acciones.map(accion => accion.vistaPrevia).filter(Boolean).join('\n\n'),
  };
}

// Devuelve el texto con el resultado, tal como se le manda a la reclutadora.
export async function ejecutarAccion(contexto, pendiente) {
  const { supabase, log } = contexto;
  if (pendiente.tipo === 'varias') {
    const resultados = [];
    for (const accion of pendiente.acciones) {
      try {
        resultados.push(await ejecutarAccion(contexto, accion));
      } catch (e) {
        log('accion', { estado: 'error', tipo: accion.tipo, id: accion.id, error: e.message });
        resultados.push(`No pude: ${accion.resumen}. No se hizo ese cambio.`);
      }
    }
    return resultados.map(resultado => `- ${resultado}`).join('\n');
  }

  if (pendiente.tipo === 'editar_vacante') {
    const { titulo, nombre_interno: nombre, descripcion } = pendiente.cambios;
    await ttActualizar(`/jobs/${pendiente.id}`, { data: { id: String(pendiente.id), type: 'jobs', attributes: {
      ...(titulo && { title: titulo }), ...(nombre && { 'internal-name': nombre }), ...(descripcion && { body: descripcion }),
    } } });

    // La copia en Supabase es la que usa el chatbot de candidatos para mostrar la vacante.
    const { error: errorCopia } = await supabase.from('vacantes').update({
      ...(titulo && { titulo_externo: titulo }), ...(nombre && { vacante: nombre }), ...(descripcion && { descripcion }),
    }).eq('id_team_tailor', pendiente.id);
    if (errorCopia) log('accion', { estado: 'error_copia', error: errorCopia.message });
    // Dice qué cambió: si confirmó sin querer, que lo note en el momento.
    const hechos = [nombre && `nombre interno "${nombre}"`, titulo && `título "${titulo}"`, descripcion && 'anuncio'].filter(Boolean).join(', ');
    return `Listo, actualicé la vacante ${pendiente.id} en TeamTailor${hechos ? `: ${hechos}` : ''}.`;
  }

  if (pendiente.tipo === 'cerrar_vacante') {
    await ttActualizar(`/jobs/${pendiente.id}`, { data: { id: String(pendiente.id), type: 'jobs', attributes: { status: 'archived' } } });
    const { error: errorCopia } = await supabase.from('vacantes').update({ estatus: 'Cerrada' }).eq('id_team_tailor', pendiente.id);
    if (errorCopia) log('accion', { estado: 'error_copia', error: errorCopia.message });
    return `Listo, cerré ${pendiente.nombre ? `*${pendiente.nombre}* (${pendiente.id})` : `la vacante ${pendiente.id}`}. Ya no recibe postulaciones.`;
  }

  if (pendiente.tipo === 'reevaluar_bandeja') {
    // Solo las que siguen terminadas: si alguna ya volvió a la cola entre la pregunta y el "sí", no se toca.
    const { data: encoladas, error: errorCola } = await supabase.from('evaluaciones')
      .update({ estado: 'pendiente', intentos: 0, actualizado: new Date().toISOString() })
      .in('postulacion_id', pendiente.postulaciones).in('estado', ESTADOS_REEVALUABLES).select('postulacion_id');
    if (errorCola) throw new Error(errorCola.message);
    const cantidad = (encoladas ?? []).length;
    if (!cantidad) return `No quedó nadie por volver a evaluar en la vacante ${pendiente.id}: ya estaban en la cola.`;
    return `Listo, ${cantidad === 1 ? 'regresó 1 persona' : `regresaron ${cantidad} personas`} de la vacante ${pendiente.id} a la cola de evaluación. Tarda cerca de ${minutosDeCola(cantidad)}; las notas nuevas se verán en TeamTailor.`;
  }

  // El lote de informes no se hace aquí: lo aparta y lo arma hacerAccionConfirmada (entrega.js).
  if (pendiente.tipo !== 'mover_candidatos') throw new Error(`acción desconocida: ${pendiente.tipo}`);

  let movidas = 0;
  const fallidas = [];
  for (const [indice, postulacion] of pendiente.postulaciones.entries()) {
    if (indice) await dormir(PAUSA_ENTRE_MOVIMIENTOS);
    try {
      await ttActualizar(`/job-applications/${postulacion}`, { data: { id: String(postulacion), type: 'job-applications', relationships: { stage: { data: { id: String(pendiente.etapaDestinoId), type: 'stages' } } } } });
      movidas++;
    } catch (e) {
      fallidas.push(postulacion);
      log('accion', { estado: 'error_movimiento', postulacion, error: e.message });
    }
  }
  // TeamTailor acepta el cambio al momento pero lo aplica después: en la prueba real del 9-oct-2026 tardó de 15 a 50
  // segundos en verse. Se le avisa para que no crea que falló si consulta la vacante enseguida.
  const AVISO_DE_RETRASO = 'TeamTailor puede tardar hasta un minuto en reflejarlo.';
  return fallidas.length
    ? `Moví ${movidas} de ${pendiente.postulaciones.length}. No pude mover ${fallidas.length}; revísalas en TeamTailor. ${AVISO_DE_RETRASO}`
    : `Listo, moví ${movidas} ${movidas === 1 ? 'persona' : 'personas'} ${pendiente.resumen.replace(/^Mover \d+ personas? /, '')}. ${AVISO_DE_RETRASO}`;
}

