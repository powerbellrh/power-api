import { normalizar } from './utils.js';

// Diccionario de prestaciones: nombre canónico → lista de sinónimos
// - La comparación normaliza ambos lados (minúsculas, sin acentos, sin espacios),
//   así que los sinónimos pueden escribirse con tildes y espacios normales.
// - Lo que no aparezca aquí se descarta automáticamente del output.
// - Para agregar una prestación nueva: agrega un bloque al final.
// - Para agregar un sinónimo: agrega un string al array correspondiente.

const DICCIONARIO = {

  "Vales de despensa": [
    "vales de despensa",
    "vale de despensa",
    "vales despensa",
    "vale despensa",
    "tarjeta de despensa",
    "vales de súper",
    "vales de supermercado",
    "vales de alimentos",
    "despensa",
  ],

  "Caja de ahorro": [
    "caja de ahorro",
    "fondo de ahorro",
  ],

  "Seguro de gastos médicos mayores": [
    "seguro de gastos médicos mayores",
    "gastos médicos mayores",
    "seguro gmm",
    "gmm",
    "seguro médico mayor",
    "seguro médico privado",
    "health insurance",
  ],

  "Seguro dental": [
    "seguro dental",
    "dental insurance",
  ],

  "Seguro de vida": [
    "seguro de vida",
    "life insurance",
  ],

  "Estacionamiento": [
    "estacionamiento para empleados",
    "estacionamiento de la empresa",
    "estacionamiento gratuito",
    "estacionamiento",
    "free parking",
  ],

  "Comedor": [
    "servicio de comedor",
    "comedor de empresa",
    "comedor",
    "cafetería",
    "comida gratis",
  ],

  "Uniformes": [
    "uniformes gratuitos",
    "uniformes",
    "uniforme",
    "ropa de trabajo",
  ],

  "Auto de empresa": [
    "auto de empresa",
    "automóvil de empresa",
    "vehículo de empresa",
    "company car",
  ],

  "Descuento en tienda": [
    "descuento en tienda",
    "descuento en productos",
    "descuento para empleados",
    "store discount",
    "employee discount",
  ],

  "Bonos de desempeño": [
    "bono de desempeño",
    "bono por desempeño",
    "bonos de desempeño",
    "bono de productividad",
    "bonos de productividad",
    "bono trimestral",
    "bono semestral",
    "bono anual",
    "bono mensual",
  ],

  "Comisiones": [
    "comisiones",
    "comisión",
    "esquema de comisiones",
    "pago por comisión",
  ],

  "Capacitación": [
    "capacitación",
    "capacitaciones",
    "entrenamiento",
    "cursos de capacitación",
  ],

  "Plan de carrera": [
    "plan de carrera",
    "crecimiento profesional",
    "oportunidades de crecimiento",
    "desarrollo de carrera",
    "plan de desarrollo",
  ],

  "Home office": [
    "home office",
    "trabajo remoto",
    "trabajo desde casa",
    "teletrabajo",
    "modalidad híbrida",
    "esquema híbrido",
  ],

  "Horario flexible": [
    "horario flexible",
    "horarios flexibles",
    "flexibilidad de horario",
  ],

  "Celular de empresa": [
    "celular de empresa",
    "teléfono de empresa",
    "celular corporativo",
  ],

  "Licencia de maternidad/paternidad superior a la ley": [
    "días de maternidad superiores a los de la ley",
    "días de paternidad superiores a los de la ley",
    "licencia de maternidad superior",
    "licencia de paternidad superior",
    "parental leave",
  ],

  "Apoyo de transporte": [
    "apoyo de transporte",
    "subsidio de transporte",
    "ayuda de transporte",
    "ayuda o servicio de transporte",
    "servicio de transporte",
    "ruta de transporte",
    "camion de la empresa",
    "commuter assistance",
    "gastos de desplazamiento",
  ],

  "Descuento en gimnasio": [
    "descuento en gimnasio",
    "descuento de gimnasio",
    "gym membership",
    "membresia de gimnasio",
    "acceso a gimnasio",
  ],

  "Viáticos": [
    "viáticos",
    "gastos de viaje",
    "gastos de representación",
  ],

};

export function normalizarPrestaciones(prestacionesOriginal) {
  if (!Array.isArray(prestacionesOriginal) || prestacionesOriginal.length === 0) return [];

  const resultado = new Set();

  for (const prestacion of prestacionesOriginal) {
    const normPrestacion = normalizar(prestacion);

    for (const [canonico, sinonimos] of Object.entries(DICCIONARIO)) {
      const encontrado = sinonimos.some(s => normPrestacion.includes(normalizar(s)));
      if (encontrado) {
        resultado.add(canonico);
        break;
      }
    }
  }

  return [...resultado];
}
