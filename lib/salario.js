const SEMANAS_POR_MES = parseFloat(process.env.SEMANAS_POR_MES);

const redondear = v => Math.round(v * 100) / 100;

export function extraerSalarioDeDescripcion(descripcion) {
  const regexRango  = /Sueldo:\s*(?:A partir de|Hasta)?\s*\$([0-9,]+(?:\.\d+)?)\s*-\s*\$([0-9,]+(?:\.\d+)?)\s*(al mes|a la semana)/i;
  const regexSimple = /Sueldo:\s*(?:A partir de|Hasta)?\s*\$([0-9,]+(?:\.\d+)?)\s*(al mes|a la semana)/i;

  const matchRango  = descripcion?.match(regexRango);
  const matchSimple = descripcion?.match(regexSimple);

  if (matchRango) {
    const valor_min  = parseFloat(matchRango[1].replace(/,/g, ""));
    const valor_max  = parseFloat(matchRango[2].replace(/,/g, ""));
    const promedio   = (valor_min + valor_max) / 2;
    const frecuencia = matchRango[3].toLowerCase();

    return {
      valor_mensual:       redondear(frecuencia === "a la semana" ? promedio * SEMANAS_POR_MES : promedio),
      frecuencia_original: frecuencia === "a la semana" ? "semanal" : "mensual",
      valor_original:      `${valor_min} - ${valor_max}`,
      estructura:          "rango"
    };
  }

  if (matchSimple) {
    const valor      = parseFloat(matchSimple[1].replace(/,/g, ""));
    const frecuencia = matchSimple[2].toLowerCase();

    return {
      valor_mensual:       redondear(frecuencia === "a la semana" ? valor * SEMANAS_POR_MES : valor),
      frecuencia_original: frecuencia === "a la semana" ? "semanal" : "mensual",
      valor_original:      valor,
      estructura:          "fijo"
    };
  }

  return null;
}
