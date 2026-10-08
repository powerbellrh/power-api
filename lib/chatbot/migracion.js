import { ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE } from './constantes.js';
import { estaCompletada, itemsDeFila } from './estado.js';
import { interpretarBooleano, interpretarEdad, interpretarNumero } from './interpretacion.js';
import { PASO, primerPendiente } from './pasos.js';

// Convierte una fila de `chatbot` (lógica vieja de /mensajes) en la fila equivalente de `conversaciones`, para que
// quien estaba a media postulación la retome donde se quedó con la máquina de pasos. Es una función pura: no lee ni
// escribe en ningún sistema (eso lo hace scripts/migrar_chatbot_a_conversaciones.js).
//
// - Lo que el candidato ya respondió pasa a `temporal.datos`; lo que ya se había mandado a TeamTailor (`enviado`)
//   queda marcado en `temporal.sync` para no mandarlo otra vez.
// - Una postulación que ya estaba completa se queda completa: no se le agregan preguntas que la vacante no tenía
//   entonces ni se le vuelve a pedir la edad.
// - En una postulación en curso la edad que no sea válida se vuelve a preguntar (es obligatoria en /conversaciones).
// - Si la vacante ya no existe (`vacante` null) se conservan solo los datos personales, para reutilizarlos después.

const esExtra = item => item.tipo === 'extra' || /^extra_\d+$/.test(String(item.id));
const esBorradorDeVacante = items => items.some(item => item.id === 'nombre_interno' || item.id === 'titulo');

function valorPorTipo(tipo, texto) {
  if (tipo === 'Booleano') {
    const respuesta = interpretarBooleano(texto);
    return respuesta === 'si' ? 'Sí' : respuesta === 'no' ? 'No' : texto;
  }
  if (tipo === 'Numero') return interpretarNumero(texto) ?? texto;
  return texto;
}

// `vacante` es lo que devuelve obtenerVacante (vacantes_supabase.js), o null si no tiene o ya no existe.
// Devuelve null si la fila no es una conversación de candidato (borrador de creación de vacante).
export function convertirFilaChatbot(fila, vacante, { ahora = new Date().toISOString() } = {}) {
  const items = itemsDeFila(fila);
  if (esBorradorDeVacante(items)) return null;

  const porId      = new Map(items.map(item => [String(item.id), item]));
  const respuesta  = id => String(porId.get(String(id))?.respuesta ?? '').trim() || undefined;
  const enviado    = id => porId.get(String(id))?.enviado === true;
  const hecho      = { estado: 'hecho', en: ahora };
  const completada = estaCompletada(items);

  const datos = {};
  const sync  = {};
  const guardar = (clave, valor, id) => {
    if (valor === undefined) return;
    datos[clave] = valor;
    if (enviado(id)) sync[clave] = hecho;
  };

  const edadCruda = respuesta(ID_PREGUNTA_EDAD);
  guardar('nombre',      respuesta(ID_PREGUNTA_NOMBRE),    ID_PREGUNTA_NOMBRE);
  guardar('edad',        interpretarEdad(edadCruda) ?? (completada ? edadCruda : undefined), ID_PREGUNTA_EDAD);
  guardar('domicilio',   respuesta(ID_PREGUNTA_DOMICILIO), ID_PREGUNTA_DOMICILIO);
  guardar('experiencia', respuesta(ID_PREGUNTA_EMPLEO),    ID_PREGUNTA_EMPLEO);

  const comunes = {
    telefono:              String(fila.telefono),
    manychat:              fila.manychat ?? null,
    intentos:              0,
    recordatorios:         fila.recordatorios ?? 0,
    historial:             fila.conversacion ?? null,
    solicitud_eliminacion: fila.solicitud_eliminacion ?? null,
    creado:                fila.creado,
    actualizado:           fila.actualizado,
  };

  if (!vacante) {
    return { ...comunes, id_vacante: null, paso: PASO.SIN_VACANTE, temporal: { preguntas: [], parcial: {}, datos: { ...datos, respuestas: {}, extras: {} }, sync } };
  }

  const respuestas = {};
  const preguntas  = [];
  for (const pregunta of vacante.preguntas) {
    const texto = respuesta(pregunta.idTT);
    if (texto === undefined && completada) continue;
    preguntas.push({ id: pregunta.id, idTT: pregunta.idTT, tipo: pregunta.tipo, texto: pregunta.texto });
    if (texto === undefined) continue;
    respuestas[String(pregunta.id)] = valorPorTipo(pregunta.tipo, texto);
    if (enviado(pregunta.idTT)) sync[`r:${pregunta.id}`] = hecho;
  }

  const itemsExtra = items.filter(esExtra);
  const extras = {};
  itemsExtra.forEach((item, indice) => {
    const texto = String(item.respuesta ?? '').trim();
    if (!texto) return;
    extras[indice] = texto;
    if (item.enviado === true) sync[`e:${indice}`] = hecho;
  });

  const temporal = { preguntas, parcial: {}, datos: { ...datos, respuestas, extras }, sync };
  // Sin preguntas extra guardadas: si ya había terminado no se generan; si iba en curso se generan al llegar a ese paso.
  if (itemsExtra.length || completada) temporal.extras = itemsExtra.map(item => ({ texto: String(item.texto ?? '').trim() }));

  const baseCompleta = ['nombre', 'edad', 'domicilio', 'experiencia'].every(clave => datos[clave] !== undefined)
    && preguntas.every(pregunta => respuestas[String(pregunta.id)] !== undefined);
  if (baseCompleta) temporal.baseCompleta = true;
  if (completada) Object.assign(sync, { evaluacion: hecho, cierre: hecho }); // la evaluación y el PDF ya se hicieron en /mensajes

  return { ...comunes, id_vacante: vacante.id, paso: primerPendiente(temporal).paso, temporal };
}
