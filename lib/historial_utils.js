const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function formatearFechaEspanol(fecha) {
  if (!fecha) return '';
  const d = new Date(`${fecha}T00:00:00`);
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

function decimalAHora12(decimal) {
  const horas24  = Math.floor(decimal);
  const minutos  = Math.round((decimal - horas24) * 100);
  const periodo  = horas24 >= 12 ? 'PM' : 'AM';
  const horas12  = horas24 % 12 || 12;
  return `${horas12}:${String(minutos).padStart(2, '0')} ${periodo}`;
}

function construirCitado(fecha, hora) {
  if (!fecha || !hora) return '';
  return `${formatearFechaEspanol(fecha)} a las ${decimalAHora12(hora)}`;
}

function esCampoValido(valor) {
  if (valor === null || valor === undefined || valor === '') return false;
  if (Array.isArray(valor)) return valor.length > 0 && !!valor[0] && valor[0] !== '';
  return true;
}

function obtenerCampoPersonalizado(candidato, nombre) {
  return candidato.custom_fields?.find(f => f.api_name === nombre)?.value;
}

function fechaMexico(fecha) {
  return fecha.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).split(' ')[0];
}

function timestampMexico(fechaIso) {
  const mexicoStr = new Date(fechaIso).toLocaleString('sv-SE', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return `${mexicoStr}-06:00`;
}

function timestampCita(fecha, hora) {
  const horas   = Math.floor(hora);
  const minutos = Math.round((hora - horas) * 100);
  return `${fecha} ${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:00-06:00`;
}

export {
  formatearFechaEspanol,
  decimalAHora12,
  construirCitado,
  esCampoValido,
  obtenerCampoPersonalizado,
  fechaMexico,
  timestampMexico,
  timestampCita,
};
