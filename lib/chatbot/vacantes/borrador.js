import { createHash } from 'crypto';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { normalizarTexto } from '../utilidades.js';

// El borrador de la vacante vive en la columna `preguntas` de la fila de la reclutadora como una
// lista de {id, respuesta} (no hay tabla propia). Aquí están las funciones puras que lo leen,
// lo escriben y deciden si una confirmación es válida, para poder probarlas sin red.

// Datos que el modelo va acumulando en cada turno.
export const CAMPOS_DEL_MODELO = ['nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'escena_imagen'];

// Lo que la reclutadora revisa en el resumen: si cualquiera cambia, lo que confirmó ya no es lo mismo.
const CAMPOS_DE_LA_HUELLA = ['nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'imagen_ruta'];

// Si un intento de crear la vacante lleva más que esto sin terminar, se considera caído.
export const DURACION_BLOQUEO_CREACION_MS = 2 * 60 * 1000;

export function leerBorrador(preguntas) {
  const items = Array.isArray(preguntas) ? preguntas : [];
  return Object.fromEntries(items.map(item => [item.id, item.respuesta ?? '']));
}

export function guardarBorrador(borrador) {
  return Object.entries(borrador)
    .filter(([, valor]) => valor !== undefined && valor !== null)
    .map(([id, valor]) => ({ id, respuesta: String(valor) }));
}

// El resumen solo se puede mostrar (y confirmar) cuando ya están todos los datos publicables.
export function resumenCompleto(borrador) {
  return Boolean(borrador.nombre_interno && borrador.titulo && borrador.ubicacion && borrador.descripcion && borrador.contexto);
}

export function huellaResumen(borrador) {
  const datos = CAMPOS_DE_LA_HUELLA.map(campo => borrador[campo] ?? '');
  return createHash('sha1').update(JSON.stringify(datos)).digest('hex');
}

// Una vacante se publica solo si: el modelo vio una confirmación, el resumen estaba completo y los
// datos actuales son exactamente los del último resumen que se le mostró a la reclutadora.
export function confirmacionValida({ confirmadoPorModelo, borrador, huellaMostrada }) {
  if (!confirmadoPorModelo || !resumenCompleto(borrador) || !huellaMostrada) return false;
  return huellaMostrada === huellaResumen(borrador);
}

export function bloqueoVigente(borrador, ahora = Date.now()) {
  if (!borrador.creando_desde) return false;
  const desde = Date.parse(borrador.creando_desde);
  return Number.isFinite(desde) && ahora - desde < DURACION_BLOQUEO_CREACION_MS;
}

// El anuncio que se le muestra a la reclutadora se deriva de la descripción que se publica, para
// que nunca sean dos textos distintos.
export function anuncioParaWhatsApp(descripcionHtml) {
  return limpiarHtmlParaWhatsApp(descripcionHtml);
}

export function pideConfirmacion(mensaje) {
  return normalizarTexto(mensaje).includes('confirm');
}

export function resumenDatosInternos(borrador) {
  return `Nombre interno: ${borrador.nombre_interno}\nTítulo: ${borrador.titulo}\nContexto: ${borrador.contexto}`;
}
