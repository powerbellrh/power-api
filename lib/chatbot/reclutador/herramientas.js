import { mensajeInformacionVacante } from '../constantes.js';
import { normalizarTexto } from '../utilidades.js';
import { obtenerVacante } from '../vacantes_supabase.js';
import { juntarAcciones, prepararAccion } from './acciones.js';
import { AGRUPACIONES_DE_AGENDA, consultarAgenda, FECHAS_DE_AGENDA } from './agenda.js';
import { contarCandidatos } from './bandeja.js';
import { guardarFichaCliente, leerVacanteCompleta, listarVacantes, resumenEvaluaciones, verFichaCliente } from './consultas.js';
import { AGRUPACIONES, consultarEstadisticas, nombreDelTipo, RECURSOS, TIPOS_DE_VACANTE } from './estadisticas.js';
import { dibujarGrafica, problemaDeGrafica, TIPOS_GRAFICA } from './grafica.js';

export { contarCandidatos };

// Herramientas del agente reclutador. Las de consulta devuelven datos y el modelo sigue trabajando con ellos; las
// de cierre terminan el turno con el mensaje para la reclutadora.

const MAXIMO_VACANTES_ENCONTRADAS = 10;
const MAXIMO_RETROALIMENTACION    = 3_000; // caracteres

const herramienta = (nombre, descripcion, propiedades) => ({
  type: 'function',
  function: { name: nombre, description: descripcion, parameters: { type: 'object', properties: propiedades, required: Object.keys(propiedades) } },
});
const idVacante = { type: 'integer', description: 'ID de la vacante en TeamTailor (el número que va después del # en el enlace de la vacante).' };
const mensaje   = descripcion => ({ type: 'string', description: descripcion });
const tipoDeVacante = { type: 'string', enum: TIPOS_DE_VACANTE, description: 'Solo vacantes "operativa" o "administrativa" (lenguaje interno de la empresa). "todas" si no pidió un tipo.' };

export const HERRAMIENTAS_DE_CONSULTA = [
  herramienta('buscar_vacantes', 'Busca vacantes por nombre interno, título o cliente y devuelve sus IDs. Úsala cuando la reclutadora se refiera a una vacante sin dar su ID.', {
    texto: { type: 'string', description: 'Palabras a buscar (cliente, puesto o ambos). Ejemplo: "península almacenista".' },
  }),
  herramienta('ver_vacante', 'Trae la información de una vacante tal como se le muestra a un candidato, y sus preguntas. Con `mostrar` en true el sistema le manda ese anuncio completo a la reclutadora debajo de tu mensaje.', {
    id: idVacante,
    mostrar: { type: 'boolean', description: 'true SOLO si ella pidió ver ese anuncio ("enséñame la vacante", "cómo la ve el candidato"). false si la lees tú para contestar, comparar o sacar un dato: así no le llega el anuncio entero. Nunca mandes más de dos anuncios en un turno.' },
  }),
  herramienta('contar_candidatos', 'Dice cómo va una vacante en TeamTailor: cuántas personas tiene en la bandeja de entrada, cuántas de ellas llegaron hoy (desde las 00:00, hora de México) y cuántas hay en cada etapa del proceso. No cuenta las rechazadas.', {
    id: idVacante,
  }),
  herramienta('listar_vacantes', 'Lista las vacantes publicadas con cuántas personas tienen en la bandeja y cuántas llegaron hoy (desde las 00:00, hora de México). Úsala para "mis vacantes", "qué vacantes hay", "cuáles no tienen candidatos" o un resumen de todas.', {
    texto:  { type: 'string', description: 'Cliente o puesto para acotar la lista. Cadena vacía para todas.' },
    filtro: { type: 'string', enum: ['todas', 'sin_candidatos_nuevos', 'bandeja_vacia'], description: '"sin_candidatos_nuevos": nadie ha llegado hoy. "bandeja_vacia": ninguna persona en la bandeja de entrada.' },
    tipo:   tipoDeVacante,
    solo_mias: { type: 'boolean', description: 'true si pide SUS vacantes: "las que tengo a mi nombre", "las mías", "las que tengo asignadas", "con mi usuario". Deja solo las vacantes de las que esa persona es la responsable en TeamTailor. false en cualquier otro caso.' },
  }),
  herramienta('consultar_agenda', 'Cuenta las personas que cada reclutador le ha ENVIADO a los clientes (las citas de la agenda). Úsala para "¿cuántos envió cada reclutador hoy?", "¿cuántos enviados lleva Ana este mes?", "enviados por cliente", "¿cuántas entrevistas hay mañana?" o el histórico. Devuelve solo totales y grupos (nunca a quién se envió): el total, los grupos pedidos, `por_reclutador` (cada reclutador con su total y sus clientes) y los demás desgloses.', {
    fecha:       { type: 'string', enum: FECHAS_DE_AGENDA, description: '"enviados": por el día en que se agendó la cita con el cliente (lo normal: "enviados", "envió", "agendó", "mandó"). "entrevista": por la fecha de la entrevista con el cliente ("entrevistas de mañana", "fecha de entrevista").' },
    desde:       { type: 'string', description: 'Primer día a contar, AAAA-MM-DD. "Hoy" es la fecha de hoy en desde y en hasta. Cadena vacía para el histórico completo.' },
    hasta:       { type: 'string', description: 'Último día a contar (incluido), AAAA-MM-DD. Cadena vacía si no hay límite.' },
    agrupar_por: { type: 'string', enum: AGRUPACIONES_DE_AGENDA, description: 'Cómo agrupar el total. Lo normal es "reclutador". "cliente", "vacante", "estatus" (Pendiente, Confirmó, Asistió, No asistió...), "tipo" (operativas o administrativas), "dia", "semana" o "mes" si lo pide así.' },
    reclutador:  { type: 'string', description: 'Nombre (o parte) de un reclutador para contar solo los suyos. Cadena vacía para todos.' },
    cliente:     { type: 'string', description: 'Nombre (o parte) de un cliente para contar solo los suyos. Cadena vacía para todos.' },
  }),
  herramienta('registrar_retroalimentacion', 'Guarda para el equipo de sistemas un comentario de la reclutadora sobre cómo funcionas tú: una queja, una sugerencia, algo que hiciste mal o que le gustaría que hicieras ("para el revisor...", "deberías...", "no me gustó que..."). Es la ÚNICA forma de que su comentario le llegue a alguien: nunca le digas que lo anotaste o que quedó registrado sin haberla llamado en ese turno.', {
    comentario: { type: 'string', description: 'Lo que dijo, completo y con sus palabras, sin resumir. Sin nombres de candidatos.' },
  }),
  herramienta('leer_vacante_completa', 'Trae de TeamTailor el anuncio completo en HTML, el título, el nombre interno, la ubicación y el contexto de una vacante que ya existe. Úsala para clonar una vacante, para crear una nueva inspirada en otra (aunque sea de otro cliente) o para editar su anuncio.', {
    id: idVacante,
  }),
  herramienta('ver_ficha_cliente', 'Trae lo que se sabe de un cliente (la empresa que contrata): su giro y las notas guardadas (zona, prestaciones que suele dar, cómo se le presenta en los anuncios, qué pide siempre). Llámala SIEMPRE en cuanto sepas el cliente de una vacante nueva, antes de redactar, y cuando te pregunte qué sabes de un cliente.', {
    cliente: { type: 'string', description: 'Nombre del cliente, sin el puesto. Ejemplo: "Península".' },
  }),
  herramienta('guardar_ficha_cliente', 'Guarda contexto de un cliente para usarlo en sus próximas vacantes. Úsala cuando la reclutadora te pida recordar, anotar o corregir algo de un cliente, cuando ella te cuente un dato que vale para todas sus vacantes ("Península siempre da bono de permanencia") y cuando TÚ descubras algo estable del cliente que la ficha no tenga, al comparar varias de sus vacantes publicadas (prestaciones que se repiten, ciudades donde contrata, sueldos por nivel de puesto). No guardes lo que sale de una sola vacante o de un solo anuncio pegado, ni nada sobre candidatos.', {
    cliente:          { type: 'string', description: 'Nombre del cliente.' },
    giro:             { type: 'string', description: 'A qué se dedica la empresa, en pocas palabras. Reemplaza al giro guardado. Cadena vacía si no lo dijo.' },
    notas:            { type: 'string', description: 'Lo que hay que recordar del cliente, un dato por línea, con sus palabras. Se suma a las notas que ya tenía. Cadena vacía si no hay.' },
    reemplazar_notas: { type: 'boolean', description: 'false (lo normal): las notas se suman a las guardadas. true: las notas guardadas se BORRAN y quedan solo estas; úsalo para corregir o quitar algo, mandando las notas completas como deben quedar (lee antes la ficha).' },
  }),
  herramienta('resumen_evaluaciones', 'Dice cómo salieron evaluados los candidatos de una vacante: cuántos hay con 5, 4, 3, 2 y 1 estrellas, cuántos faltan por evaluar y cuántos hay por etapa. Solo cifras, nunca nombres. Por defecto cuenta SOLO a los candidatos activos (los que siguen en alguna etapa; los rechazados no cuentan).', {
    id:                 idVacante,
    incluir_rechazados: { type: 'boolean', description: 'false (lo normal): solo candidatos activos. true: todas las postulaciones evaluadas, también las rechazadas; solo si la reclutadora lo pide expresamente.' },
  }),
  herramienta('enviar_grafica', 'Dibuja una gráfica con datos que YA obtuviste de otra herramienta y se la manda a la reclutadora como imagen, antes de tu mensaje. Úsala cuando te pida una gráfica o cuando una comparación de varios datos (4 o más) se entienda mejor en imagen que en una lista. Los valores deben ser exactamente los que te devolvió la herramienta.', {
    titulo:    { type: 'string', description: 'Título corto de la gráfica, con la vacante o el periodo. Ejemplo: "Postulaciones por semana - Península - Almacenista".' },
    tipo:      { type: 'string', enum: TIPOS_GRAFICA, description: 'barras: comparar categorías (etapas, estrellas, clientes). lineas: evolución en el tiempo (días, semanas, meses). pastel: partes de un total, con pocas categorías.' },
    etiquetas: { type: 'array', items: { type: 'string' }, description: 'Una etiqueta corta por dato, en el orden en que se muestran. Nunca nombres de personas.' },
    valores:   { type: 'array', items: { type: 'number' }, description: 'El valor de cada etiqueta, en el mismo orden.' },
  }),
  herramienta('consultar_estadisticas', 'Cuenta y agrupa postulaciones o vacantes (datos AGREGADOS: solo totales y grupos, nunca datos de una persona). Úsala para preguntas de números que las otras herramientas no contestan: cuántas postulaciones llegaron en un periodo, cuántas se rechazaron o contrataron, cuántas hay por etapa, por día, semana o mes, cuánto lleva cada vacante, cuántas vacantes se publicaron por cliente o mes. Puede tardar.', {
    recurso:     { type: 'string', enum: RECURSOS, description: '"postulaciones" (personas que se postularon, contadas por su fecha de postulación) o "vacantes" (vacantes creadas).' },
    vacante_id:  { type: 'integer', description: 'Solo postulaciones: ID de la vacante en TeamTailor. 0 para todas las vacantes (con fecha en "desde" cuenta TODAS las postulaciones que llegaron en el periodo, de cualquier vacante; sin fechas, solo las vacantes publicadas y puede quedar incompleto: pide siempre un periodo).' },
    desde:       { type: 'string', description: 'Primer día a contar, AAAA-MM-DD. Cadena vacía si no hay límite. Hoy es el día de la fecha de la conversación.' },
    hasta:       { type: 'string', description: 'Último día a contar (incluido), AAAA-MM-DD. Cadena vacía si no hay límite.' },
    agrupar_por: { type: 'string', enum: AGRUPACIONES, description: 'ninguna: solo totales. Postulaciones: etapa, estado (activas, rechazadas, contratadas), vacante, tipo (operativas contra administrativas), dia, semana, mes, estrellas (cómo salieron evaluadas las postulaciones ACTIVAS de ese periodo, de 1 a 5 estrellas y sin evaluar; sirve para "las evaluaciones de las que llegaron hoy"). Vacantes: estado, vacante (por cliente), tipo, mes.' },
    tipo:        tipoDeVacante,
  }),
  herramienta('preparar_accion', 'Prepara un cambio sobre algo que ya existe en TeamTailor: editar el anuncio de una vacante, cerrarla o mover candidatos de etapa. NO lo hace: revisa que se pueda y deja el cambio listo para que la reclutadora lo confirme. Después cierra el turno con `responder` explicándole qué vas a hacer y preguntándole si confirma.', {
    tipo:             { type: 'string', enum: ['editar_vacante', 'cerrar_vacante', 'mover_candidatos'], description: 'La acción.' },
    id:               idVacante,
    titulo:           { type: 'string', description: 'editar_vacante: nuevo título público. Cadena vacía si no cambia.' },
    nombre_interno:   { type: 'string', description: 'editar_vacante: nuevo nombre interno. Cadena vacía si no cambia.' },
    descripcion:      { type: 'string', description: 'editar_vacante: el anuncio COMPLETO ya corregido, en HTML con solo <p>, <strong> y <ul><li> (parte del que trae leer_vacante_completa y cambia solo lo que pidió). Cadena vacía si no cambia.' },
    etapa_origen:     { type: 'string', description: 'mover_candidatos: etapa donde están hoy (ejemplo: "Bandeja de entrada"). Cadena vacía en otras acciones.' },
    etapa_destino:    { type: 'string', description: 'mover_candidatos: etapa a la que pasan. Cadena vacía en otras acciones.' },
    nombre_candidato: { type: 'string', description: 'mover_candidatos: el nombre que ELLA escribió, solo si pidió mover a una persona en particular; cadena vacía en cualquier otro caso.' },
    estrellas_minimas: { type: 'integer', description: 'mover_candidatos: mover solo a quienes tengan al menos estas estrellas en su evaluación (de 1 a 5). "Los de 5 estrellas" es 5; "los de 4 o 5" es 4. 0 si no pidió filtrar por estrellas.' },
    cantidad:         { type: 'integer', description: 'mover_candidatos: cuántas personas mover como máximo, empezando por las mejor evaluadas ("los primeros 5", "los 3 mejores"). 0 para mover a todas las que cumplan.' },
  }),
];

// El borrador completo de la vacante en cada turno: el código compara lo que cambió y decide si se publica (flujo.js).
const ACTUALIZAR_VACANTE_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_vacante',
    description: 'Genera la respuesta para la reclutadora y registra el estado más reciente de los datos de la vacante que se va a crear.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Mensaje conversacional a enviar por WhatsApp a la reclutadora (preguntas, comentarios, o la pregunta de confirmación). El sistema manda el anuncio por separado, junto con la imagen: nunca incluyas aquí el anuncio completo ni tags HTML.',
        },
        nombre_interno: {
          type:        'string',
          description: 'Nombre interno de la vacante, con el formato "Cliente - Vacante" o "Cliente - Vacante (Ubicación)" si la reclutadora incluyó la ubicación en el nombre. Ejemplo: "Península - Almacenista". Cadena vacía si aún no se conoce.',
        },
        titulo: {
          type:        'string',
          description: 'Título público de la vacante. Cadena vacía si aún no se conoce.',
        },
        ubicacion: {
          type:        'string',
          description: 'Ciudad (y estado si lo sabes) donde estará la vacante, tal como lo dio la reclutadora. Ejemplo: "Guadalajara, Jalisco". Cadena vacía si aún no se conoce.',
        },
        descripcion: {
          type:        'string',
          description: 'Cuerpo completo de la vacante (contexto, oferta, responsabilidades, requisitos, cierre) en HTML, usando únicamente <p>, <strong> y <ul><li>. Cadena vacía si aún faltan secciones.',
        },
        contexto: {
          type:        'string',
          description: 'Información interna (sin HTML) para el sistema que evalúa candidatos, genera preguntas de entrevista y decide inclusión/exclusión. Es DISTINTA de la presentación pública del anuncio, no se publica. Cadena vacía si aún no se conoce.',
        },
        confirmado: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora confirmó explícitamente, en su último mensaje, que se cree la vacante con el resumen que ya se le mostró.',
        },
        escena_imagen: {
          type:        'string',
          description: 'Descripción breve EN INGLÉS de la escena de la foto que acompaña al anuncio (persona realizando el puesto, lugar, ropa), basada en el puesto y SIN texto. Incorpora, acumulados, los comentarios de la reclutadora sobre cómo debe verse la imagen. Cadena vacía si aún no se conoce el puesto.',
        },
        generar_imagen: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora pidió otra imagen o dio comentarios sobre cómo debe ser la imagen en su último mensaje. La primera imagen se genera automáticamente, no hace falta marcarlo.',
        },
        descripcion_modificada: {
          type:        'boolean',
          description: 'true SOLO si en este turno cambiaste el contenido de "descripcion" porque la reclutadora dio o corrigió algo (sueldo, horario, funciones, requisitos, título, ciudad...) o porque la armaste por primera vez. false si solo es una consulta, un "ok" o un cambio de imagen: entonces copia "descripcion" tal cual venía en el borrador.',
        },
        contexto_modificado: {
          type:        'boolean',
          description: 'true SOLO si en este turno cambiaste el contenido de "contexto" por lo que dijo la reclutadora. false en cualquier otro caso: copia "contexto" tal cual venía.',
        },
        mostrar_anuncio: {
          type:        'boolean',
          description: 'true SOLO si en su último mensaje pide ver otra vez el anuncio, la vista previa, la imagen o "la vacante" que se está creando ("déjame verla", "mándame la previsualización", "no me llegó"): el sistema le reenvía la imagen con el anuncio arriba de tu mensaje. false en cualquier otro caso (cuando el anuncio cambia, el sistema lo manda solo).',
        },
        datos_supuestos: {
          type:        'array',
          items:       { type: 'string' },
          description: 'Lo que tú completaste y la reclutadora no dio ni confirmó (prestaciones típicas, funciones o requisitos del sector, cierre, horario...), uno por elemento y en pocas palabras, para que lo revise. Lista vacía si todo lo dio ella. El sistema se lo muestra: no lo escribas en "mensaje".',
        },
      },
      required: ['mensaje', 'nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'confirmado', 'escena_imagen', 'generar_imagen', 'descripcion_modificada', 'contexto_modificado', 'mostrar_anuncio', 'datos_supuestos'],
    },
  },
};

export const HERRAMIENTAS_DE_CIERRE = [
  herramienta('responder', 'Termina el turno con un mensaje para la reclutadora, sin tocar el borrador de vacante.', {
    mensaje: mensaje('Mensaje de WhatsApp para la reclutadora.'),
  }),
  ACTUALIZAR_VACANTE_TOOL,
  herramienta('resolver_accion', 'Termina el turno cuando hay una ACCIÓN PENDIENTE de confirmar (editar, cerrar, mover candidatos) y la reclutadora contesta si la hace o no.', {
    decision: { type: 'string', enum: ['confirmar', 'cancelar'], description: '"confirmar" solo si su último mensaje es un sí claro a esa acción ("sí", "va", "confirmo", "hazlo"). Repetir o corregir un dato, "espera", "pero" o una pregunta NO son confirmación: ahí no uses esta herramienta. "cancelar" si dice que no o que ya no.' },
    mensaje:  mensaje('Mensaje de WhatsApp. Si confirma, el sistema manda el resultado por su cuenta: aquí solo una frase corta. Si cancela, avisa que no se hizo nada.'),
    algo_mas: mensaje('Solo cuando confirma Y en ese mismo mensaje pregunta, duda o pide otra cosa ("sí, y también borra al cliente", "sí, pero ¿por qué dice almacén?"): la respuesta a eso, sin repetir que la acción se hizo. El sistema la manda después del resultado. Cadena vacía si solo confirmó.'),
  }),
  herramienta('descartar_vacante', 'Termina el turno descartando el borrador de la vacante que se estaba creando. Solo si la reclutadora lo pide.', {
    mensaje: mensaje('Mensaje de WhatsApp para la reclutadora confirmando que se descartó.'),
  }),
];

export const HERRAMIENTAS = [...HERRAMIENTAS_DE_CONSULTA, ...HERRAMIENTAS_DE_CIERRE];
export const esDeCierre = nombre => HERRAMIENTAS_DE_CIERRE.some(h => h.function.name === nombre);

async function buscarVacantes(supabase, texto) {
  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  if (!palabras.length) return { vacantes: [] };

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, titulo_externo, estatus, creado, tipo');
  if (error) throw error;

  const encontradas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null)
    .filter(fila => {
      const donde = normalizarTexto(`${fila.vacante ?? ''} ${fila.titulo_externo ?? ''} ${fila.id_team_tailor}`);
      return palabras.every(palabra => donde.includes(palabra));
    })
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  return {
    vacantes: encontradas.slice(0, MAXIMO_VACANTES_ENCONTRADAS)
      .map(fila => ({ id: fila.id_team_tailor, nombre_interno: fila.vacante, titulo: fila.titulo_externo, estatus: fila.estatus, tipo: nombreDelTipo(fila), publicada_el: String(fila.creado ?? '').slice(0, 10) })),
    ...(encontradas.length > MAXIMO_VACANTES_ENCONTRADAS ? { nota: `Hay ${encontradas.length} coincidencias; se muestran las ${MAXIMO_VACANTES_ENCONTRADAS} más recientes. Pide un dato más para acotar.` } : {}),
  };
}

const VACANTE_NO_ENCONTRADA = { error: 'No existe una vacante con ese ID.' };

// `adjuntos` junta los textos que el sistema manda tal cual debajo del mensaje del agente (lo que ve el candidato
// no debe pasar por la redacción del modelo).
// `pendiente` es la acción (editar, cerrar, mover) que el agente dejó lista para confirmar en este turno.
// `textoReclutadora` es lo que ella escribió: de ahí salen las cifras que el anuncio puede mencionar.
// `avisarEspera` manda "un momento" si una consulta tarda más de `esperaMs`.
// `subirGrafica(buffer)` guarda la imagen de una gráfica y devuelve su ruta; `ejecutor.graficas` junta las de este turno.
const ESPERA_AVISO_MS = 4_000;

// ── Consultas recientes ──────────────────────────────────────────────────────
// Recorrer TeamTailor es lo caro. Lo que una consulta devolvió se guarda unos minutos en el estado de la reclutadora
// (`temporal.reclutador.consultas`): si en ese rato vuelve a preguntar lo mismo, o lo mismo desglosado de otra forma,
// se contesta con lo guardado en vez de volver a consultarlo.
export const VIGENCIA_CONSULTA_MS = 10 * 60 * 1000;
const CONSULTAS_GUARDADAS = 6;
const SE_GUARDAN = new Set(['consultar_estadisticas', 'contar_candidatos', 'resumen_evaluaciones', 'listar_vacantes', 'consultar_agenda']);
const MAXIMO_ANUNCIOS_POR_TURNO = 2;

const sinValor = valor => valor == null || valor === '' || valor === 0 || valor === false || valor === 'todas' || valor === 'ninguna';
const esDePostulaciones = (nombre, argumentos) => nombre === 'consultar_estadisticas' && (argumentos?.recurso ?? 'postulaciones') !== 'vacantes';
// La clave no lleva los valores vacíos ni, en las estadísticas de postulaciones, la agrupación: una misma pasada trae todos los desgloses.
function claveDeConsulta(nombre, argumentos = {}) {
  const pares = Object.entries(argumentos).filter(([clave, valor]) => !sinValor(valor) && !(clave === 'recurso' && valor === 'postulaciones')
    && !(clave === 'agrupar_por' && esDePostulaciones(nombre, argumentos)));
  return `${nombre} ${JSON.stringify(pares.sort(([a], [b]) => a.localeCompare(b)))}`;
}
export const consultasVigentes = (consultas, ahora = Date.now()) =>
  (Array.isArray(consultas) ? consultas : []).filter(consulta => consulta?.clave && ahora - Date.parse(consulta.cuando) < VIGENCIA_CONSULTA_MS);

// Lo guardado, visto con la agrupación que se pide ahora. null si esa agrupación no quedó guardada (hay que consultar).
function conOtraAgrupacion(resultado, agrupacion) {
  if (!resultado?.desgloses || sinValor(agrupacion) || agrupacion === resultado.agrupado_por || agrupacion === 'estado') return resultado;
  const todos = { ...resultado.desgloses, ...(resultado.agrupado_por ? { [resultado.agrupado_por]: resultado.grupos } : {}) };
  if (!todos[agrupacion]) return null;
  const { [agrupacion]: grupos, ...desgloses } = todos;
  return { ...resultado, agrupado_por: agrupacion, grupos, desgloses };
}

export function crearEjecutor({ supabase, log, reclutador = null, textoReclutadora = '', avisarEspera = null, esperaMs = ESPERA_AVISO_MS, pausaConsultasMs, estadisticas = consultarEstadisticas, subirGrafica = null, consultasPrevias = [] }) {
  const adjuntos = [];
  // `consultas`: las recientes que siguen vigentes más las de este turno; `consultasNuevas` dice si hay que guardarlas.
  const ejecutor = { adjuntos, pendiente: null, textoLeido: [], vacantesLeidas: [], graficas: [], consultas: consultasVigentes(consultasPrevias), consultasNuevas: false };
  const graficasEnviadas = new Set();
  let avisoEnCurso = null;

  // Si `trabajo` tarda, la reclutadora recibe un aviso (una sola vez por turno) en vez de quedarse sin respuesta.
  async function conAviso(trabajo) {
    const temporizador = avisarEspera ? setTimeout(() => { avisoEnCurso ??= Promise.resolve().then(avisarEspera).catch(e => log('aviso_espera', { estado: 'error', error: e.message })); }, esperaMs) : null;
    try {
      return await trabajo();
    } finally {
      clearTimeout(temporizador);
      if (avisoEnCurso) await avisoEnCurso; // el aviso va antes que la respuesta
    }
  }

  const consultas = {
    listar_vacantes:       ({ texto, filtro, tipo, solo_mias: soloMias }) => (soloMias === true && !reclutador?.idTeamTailor
      ? { error: 'Su usuario no tiene ligado un usuario de TeamTailor: no se puede saber qué vacantes son suyas.' }
      : conAviso(() => listarVacantes(supabase, { texto, filtro, tipo, soloDe: soloMias === true ? reclutador.idTeamTailor : null }))),
    consultar_agenda:      argumentos => conAviso(() => consultarAgenda(supabase, argumentos)),
    // Queda en la tabla `eventos` (ver registro.js), que es donde el equipo de sistemas revisa lo que pasa con el agente.
    registrar_retroalimentacion: ({ comentario }) => {
      const texto = String(comentario ?? '').trim();
      if (!texto) return { error: 'Falta el comentario.' };
      log('retroalimentacion_reclutador', { estado: 'ok', guardar: true, de: reclutador?.nombre ?? '', comentario: texto.slice(0, MAXIMO_RETROALIMENTACION).match(/[\s\S]{1,450}/g) }); // en partes: el registro recorta cada texto a 500 caracteres
      return { registrada: true, nota: 'Confírmale en una línea que su comentario quedó registrado para el equipo de sistemas. No prometas fechas ni que se va a hacer.' };
    },

    consultar_estadisticas: argumentos => conAviso(() => estadisticas(supabase, argumentos, { pausaMs: pausaConsultasMs })),
    ver_ficha_cliente:     async argumentos => { const ficha = await verFichaCliente(supabase, argumentos); ejecutor.textoLeido.push(JSON.stringify(ficha.ficha ?? {})); return ficha; }, // solo la ficha respalda datos del anuncio: los sueldos y horarios de sus otras vacantes, no
    guardar_ficha_cliente: argumentos => guardarFichaCliente(supabase, argumentos),
    resumen_evaluaciones:  ({ id, incluir_rechazados }) => conAviso(() => resumenEvaluaciones(supabase, { id, incluir_rechazados }, { pausaMs: pausaConsultasMs })),

    // La gráfica se dibuja y se guarda aquí; el flujo la manda antes del mensaje del agente.
    enviar_grafica: async ({ titulo, tipo, etiquetas, valores }) => {
      const datos = { titulo: String(titulo ?? '').trim(), tipo, etiquetas, valores: Array.isArray(valores) ? valores.map(Number) : valores };
      const problema = problemaDeGrafica(datos);
      if (problema) return { error: problema };
      if (!subirGrafica) return { error: 'No se pueden mandar gráficas en este momento.' };
      // La misma gráfica pedida otra vez en el turno no se manda dos veces (el 9-oct-2026 llegaron tres iguales).
      const huella = JSON.stringify([datos.tipo, datos.etiquetas, datos.valores]);
      if (graficasEnviadas.has(huella)) return { enviada: true, nota: 'Esa gráfica ya está enviada en este turno: no la mandes otra vez. Cierra el turno con tu mensaje.' };
      graficasEnviadas.add(huella);
      ejecutor.graficas.push({ ruta: await subirGrafica(dibujarGrafica(datos)), titulo: datos.titulo });
      return { enviada: true, nota: 'El sistema le manda la gráfica antes de tu mensaje. En "mensaje" di en una línea qué muestra y el dato principal; no repitas todas las cifras.' };
    },
    leer_vacante_completa: async ({ id }) => {
      const vacante = await leerVacanteCompleta(Number(id));
      // Se anota de qué vacante salió: sus cifras y horarios solo respaldan una vacante nueva del mismo cliente (ver flujo.js).
      if (vacante) ejecutor.vacantesLeidas.push({ nombre_interno: vacante.nombre_interno, texto: `${vacante.descripcion}\n${vacante.contexto}` });
      return vacante ?? VACANTE_NO_ENCONTRADA;
    },

    preparar_accion: async argumentos => {
      const preparada = await prepararAccion({ supabase, log, textoReclutadora }, argumentos);
      if (!preparada.ok) return { error: preparada.error };
      // Varias acciones preparadas en el turno se confirman juntas, con un solo "sí".
      ejecutor.pendiente = juntarAcciones(ejecutor.pendiente, preparada.pendiente);
      const varias = ejecutor.pendiente.tipo === 'varias';
      return { preparada: true, que_se_va_a_hacer: preparada.vista_previa, ...(varias ? { nota: `Ya van ${ejecutor.pendiente.acciones.length} acciones preparadas en este turno; se confirman TODAS juntas con un solo "sí": pídele una sola confirmación para todas.` } : {}) };
    },

    buscar_vacantes: ({ texto }) => buscarVacantes(supabase, texto),

    // El anuncio solo se le manda si lo pidió (`mostrar`) y nunca más de dos por turno: el 9-oct-2026, al comparar las
    // prestaciones de un cliente, le llegaron ocho anuncios completos seguidos.
    ver_vacante: async ({ id, mostrar }) => {
      const vacante = await obtenerVacante(supabase, Number(id), { log });
      if (!vacante) return VACANTE_NO_ENCONTRADA;

      const informacion = mensajeInformacionVacante(vacante.informacion);
      const seManda = mostrar === true && (adjuntos.includes(informacion) || adjuntos.length < MAXIMO_ANUNCIOS_POR_TURNO);
      if (seManda && !adjuntos.includes(informacion)) adjuntos.push(informacion);
      return {
        titulo: vacante.titulo,
        informacion: vacante.informacion,
        preguntas_al_candidato: vacante.preguntas.map(pregunta => pregunta.texto),
        nota: seManda
          ? 'El sistema le manda la información debajo de tu mensaje, tal como la ve el candidato: no la repitas.'
          : mostrar === true
          ? `Este anuncio NO se le manda: ya van ${MAXIMO_ANUNCIOS_POR_TURNO} en este turno. Dile que le mandaste esos y que te pida los demás.`
          : 'Este anuncio NO se le manda a la reclutadora: lo leíste tú. Contesta con el dato que buscabas, en pocas líneas.',
      };
    },

    contar_candidatos: async ({ id }) => {
      const conteo = await contarCandidatos(Number(id));
      // El total va ya sumado: el modelo se equivoca al sumar las etapas por su cuenta.
      return conteo
        ? { en_bandeja_de_entrada: conteo.total, llegaron_hoy: conteo.hoy, por_etapa: conteo.etapas, activos_en_todas_las_etapas: conteo.etapas.reduce((suma, etapa) => suma + etapa.personas, 0) }
        : VACANTE_NO_ENCONTRADA;
    },
  };

  return Object.assign(ejecutor, {
    async ejecutar(nombre, argumentos) {
      // Lo que queda en el registro (y, si falla, en la tabla `eventos`) no lleva el nombre del candidato.
      const paraElRegistro = argumentos?.nombre_candidato ? { ...argumentos, nombre_candidato: '[nombre]' } : argumentos;
      try {
        // Lo que ya se consultó hace poco se contesta con lo guardado.
        const clave = SE_GUARDAN.has(nombre) ? claveDeConsulta(nombre, argumentos) : null;
        const guardada = clave && ejecutor.consultas.find(consulta => consulta.clave === clave);
        const reutilizado = guardada && (esDePostulaciones(nombre, argumentos) ? conOtraAgrupacion(guardada.resultado, argumentos?.agrupar_por) : guardada.resultado);
        if (reutilizado) {
          log('herramienta_reclutador', { estado: 'ok', herramienta: nombre, argumentos: paraElRegistro, reutilizada: true });
          return reutilizado;
        }

        const resultado = await consultas[nombre](argumentos ?? {});
        log('herramienta_reclutador', { estado: 'ok', herramienta: nombre, argumentos: paraElRegistro });
        // No se guardan los errores ni las consultas que se cortaron a medias (cifras parciales).
        if (clave && resultado && !resultado.error && !/parciales/.test(resultado.nota ?? '')) {
          ejecutor.consultas = [{ clave, herramienta: nombre, argumentos: paraElRegistro ?? {}, cuando: new Date().toISOString(), resultado }, ...ejecutor.consultas.filter(consulta => consulta.clave !== clave)].slice(0, CONSULTAS_GUARDADAS);
          ejecutor.consultasNuevas = true;
        }
        return resultado;
      } catch (e) {
        log('herramienta_reclutador', { estado: 'error', herramienta: nombre, argumentos: paraElRegistro, error: e.message });
        return { error: 'No se pudo consultar en este momento.' };
      }
    },
  });
}
