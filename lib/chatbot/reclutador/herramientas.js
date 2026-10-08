import { mensajeInformacionVacante } from '../constantes.js';
import { normalizarTexto } from '../utilidades.js';
import { obtenerVacante } from '../vacantes_supabase.js';
import { prepararAccion } from './acciones.js';
import { contarCandidatos } from './bandeja.js';
import { candidatosDestacados, guardarFichaCliente, leerVacanteCompleta, listarVacantes, verFichaCliente } from './consultas.js';

export { contarCandidatos };

// Herramientas del agente reclutador. Las de consulta devuelven datos y el modelo sigue trabajando con ellos; las
// de cierre terminan el turno con el mensaje para la reclutadora.

const MAXIMO_VACANTES_ENCONTRADAS = 10;

const herramienta = (nombre, descripcion, propiedades) => ({
  type: 'function',
  function: { name: nombre, description: descripcion, parameters: { type: 'object', properties: propiedades, required: Object.keys(propiedades) } },
});
const idVacante = { type: 'integer', description: 'ID de la vacante en TeamTailor (el número que va después del # en el enlace de la vacante).' };
const mensaje   = descripcion => ({ type: 'string', description: descripcion });

export const HERRAMIENTAS_DE_CONSULTA = [
  herramienta('buscar_vacantes', 'Busca vacantes por nombre interno, título o cliente y devuelve sus IDs. Úsala cuando la reclutadora se refiera a una vacante sin dar su ID.', {
    texto: { type: 'string', description: 'Palabras a buscar (cliente, puesto o ambos). Ejemplo: "península almacenista".' },
  }),
  herramienta('ver_vacante', 'Trae la información de una vacante tal como se le muestra a un candidato, y sus preguntas. El sistema le manda esa información a la reclutadora debajo de tu mensaje.', {
    id: idVacante,
  }),
  herramienta('contar_candidatos', 'Dice cómo va una vacante en TeamTailor: cuántas personas tiene en la bandeja de entrada, cuántas de ellas llegaron en las últimas 24 horas y cuántas hay en cada etapa del proceso. No cuenta las rechazadas.', {
    id: idVacante,
  }),
  herramienta('listar_vacantes', 'Lista las vacantes publicadas con cuántas personas tienen en la bandeja y cuántas llegaron en las últimas 24 horas. Úsala para "mis vacantes", "qué vacantes hay", "cuáles no tienen candidatos" o un resumen de todas.', {
    texto:  { type: 'string', description: 'Cliente o puesto para acotar la lista. Cadena vacía para todas.' },
    filtro: { type: 'string', enum: ['todas', 'sin_candidatos_nuevos', 'bandeja_vacia'], description: '"sin_candidatos_nuevos": nadie llegó en las últimas 24 horas. "bandeja_vacia": ninguna persona en la bandeja de entrada.' },
  }),
  herramienta('leer_vacante_completa', 'Trae de TeamTailor el anuncio completo en HTML, el título, el nombre interno, la ubicación y el contexto de una vacante que ya existe. Úsala para clonar una vacante (tomarla como base de una nueva) o para editar su anuncio.', {
    id: idVacante,
  }),
  herramienta('ver_ficha_cliente', 'Busca la ficha de un cliente: a qué se dedica y notas sobre él. Llámala en cuanto sepas el cliente de una vacante nueva.', {
    cliente: { type: 'string', description: 'Nombre del cliente, sin el puesto. Ejemplo: "Península".' },
  }),
  herramienta('guardar_ficha_cliente', 'Guarda o completa la ficha de un cliente. Solo cuando la reclutadora te pida recordar algo del cliente (a qué se dedica, notas).', {
    cliente:      { type: 'string', description: 'Nombre del cliente.' },
    giro:         { type: 'string', description: 'A qué se dedica la empresa, en pocas palabras. Cadena vacía si no lo dijo.' },
    notas:        { type: 'string', description: 'Cualquier otra cosa que pidió recordar. Cadena vacía si no hay.' },
  }),
  herramienta('candidatos_destacados', 'Dice cuántas postulaciones de una vacante ya están evaluadas, cuántas sacaron 4 o 5 estrellas y quiénes son las mejor evaluadas.', {
    id:     idVacante,
    limite: { type: 'integer', description: 'Cuántas personas listar (de 1 a 10).' },
  }),
  herramienta('preparar_accion', 'Prepara un cambio sobre algo que ya existe en TeamTailor: editar el anuncio de una vacante, cerrarla o mover candidatos de etapa. NO lo hace: revisa que se pueda y deja el cambio listo para que la reclutadora lo confirme. Después cierra el turno con `responder` explicándole qué vas a hacer y preguntándole si confirma.', {
    tipo:             { type: 'string', enum: ['editar_vacante', 'cerrar_vacante', 'mover_candidatos'], description: 'La acción.' },
    id:               idVacante,
    titulo:           { type: 'string', description: 'editar_vacante: nuevo título público. Cadena vacía si no cambia.' },
    nombre_interno:   { type: 'string', description: 'editar_vacante: nuevo nombre interno. Cadena vacía si no cambia.' },
    descripcion:      { type: 'string', description: 'editar_vacante: el anuncio COMPLETO ya corregido, en HTML con solo <p>, <strong> y <ul><li> (parte del que trae leer_vacante_completa y cambia solo lo que pidió). Cadena vacía si no cambia.' },
    etapa_origen:     { type: 'string', description: 'mover_candidatos: etapa donde están hoy (ejemplo: "Bandeja de entrada"). Cadena vacía en otras acciones.' },
    etapa_destino:    { type: 'string', description: 'mover_candidatos: etapa a la que pasan. Cadena vacía en otras acciones.' },
    nombre_candidato: { type: 'string', description: 'mover_candidatos: solo si pidió mover a una persona en particular; cadena vacía para mover a todas las de la etapa.' },
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
        datos_supuestos: {
          type:        'array',
          items:       { type: 'string' },
          description: 'Lo que tú completaste y la reclutadora no dio ni confirmó (prestaciones típicas, funciones o requisitos del sector, cierre, horario...), uno por elemento y en pocas palabras, para que lo revise. Lista vacía si todo lo dio ella. El sistema se lo muestra: no lo escribas en "mensaje".',
        },
      },
      required: ['mensaje', 'nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'confirmado', 'escena_imagen', 'generar_imagen', 'descripcion_modificada', 'contexto_modificado', 'datos_supuestos'],
    },
  },
};

export const HERRAMIENTAS_DE_CIERRE = [
  herramienta('responder', 'Termina el turno con un mensaje para la reclutadora, sin tocar el borrador de vacante.', {
    mensaje: mensaje('Mensaje de WhatsApp para la reclutadora.'),
  }),
  ACTUALIZAR_VACANTE_TOOL,
  herramienta('resolver_accion', 'Termina el turno cuando hay una ACCIÓN PENDIENTE de confirmar (editar, cerrar, mover candidatos) y la reclutadora contesta si la hace o no.', {
    decision: { type: 'string', enum: ['confirmar', 'cancelar'], description: '"confirmar" solo si su último mensaje es un sí claro a esa acción. "cancelar" si dice que no o que ya no.' },
    mensaje:  mensaje('Mensaje de WhatsApp. Si confirma, el sistema manda el resultado por su cuenta: aquí solo una frase corta. Si cancela, avisa que no se hizo nada.'),
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

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, titulo_externo, estatus, creado');
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
      .map(fila => ({ id: fila.id_team_tailor, nombre_interno: fila.vacante, titulo: fila.titulo_externo, estatus: fila.estatus })),
    ...(encontradas.length > MAXIMO_VACANTES_ENCONTRADAS ? { nota: `Hay ${encontradas.length} coincidencias; se muestran las ${MAXIMO_VACANTES_ENCONTRADAS} más recientes. Pide un dato más para acotar.` } : {}),
  };
}

const VACANTE_NO_ENCONTRADA = { error: 'No existe una vacante con ese ID.' };

// `adjuntos` junta los textos que el sistema manda tal cual debajo del mensaje del agente (lo que ve el candidato
// no debe pasar por la redacción del modelo).
// `pendiente` es la acción (editar, cerrar, mover) que el agente dejó lista para confirmar en este turno.
// `textoReclutadora` es lo que ella escribió: de ahí salen las cifras que el anuncio puede mencionar.
export function crearEjecutor({ supabase, log, textoReclutadora = '' }) {
  const adjuntos = [];
  const ejecutor = { adjuntos, pendiente: null, textoLeido: [] };

  const consultas = {
    listar_vacantes:       ({ texto, filtro }) => listarVacantes(supabase, { texto, filtro }),
    ver_ficha_cliente:     async argumentos => { const ficha = await verFichaCliente(supabase, argumentos); ejecutor.textoLeido.push(JSON.stringify(ficha)); return ficha; },
    guardar_ficha_cliente: argumentos => guardarFichaCliente(supabase, argumentos),
    candidatos_destacados: ({ id, limite }) => candidatosDestacados(supabase, { id, limite }),
    leer_vacante_completa: async ({ id }) => {
      const vacante = await leerVacanteCompleta(Number(id));
      if (vacante) ejecutor.textoLeido.push(`${vacante.descripcion}\n${vacante.contexto}`);
      return vacante ?? VACANTE_NO_ENCONTRADA;
    },

    preparar_accion: async argumentos => {
      const preparada = await prepararAccion({ supabase, log, textoReclutadora }, argumentos);
      if (!preparada.ok) return { error: preparada.error };
      ejecutor.pendiente = preparada.pendiente;
      return { preparada: true, que_se_va_a_hacer: preparada.vista_previa };
    },

    buscar_vacantes: ({ texto }) => buscarVacantes(supabase, texto),

    ver_vacante: async ({ id }) => {
      const vacante = await obtenerVacante(supabase, Number(id), { log });
      if (!vacante) return VACANTE_NO_ENCONTRADA;

      const informacion = mensajeInformacionVacante(vacante.informacion);
      if (!adjuntos.includes(informacion)) adjuntos.push(informacion);
      return {
        titulo: vacante.titulo,
        informacion: vacante.informacion,
        preguntas_al_candidato: vacante.preguntas.map(pregunta => pregunta.texto),
        nota: 'El sistema le manda la información debajo de tu mensaje, tal como la ve el candidato: no la repitas.',
      };
    },

    contar_candidatos: async ({ id }) => {
      const conteo = await contarCandidatos(Number(id));
      return conteo ? { en_bandeja_de_entrada: conteo.total, llegaron_en_las_ultimas_24_horas: conteo.recientes, por_etapa: conteo.etapas } : VACANTE_NO_ENCONTRADA;
    },
  };

  return Object.assign(ejecutor, {
    async ejecutar(nombre, argumentos) {
      try {
        const resultado = await consultas[nombre](argumentos ?? {});
        log('herramienta_reclutador', { estado: 'ok', herramienta: nombre, argumentos });
        return resultado;
      } catch (e) {
        log('herramienta_reclutador', { estado: 'error', herramienta: nombre, argumentos, error: e.message });
        return { error: 'No se pudo consultar en este momento.' };
      }
    },
  });
}
