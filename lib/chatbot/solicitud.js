import { MENSAJE_IRRESPONSIVO } from './constantes.js';
import { normalizarTexto } from './utilidades.js';

// Valida y normaliza lo que manda ManyChat a /conversaciones:
//   { telefono, contacto, respuesta, flujo }
// Cuando el contacto no contesta a tiempo, ManyChat manda el texto fijo "irresponsivo" en `respuesta`.
// (Si un candidato escribiera exactamente esa palabra se tomaría igual como aviso de inactividad.)

// El id de contacto de ManyChat llega como entero (o como texto de dígitos). Se devuelve como número
// solo si es seguro: más allá de 2^53 JSON ya habría perdido dígitos y se mandaría a otro contacto.
export function leerIdContacto(valor) {
  const numero = typeof valor === 'string' && /^\d+$/.test(valor.trim()) ? Number(valor.trim()) : valor;
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

export function leerSolicitud(cuerpo) {
  const telefono   = cuerpo?.telefono != null ? String(cuerpo.telefono).trim() : '';
  const idContacto = leerIdContacto(cuerpo?.contacto);
  const flujo      = typeof cuerpo?.flujo === 'string' ? cuerpo.flujo.trim() : '';
  const respuesta  = cuerpo?.respuesta != null ? String(cuerpo.respuesta) : '';

  const esIrresponsivo = normalizarTexto(respuesta) === 'irresponsivo';

  if (!telefono)                              return { ok: false, error: 'missing telefono' };
  if (idContacto === null)                    return { ok: false, error: 'invalid contacto' };
  if (!respuesta.trim())                      return { ok: false, error: 'missing respuesta' };

  return {
    ok: true,
    solicitud: { telefono, idContacto, flujo, esIrresponsivo, mensaje: esIrresponsivo ? MENSAJE_IRRESPONSIVO : respuesta },
  };
}
