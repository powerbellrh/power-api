import { normalizar }                from './utils.js';
import { extraerSalarioDeDescripcion } from './salario.js';
import { normalizarPrestaciones }    from './prestaciones.js';

const SALARIO_MINIMO_MENSUAL = parseFloat(process.env.SALARIO_MINIMO_MENSUAL);

export function extraerCampos(vacanteApify) {
  const descripcion = vacanteApify.descriptionText ?? null;
  const salario     = extraerSalarioDeDescripcion(descripcion);

  return {
    titulo_vacante:        vacanteApify.title ?? null,
    nombre_empresa:        vacanteApify.companyName ?? "Empresa no especificada",
    salario_mensual:       salario?.valor_mensual ?? null,
    frecuencia_original:   salario?.frecuencia_original ?? null,
    valor_original:        salario?.valor_original ?? null,
    estructura_salario:    salario?.estructura ?? null,
    salario_valido:        salario !== null && salario.valor_mensual >= SALARIO_MINIMO_MENSUAL,
    prestaciones_original: vacanteApify.benefits ?? [],
    prestaciones:          normalizarPrestaciones(vacanteApify.benefits),
    descripcion_original:  descripcion,
    ubicacion_vacante:     vacanteApify.location?.formattedAddressShort ?? null,
    fecha_publicacion:     vacanteApify.datePublished ?? null,
  };
}

export function esMediotiempo(vacante) {
  const palabras_clave = ["medio tiempo", "part time"];
  const texto          = `${vacante.titulo_vacante} ${vacante.descripcion_original}`.toLowerCase();
  if (!palabras_clave.some(p => texto.includes(p))) return false;
  // Si también declara "tiempo completo" y el salario es válido, se trata como tiempo completo
  if (texto.includes("tiempo completo") && vacante.salario_valido) return false;
  return true;
}

export function deduplicar(vacantes) {
  const mapa = {};

  for (const v of vacantes) {
    const llave = normalizar(v.nombre_empresa) + "_" + normalizar(v.titulo_vacante);

    if (!mapa[llave] || new Date(v.fecha_publicacion) > new Date(mapa[llave].fecha_publicacion)) {
      mapa[llave] = v;
    }
  }

  return Object.values(mapa);
}
