import { normalizar } from './utilidades.js';

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
    "caja de ahorros",
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
    "comedor subsidiado",
    "comedor con descuento",
    "comedor",
    "cafetería",
    "comida gratis",
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
    "descuento de empleados",
    "store discount",
    "employee discount",
  ],

  "Bonos de productividad": [
    "bono de productividad",
    "bonos de productividad",
    "bono de desempeño",
    "bono por desempeño",
    "bonos de desempeño",
    "bono trimestral",
    "bono bimestral",
    "bono semestral",
    "bono anual",
    "bono mensual",
    "bono de rendimiento",
    "bono por resultados",
  ],

  "Bonos de asistencia y permanencia": [
    "bono de asistencia",
    "bono de puntualidad",
    "bono de permanencia",
    "bono de antigüedad",
    "bono de asistencia perfecta",
    "premio de asistencia",
    "premio de puntualidad",
  ],

  "Comisiones": [
    "comisiones",
    "comisión",
    "esquema de comisiones",
    "pago por comisión",
    "pago a comisión",
    "comisión sobre ventas",
  ],

  "Capacitación": [
    "capacitación",
    "capacitaciones",
    "capacitación continua",
    "entrenamiento",
    "cursos de capacitación",
    "cursos y capacitación",
  ],

  "Plan de carrera": [
    "plan de carrera",
    "crecimiento profesional",
    "oportunidades de crecimiento",
    "desarrollo de carrera",
    "plan de desarrollo",
    "desarrollo profesional",
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
    "transporte de personal",
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

export function normalizarPrestaciones(prestacionesOriginal, descripcion = '') {
  const resultado = new Set();

  // Escanear el array de benefits de Apify
  if (Array.isArray(prestacionesOriginal)) {
    for (const prestacion of prestacionesOriginal) {
      const normPrestacion = normalizar(prestacion);
      for (const [canonico, sinonimos] of Object.entries(DICCIONARIO)) {
        if (sinonimos.some(s => normPrestacion.includes(normalizar(s)))) {
          resultado.add(canonico);
          break;
        }
      }
    }
  }

  // Escanear la descripción para capturar lo que Apify no extrajo
  if (descripcion) {
    const normDesc = normalizar(descripcion);
    for (const [canonico, sinonimos] of Object.entries(DICCIONARIO)) {
      if (!resultado.has(canonico)) {
        if (sinonimos.some(s => normDesc.includes(normalizar(s)))) {
          resultado.add(canonico);
        }
      }
    }
  }

  return [...resultado];
}
