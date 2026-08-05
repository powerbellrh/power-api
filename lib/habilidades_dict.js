// Diccionario de palabras clave por habilidad para el matching por regex en api/habilidades.js

export const HABILIDADES_REGEX = {
  'Experiencia en Producción': /produccion|producci[oó]n|manufactura|ensambl|l[ií]nea de producci[oó]n|operador de m[aá]quina|maquinado|inyecci[oó]n de pl[aá]stico|soldadura|empaque|manufactur/i,
  'Experiencia en Seguridad y Vigilancia': /seguridad privada|vigilan(te|cia)|guardia de seguridad|resguardo|monitoreo de c[aá]maras|caseta de vigilancia|escolta/i,
  'Experiencia en Almacén': /almac[eé]n|montacargas|inventario|surtido de pedidos|log[ií]stica|control de inventario|recepci[oó]n de mercanc[ií]a|picking|embarque/i,
};
