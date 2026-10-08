// Utilidades para los teléfonos de los candidatos (México).

export function limpiarTelefono(telefono) {
  if (!telefono || typeof telefono !== 'string') return null;
  return telefono.replace(/\s/g, '');
}

export function normalizarTelefonoMx(telefono) {
  if (!telefono || typeof telefono !== 'string') return null;
  const digitos = telefono.replace(/\D/g, '');
  if (digitos.startsWith('521')) return digitos;
  if (digitos.startsWith('52'))  return `521${digitos.slice(2)}`;
  return `521${digitos}`;
}

export function pareceNumeroTelefono(nombre) {
  if (!nombre || typeof nombre !== 'string') return false;

  const limpio  = nombre.replace(/[\s\-\(\)\+\.]/g, '');
  const digitos = (limpio.match(/\d/g) || []).length;
  const proporcionDigitos = digitos / limpio.length;

  const patronesTelefono = [
    /^\+?\d{10,}$/,
    /^\d[\d\s\-\(\)\.]{8,}$/,
  ];

  if (proporcionDigitos > 0.7 && digitos >= 7) return true;
  return patronesTelefono.some(p => p.test(nombre));
}
