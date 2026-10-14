import { MODELOS } from '../modelos.js';
import { argumentosDeHerramienta, orChatCompletion } from '../openrouter.js';
import { leerPrompt } from '../prompts.js';
import { GENERO_TOOL, INFORME_TOOL, INFORME_TOOL_OPERATIVO, construirToolClasificacion } from './esquema.js';
import { avisar } from '../registro.js';

// Las llamadas a los modelos de /informes: clasificar las preguntas, inferir el género y redactar (o corregir) el informe.

const PROMPT_ANALISIS_ESTRUCTURADO           = leerPrompt('informes/analisis_estructurado');
const PROMPT_ANALISIS_ESTRUCTURADO_OPERATIVO = leerPrompt('informes/analisis_estructurado_operativo');
// El modelo principal no acepta que se le obligue a usar la herramienta: si contesta sin usarla, se reintenta.
const OPENROUTER_MODEL             = MODELOS.informe;
const INTENTOS_ANALISIS            = 3;
const OPENROUTER_MODEL_AUXILIAR    = MODELOS.informeAuxiliar;
const RAZONAMIENTO_AUXILIAR        = { effort: 'low' }; // apagarlo es más lento con este modelo
const OPENROUTER_MODEL_CLASIFICACION = MODELOS.informeClasificacion;
const INTENTOS_CLASIFICACION       = 2;
// Lo que el modelo no alcanzó a clasificar (la respuesta llegó cortada o no contestó): esas respuestas van al informe
// de todos modos, con su pregunta, en una sección aparte. Una pregunta que el modelo marcó "NINGUNA" sí se deja fuera.
export const SIN_CLASIFICAR        = 'SIN_CLASIFICAR';
export const TITULO_SIN_CLASIFICAR = 'RESPUESTAS_SIN_CLASIFICAR';
// Las correcciones las aplica Haiku, razonando alto: así cambia solo lo que pide el reclutador (con menos, el modelo
// anterior a veces retocaba de más). Tampoco acepta la herramienta forzada: se reintenta igual que el informe.
const OPENROUTER_MODEL_CORRECCION  = MODELOS.informeCorreccion;
const RAZONAMIENTO_CORRECCION      = { effort: 'high' };

// Lo que cambia entre el informe administrativo y el operativo.
export const MODOS = {
  administrativo: { prompt: PROMPT_ANALISIS_ESTRUCTURADO,           tool: INFORME_TOOL,           nombreTool: 'informe_estructurado' },
  operativo:      { prompt: PROMPT_ANALISIS_ESTRUCTURADO_OPERATIVO, tool: INFORME_TOOL_OPERATIVO, nombreTool: 'informe_operativo_estructurado' },
};

// Cada llamada de IA queda anotada en `llamadas` con su actividad, modelo, costo y duración, también cuando falla.
// `detalle` son datos de la entrada de esa llamada que ayudan a entender el resultado (cuántas preguntas se
// clasificaron, si el análisis llevó el CV adjunto). Nunca texto del candidato.
export function anotarLlamada(llamadas, actividad, modelo, inicio, datos, error, detalle) {
  llamadas?.push({
    actividad, modelo, ...detalle,
    segundos:       Number(((Date.now() - inicio) / 1000).toFixed(1)),
    costo_usd:      datos?.usage?.cost ?? null,
    tokens_entrada: datos?.usage?.prompt_tokens ?? null,
    tokens_salida:  datos?.usage?.completion_tokens ?? null,
    ...(error && { fallo: true }),
  });
}

// Llamada de chat a OpenRouter que queda anotada en `llamadas`, también cuando falla.
export async function llamarModelo(llamadas, actividad, peticion, detalle) {
  const inicio = Date.now();
  try {
    const datos = await orChatCompletion(peticion, process.env.OPENROUTER_API_KEY_INFORMES);
    anotarLlamada(llamadas, actividad, datos?.modeloUsado ?? peticion.model, inicio, datos, null, detalle); // Haiku si GLM falló
    return datos;
  } catch (error) {
    anotarLlamada(llamadas, actividad, peticion.model, inicio, null, error, detalle);
    throw error;
  }
}

// Lee las clasificaciones que devolvió el modelo. Si el JSON llegó cortado (el 13-oct-2026 un proveedor lo entregó sin
// sus últimos 11 caracteres, marcado como completo), se rescatan las entradas que sí llegaron enteras en vez de tirarlas
// todas. Devuelve { clasificaciones: [{ indice, intencion }], cortada }.
export function leerClasificaciones(argumentos) {
  if (argumentos && typeof argumentos === 'object') return { clasificaciones: Array.isArray(argumentos.clasificaciones) ? argumentos.clasificaciones : [], cortada: false };
  const texto = String(argumentos ?? '');
  try {
    const leido = JSON.parse(texto);
    return { clasificaciones: Array.isArray(leido?.clasificaciones) ? leido.clasificaciones : [], cortada: false };
  } catch {
    const enteras = [...texto.matchAll(/\{\s*"indice"\s*:\s*(\d+)\s*,\s*"intencion"\s*:\s*"([A-Za-z_]+)"\s*\}/g)];
    return { clasificaciones: enteras.map(([, indice, intencion]) => ({ indice: Number(indice), intencion })), cortada: true };
  }
}

// Clasifica, con IA, cada pregunta contestada (venga de donde venga: formulario de
// TeamTailor, formulario de evaluación o preguntas personalizadas de WhatsApp) según
// la intención del catálogo que mejor le corresponda. Esto reemplaza el mapeo fijo de
// IDs de pregunta -> etiqueta, así el informe funciona sin importar el formato exacto
// de la entrevista o de la vacante.
//
// Devuelve { [índice]: intención }. Nunca lanza ni detiene el informe (decisión del usuario, 13-oct-2026: "dales lo que
// tengas, ellas lo arreglan, no las interrumpas"): si la respuesta no se puede leer completa se reintenta una vez y se
// usa el intento que más clasificó; lo que aun así quede sin clasificar va como SIN_CLASIFICAR, y el informe lo recibe
// igual. `llamar` solo se sustituye en las pruebas.
export async function clasificarPreguntasPorIntencion(paresPreguntaRespuesta, catalogoIntenciones, llamadas, { llamar = llamarModelo } = {}) {
  if (!paresPreguntaRespuesta.length) return {};

  const listaPreguntas = paresPreguntaRespuesta.map((par, indice) => `${indice}: ${par.pregunta}`).join('\n');
  const catalogoTexto  = Object.entries(catalogoIntenciones).map(([clave, descripcion]) => `- ${clave}: ${descripcion}`).join('\n');
  const tool           = construirToolClasificacion(catalogoIntenciones);
  const validas        = new Set([...Object.keys(catalogoIntenciones), 'NINGUNA']);
  const total          = paresPreguntaRespuesta.length;

  let mejor = new Map(); // índice → intención, del intento que más preguntas alcanzó a clasificar
  for (let intento = 1; intento <= INTENTOS_CLASIFICACION && mejor.size < total; intento++) {
    try {
      const datos = await llamar(llamadas, 'clasificacion', {
        model:     OPENROUTER_MODEL_CLASIFICACION,
        reasoning: RAZONAMIENTO_AUXILIAR,
        messages: [
          { role: 'system', content: 'Clasifica cada pregunta de una entrevista de candidato según la intención del catálogo que mejor le corresponda. Usa "NINGUNA" si la pregunta no corresponde a ninguna intención del catálogo. Devuelve una entrada por CADA pregunta, con la herramienta `clasificar_preguntas`.' },
          { role: 'user',   content: `Catálogo de intenciones:\n${catalogoTexto}\n\nPreguntas a clasificar:\n${listaPreguntas}` },
        ],
        tools:       [tool],
        tool_choice: 'required', // los modelos de Anthropic no aceptan que se les obligue a usar UNA herramienta en particular
      }, { preguntas: total, intento });

      const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'clasificar_preguntas');
      const { clasificaciones, cortada } = leerClasificaciones(llamada?.function?.arguments);
      const leidas = new Map(clasificaciones
        .filter(c => Number.isInteger(Number(c?.indice)) && Number(c.indice) >= 0 && Number(c.indice) < total && validas.has(c.intencion))
        .map(c => [Number(c.indice), c.intencion]));
      if (leidas.size > mejor.size) mejor = leidas;
      if (!llamada || cortada || leidas.size < total) {
        avisar({ etapa: 'clasificacion_preguntas', estado: leidas.size ? 'incompleta' : 'error', mensaje: !llamada ? 'el modelo no usó la herramienta' : cortada ? 'la respuesta llegó cortada' : 'faltaron preguntas', intento, preguntas: total, clasificadas: leidas.size });
      }
    } catch (error) {
      avisar({ etapa: 'clasificacion_preguntas', estado: 'error', mensaje: error.message, intento, preguntas: total });
    }
  }

  const porIndice = {};
  for (let indice = 0; indice < total; indice++) {
    const intencion = mejor.get(indice) ?? SIN_CLASIFICAR;
    if (intencion !== 'NINGUNA') porIndice[indice] = intencion;
  }
  return porIndice;
}

// Agrupa las respuestas del candidato bajo la intención con la que fueron clasificadas,
// en el mismo formato de bloque que antes se armaba a partir del mapeo fijo de IDs. Las que quedaron sin clasificar van
// al final, cada una con su pregunta (sin ella el modelo no sabría de qué habla la respuesta).
export function construirBloqueRespuestasPorIntencion(paresPreguntaRespuesta, clasificacionPorIndice, catalogoIntenciones) {
  const porIntencion = {};
  const sueltas = [];

  paresPreguntaRespuesta.forEach((par, indice) => {
    const intencion = clasificacionPorIndice[indice];
    if (!intencion) return;
    if (intencion === SIN_CLASIFICAR) { sueltas.push(`Pregunta: ${par.pregunta}\nRespuesta: ${par.respuesta}`); return; }
    (porIntencion[intencion] ??= []).push(par.respuesta);
  });

  const lineas = [];
  for (const clave of Object.keys(catalogoIntenciones)) {
    const valores = porIntencion[clave];
    if (!valores?.length) continue;
    lineas.push(`### ${clave}\n${valores.join('\n')}`);
  }
  if (sueltas.length) lineas.push(`### ${TITULO_SIN_CLASIFICAR}\n${sueltas.join('\n\n')}`);

  return lineas.length ? lineas.join('\n\n') : '(Sin respuestas disponibles)';
}

export async function inferirGenero(nombreCompleto, llamadas) {
  const datos = await llamarModelo(llamadas, 'genero', {
    model:       OPENROUTER_MODEL_AUXILIAR,
    reasoning:   RAZONAMIENTO_AUXILIAR,
    messages:    [{ role: 'user', content: `Nombre del candidato: ${nombreCompleto}` }],
    tools:       [GENERO_TOOL],
    tool_choice: { type: 'function', function: { name: 'genero_candidato' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'genero_candidato');
  if (!llamada) return 'ninguno';

  const argumentos = argumentosDeHerramienta(llamada);
  return argumentos?.genero ?? 'ninguno';
}

// El consumidor (power_informe.py) reenvía como respuesta_anterior el JSON aplanado
// que este mismo endpoint le devolvió (simple.NOMBRE, simple.ESTADOCIVIL, etc.), no el
// shape de INFORME_TOOL (nombre, datos_personales.estado_civil, etc.). Hay que reconstruirlo
// para que el modelo reciba el informe anterior en el mismo formato que debe producir.
export function reconstruirAnalisisPrevio(respuestaAnterior) {
  const simple = respuestaAnterior.simple ?? {};

  return {
    nombre:   simple.NOMBRE,
    cliente:  simple.CLIENTE,
    vacante:  simple.VACANTE,
    datos_personales: {
      estado_civil:   simple.ESTADOCIVIL,
      educacion:      simple.EDUCACION,
      domicilio:      simple.DOMICILIO,
      sueldo_deseado: simple.SUELDODESEADO,
      edad:           simple.EDAD,
    },
    trayectoria:   respuestaAnterior.trayectoria ?? [],
    apego_vacante: respuestaAnterior.apego_vacante ?? [],
    competencias:  respuestaAnterior.competencias ?? [],
    comentarios:   simple.COMENTARIOS,
  };
}

// En una corrección, lo que el modelo haya dejado fuera se toma del informe anterior: una sección o un dato personal
// que no viene en su respuesta no se pidió quitar (para quitarlo lo devolvería vacío, no lo omitiría).
export function completarConInformeAnterior(analisis, respuestaAnterior) {
  const previo    = reconstruirAnalisisPrevio(respuestaAnterior);
  const falta     = valor => valor === undefined || valor === null;
  const completo  = { ...analisis, datos_personales: { ...(analisis.datos_personales ?? {}) } };
  const repuestos = [];

  for (const [seccion, valor] of Object.entries(previo)) {
    if (seccion === 'datos_personales') continue;
    if (falta(completo[seccion]) && !falta(valor)) { completo[seccion] = valor; repuestos.push(seccion); }
  }
  for (const [dato, valor] of Object.entries(previo.datos_personales)) {
    if (falta(completo.datos_personales[dato]) && !falta(valor)) { completo.datos_personales[dato] = valor; repuestos.push(`datos_personales.${dato}`); }
  }

  if (repuestos.length) avisar({ etapa: 'correccion_incompleta', estado: 'completada', repuestos });
  return completo;
}

export async function obtenerAnalisisEstructurado(bloqueCrudo, nombreCandidato, vacante, comentarios, respuestaAnterior, urlCurriculum, opciones = {}) {
  const {
    prompt     = PROMPT_ANALISIS_ESTRUCTURADO,
    tool       = INFORME_TOOL,
    nombreTool = 'informe_estructurado',
    reasoning  = { effort: 'medium' },
    llamadas,
  } = opciones;

  // La fecha de hoy le permite poner el año a periodos que el candidato dio a medias ("desde marzo", "hace 7 meses").
  const hoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', year: 'numeric' });
  let mensajeUsuario = `Fecha de hoy: ${hoy}\nCandidato: ${nombreCandidato}\nVacante: ${vacante}\n\n${bloqueCrudo}`;

  if (comentarios) {
    mensajeUsuario += `\n\n### COMENTARIOS_DE_CORRECCION_DEL_RECLUTADOR\nEste informe ya fue generado previamente y el reclutador solicitó una corrección. A continuación tienes el informe anterior (JSON) y los comentarios del reclutador sobre él. Tu respuesta es ESE MISMO informe con la corrección aplicada, no un informe nuevo:\n- Parte del informe anterior y copia cada campo tal cual está, palabra por palabra, salvo los que los comentarios piden cambiar.\n- Cambia ÚNICAMENTE lo que los comentarios indican, exactamente como se indica. No uses las respuestas del candidato para volver a redactar, completar ni "mejorar" ningún otro campo (nombre, cliente, vacante, domicilio, etc.), aunque te parezca que quedaría mejor.\n- En los textos largos (como "comentarios") no agregues, quites ni reformules frases. Solo toca la frase que el reclutador pide cambiar, o la que quedaría contradiciendo un dato corregido (por ejemplo, dice "soltero" y el reclutador corrigió a casado). Un dato corregido no se agrega al texto si antes no se mencionaba.\n- Si piden quitar un elemento de una lista, elimínalo y deja los demás idénticos y en el mismo orden. Si piden cambiar o reemplazar un elemento, el nuevo ocupa el mismo lugar y trata de lo que el reclutador pidió, con un hecho concreto tomado de las respuestas del candidato (nunca una frase genérica como "tiene experiencia en...").\n- Un dato corregido se corrige en TODOS los campos donde aparezca el valor anterior (por ejemplo, si cambia el nombre de una empresa, cámbialo también en "apego_vacante" y en "comentarios").\n- Si piden borrar una frase o un tema de "comentarios" (por ejemplo "su área de oportunidad"), borra todo lo que trate de eso, aunque el informe lo nombre con otras palabras ("área de desarrollo", "área de mejora", "aunque aún no...") y aunque comparta oración con otra idea; lo que el candidato no dijo o no detalló ("no describió...", "no señaló...") forma parte de su área de oportunidad y se borra con ella.\n- Escribe los datos que dicte el reclutador tal como los dictó y completos: no los acortes ni los resumas aunque las reglas generales pidan brevedad (si dicta el puesto "residente de obra civil y acabados", el puesto es "Residente de Obra Civil y Acabados"). Corrige solo ortografía, mayúsculas y formato (por ejemplo, estado civil e hijos: "Soltero, sin hijos", "Unión libre, 2 hijos"; sin paréntesis).\n- Los comentarios pueden traer varias rondas ("Ronda 2", "Ronda 3"...). Las rondas anteriores ya están aplicadas en el informe anterior: aplica la última y no deshagas nada de las anteriores.\n- "nombre", "cliente" y "vacante" se copian idénticos del informe anterior, salvo que los comentarios los mencionen expresamente.\n- Tu respuesta debe traer TODAS las secciones del informe anterior (ninguna se omite aunque no cambie).`;

    if (respuestaAnterior && typeof respuestaAnterior === 'object') {
      const informeAnteriorTexto = JSON.stringify(reconstruirAnalisisPrevio(respuestaAnterior));
      mensajeUsuario += `\n\nInforme anterior:\n${informeAnteriorTexto}`;
    } else if (respuestaAnterior) {
      mensajeUsuario += `\n\nInforme anterior:\n${respuestaAnterior}`;
    }

    mensajeUsuario += `\n\nComentarios del reclutador:\n${comentarios}`;
  }

  async function llamarAnalisis(conCurriculum) {
    for (let intento = 1; ; intento++) {
      try {
        return await pedirAnalisis(conCurriculum);
      } catch (error) {
        if (!error.sinHerramienta || intento >= INTENTOS_ANALISIS) throw error;
      }
    }
  }

  async function pedirAnalisis(conCurriculum) {
    const adjuntoCurriculum = conCurriculum && urlCurriculum?.trim()
      ? [{ type: 'file', file: { filename: 'curriculum.pdf', file_data: urlCurriculum } }]
      : [];

    const datos = await llamarModelo(llamadas, comentarios ? 'correccion' : 'analisis', {
      model:      comentarios ? OPENROUTER_MODEL_CORRECCION : OPENROUTER_MODEL,
      ...(adjuntoCurriculum.length > 0 && { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] }),
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensajeUsuario },
            ...adjuntoCurriculum,
          ],
        },
      ],
      tools:       [tool],
      tool_choice: 'auto',
      reasoning:   comentarios ? RAZONAMIENTO_CORRECCION : reasoning,
      max_tokens:  100000,
    }, { con_cv: adjuntoCurriculum.length > 0 });

    const opcion = datos?.choices?.[0];
    const llamada = opcion?.message?.tool_calls?.find(c => c.function?.name === nombreTool);

    // Del resultado solo se anota su forma: el informe trae los datos del candidato y no va a la consola.
    avisar({
      etapa: 'analisis_estructurado', modelo: datos?.model, motivo: opcion?.finish_reason,
      tokens_entrada: datos?.usage?.prompt_tokens ?? null, tokens_salida: datos?.usage?.completion_tokens ?? null,
      con_curriculum: conCurriculum, tiene_tool_call: !!llamada,
    });

    if (!llamada) {
      throw Object.assign(new Error('OpenRouter no devolvió una respuesta estructurada válida'), { sinHerramienta: true });
    }

    const argumentos = llamada.function.arguments;
    const analisis = typeof argumentos === 'string' ? JSON.parse(argumentos) : argumentos;

    return analisis;
  }

  try {
    return await llamarAnalisis(true);
  } catch (error) {
    if (!urlCurriculum?.trim()) throw error;
    // Si falla con el CV adjunto (ej. PDF corrupto o rate limit del parser), se reintenta
    // solo con las respuestas del candidato en vez de tumbar todo el informe.
    avisar({ etapa: 'analisis_con_cv', estado: 'error', mensaje: error.message });
    return await llamarAnalisis(false);
  }
}
