import { normalizarTexto } from './chatbot/utilidades.js';

// Catálogo de ciudades de México para validar la ubicación de una vacante antes de crearla en TeamTailor: corrige
// errores de dedo ("Cuernacanaca"), completa el estado ("Guadalajara" → "Guadalajara, Jalisco") y pregunta cuando el
// nombre puede ser de varias partes ("San Pedro"). No es exhaustivo: un lugar que no está pasa si ella dice el estado.

const ESTADOS = {
  'Aguascalientes': ['ags'], 'Baja California': ['bc'], 'Baja California Sur': ['bcs'], 'Campeche': ['camp'], 'Chiapas': ['chis'],
  'Chihuahua': ['chih'], 'Ciudad de México': ['cdmx', 'df', 'distrito federal', 'ciudad de mexico'], 'Coahuila': ['coah', 'coahuila de zaragoza'],
  'Colima': ['col'], 'Durango': ['dgo'], 'Estado de México': ['edomex', 'edo mex', 'edo de mexico', 'mex', 'estado de mexico'],
  'Guanajuato': ['gto'], 'Guerrero': ['gro'], 'Hidalgo': ['hgo'], 'Jalisco': ['jal'], 'Michoacán': ['mich', 'michoacan de ocampo'],
  'Morelos': ['mor'], 'Nayarit': ['nay'], 'Nuevo León': ['nl', 'n l'], 'Oaxaca': ['oax'], 'Puebla': ['pue'], 'Querétaro': ['qro', 'queretaro de arteaga'],
  'Quintana Roo': ['qroo', 'q roo'], 'San Luis Potosí': ['slp', 's l p'], 'Sinaloa': ['sin'], 'Sonora': ['son'], 'Tabasco': ['tab'],
  'Tamaulipas': ['tamps', 'tamaulipas'], 'Tlaxcala': ['tlax'], 'Veracruz': ['ver', 'veracruz de ignacio de la llave'], 'Yucatán': ['yuc'], 'Zacatecas': ['zac'],
};

// "Ciudad|Estado|alias separados por /" (los alias que se repiten en varias filas son los ambiguos).
const CIUDADES = `
Aguascalientes|Aguascalientes|ags
Tijuana|Baja California
Mexicali|Baja California
Ensenada|Baja California
Tecate|Baja California
Rosarito|Baja California|playas de rosarito
La Paz|Baja California Sur
Los Cabos|Baja California Sur|cabo san lucas/san jose del cabo
Campeche|Campeche
Ciudad del Carmen|Campeche|carmen
Tuxtla Gutiérrez|Chiapas|tuxtla
Tapachula|Chiapas
San Cristóbal de las Casas|Chiapas|san cristobal
Chihuahua|Chihuahua
Ciudad Juárez|Chihuahua|juarez/cd juarez
Cuauhtémoc|Chihuahua
Delicias|Chihuahua
Parral|Chihuahua|hidalgo del parral
Ciudad de México|Ciudad de México|cdmx/mexico/df/mexico df
Saltillo|Coahuila
Torreón|Coahuila|torreon
Monclova|Coahuila
Piedras Negras|Coahuila
Ramos Arizpe|Coahuila
Colima|Colima
Manzanillo|Colima
Tecomán|Colima
Durango|Durango
Gómez Palacio|Durango|gomez palacio
Lerdo|Durango
Toluca|Estado de México
Naucalpan|Estado de México|naucalpan de juarez
Ecatepec|Estado de México|ecatepec de morelos
Tlalnepantla|Estado de México|tlalnepantla de baz
Nezahualcóyotl|Estado de México|neza/nezahualcoyotl
Cuautitlán Izcalli|Estado de México|cuautitlan izcalli
Cuautitlán|Estado de México|cuautitlan
Texcoco|Estado de México
Chalco|Estado de México
Huixquilucan|Estado de México
Atizapán de Zaragoza|Estado de México|atizapan
Tultitlán|Estado de México|tultitlan
Tecámac|Estado de México|tecamac
Metepec|Estado de México
Chimalhuacán|Estado de México|chimalhuacan
Ixtapaluca|Estado de México
Celaya|Guanajuato
León|Guanajuato|leon
Irapuato|Guanajuato
Salamanca|Guanajuato
Guanajuato|Guanajuato
San Miguel de Allende|Guanajuato|san miguel
Silao|Guanajuato
Acapulco|Guerrero
Chilpancingo|Guerrero
Taxco|Guerrero
Zihuatanejo|Guerrero
Pachuca|Hidalgo
Tulancingo|Hidalgo
Tula de Allende|Hidalgo|tula
Guadalajara|Jalisco|gdl
Zapopan|Jalisco
Tlaquepaque|Jalisco|san pedro tlaquepaque/san pedro
Tonalá|Jalisco|tonala
Tlajomulco de Zúñiga|Jalisco|tlajomulco
El Salto|Jalisco
Puerto Vallarta|Jalisco|vallarta
Lagos de Moreno|Jalisco
Tepatitlán|Jalisco|tepatitlan
Ocotlán|Jalisco|ocotlan
Morelia|Michoacán
Uruapan|Michoacán
Zamora|Michoacán
Lázaro Cárdenas|Michoacán|lazaro cardenas
Cuernavaca|Morelos
Cuautla|Morelos
Jiutepec|Morelos
Tepic|Nayarit
Bahía de Banderas|Nayarit|bucerias/nuevo vallarta
Monterrey|Nuevo León|mty
San Pedro Garza García|Nuevo León|san pedro garza garcia/san pedro/garza garcia
San Nicolás de los Garza|Nuevo León|san nicolas/san nicolas de los garza
Guadalupe|Nuevo León
Apodaca|Nuevo León
General Escobedo|Nuevo León|escobedo
Santa Catarina|Nuevo León
Juárez|Nuevo León|juarez
García|Nuevo León|garcia
Cadereyta|Nuevo León|cadereyta jimenez
Oaxaca de Juárez|Oaxaca|oaxaca
Salina Cruz|Oaxaca
Juchitán|Oaxaca|juchitan
Puebla|Puebla
Tehuacán|Puebla|tehuacan
San Martín Texmelucan|Puebla|texmelucan
Atlixco|Puebla
San Pedro Cholula|Puebla|cholula/san pedro
San Andrés Cholula|Puebla
Querétaro|Querétaro|qro
San Juan del Río|Querétaro|san juan del rio
Corregidora|Querétaro
El Marqués|Querétaro|el marques
Cancún|Quintana Roo|cancun
Playa del Carmen|Quintana Roo
Chetumal|Quintana Roo
Tulum|Quintana Roo
Cozumel|Quintana Roo
San Luis Potosí|San Luis Potosí|slp/san luis potosi
Soledad de Graciano Sánchez|San Luis Potosí|soledad
Ciudad Valles|San Luis Potosí
Culiacán|Sinaloa|culiacan
Mazatlán|Sinaloa|mazatlan
Los Mochis|Sinaloa
Guasave|Sinaloa
Hermosillo|Sonora
Ciudad Obregón|Sonora|obregon/cd obregon
Nogales|Sonora
San Luis Río Colorado|Sonora|san luis rio colorado
Guaymas|Sonora
Villahermosa|Tabasco
Cárdenas|Tabasco|cardenas
Reynosa|Tamaulipas
Matamoros|Tamaulipas
Nuevo Laredo|Tamaulipas
Tampico|Tamaulipas
Ciudad Madero|Tamaulipas|madero
Altamira|Tamaulipas
Ciudad Victoria|Tamaulipas|victoria
Tlaxcala|Tlaxcala
Apizaco|Tlaxcala
Veracruz|Veracruz
Xalapa|Veracruz|jalapa
Coatzacoalcos|Veracruz
Córdoba|Veracruz|cordoba
Orizaba|Veracruz
Poza Rica|Veracruz
Minatitlán|Veracruz|minatitlan
Boca del Río|Veracruz|boca del rio
Mérida|Yucatán|merida
Valladolid|Yucatán
Progreso|Yucatán
Zacatecas|Zacatecas
Fresnillo|Zacatecas
Guadalupe|Zacatecas
`.trim().split('\n').map(linea => {
  const [ciudad, estado, alias = ''] = linea.split('|');
  return { ciudad, estado, claves: [ciudad, ...alias.split('/').filter(Boolean)].map(normalizarTexto).map(clave => clave.replace(/\./g, '')) };
});

const nombreCompleto = ({ ciudad, estado }) => (ciudad === estado ? ciudad : `${ciudad}, ${estado}`);

const claveEstado = texto => normalizarTexto(texto).replace(/\./g, '').replace(/\s+/g, ' ').trim();
const ESTADO_POR_CLAVE = new Map(Object.entries(ESTADOS).flatMap(([estado, alias]) => [estado, ...alias].map(nombre => [claveEstado(nombre), estado])));

function distancia(a, b) {
  const previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = previa[0];
    previa[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = previa[j];
      previa[j] = Math.min(previa[j] + 1, previa[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return previa[b.length];
}

const aTitulo = texto => texto.trim().replace(/\s+/g, ' ').replace(/(^|\s)(\p{L})/gu, (_, espacio, letra) => `${espacio}${letra.toUpperCase()}`);

function buscarCiudad(texto, estado) {
  const clave = claveEstado(texto);
  if (!clave) return { exactas: [], parecidas: [] };

  const delEstado = entrada => !estado || entrada.estado === estado;
  const exactas = CIUDADES.filter(entrada => delEstado(entrada) && entrada.claves.includes(clave));
  if (exactas.length) return { exactas, parecidas: [] };

  const margen = clave.length >= 8 ? 3 : clave.length >= 5 ? 2 : 1;
  const candidatas = CIUDADES.filter(delEstado).map(entrada => ({ entrada, d: Math.min(...entrada.claves.map(c => distancia(clave, c))) })).filter(({ d }) => d <= margen);
  const mejor = Math.min(...candidatas.map(({ d }) => d));
  return { exactas: [], parecidas: candidatas.filter(({ d }) => d === mejor).map(({ entrada }) => entrada) };
}

// "Mérida Yucatán" (sin coma) → "Mérida, Yucatán".
function separarEstado(texto) {
  if (texto.includes(',')) return texto;
  const clave = claveEstado(texto);
  const estado = [...ESTADO_POR_CLAVE.keys()].sort((a, b) => b.length - a.length).find(nombre => nombre.length > 3 && clave.endsWith(` ${nombre}`));
  if (!estado) return texto;
  const corte = texto.length - estado.length;
  return `${texto.slice(0, corte).trim()}, ${texto.slice(corte).trim()}`;
}

// → { estado: 'ok', nombre, corregida } | { estado: 'ambigua', opciones } | { estado: 'desconocida' }
export function resolverUbicacion(texto) {
  const partes = separarEstado(String(texto ?? '')).split(',').map(parte => parte.trim()).filter(Boolean);
  if (!partes.length) return { estado: 'desconocida' };

  // Un estado en cualquier parte del texto acota la búsqueda.
  const estadoDado = partes.slice(1).map(parte => ESTADO_POR_CLAVE.get(claveEstado(parte))).find(Boolean)
    ?? (partes.length === 1 ? undefined : ESTADO_POR_CLAVE.get(claveEstado(partes.at(-1))));
  const candidatos = partes.filter(parte => !ESTADO_POR_CLAVE.has(claveEstado(parte)) || partes.length === 1);

  for (const candidato of candidatos) {
    const { exactas, parecidas } = buscarCiudad(candidato, estadoDado);
    const coincidencias = exactas.length ? exactas : parecidas;
    const unicas = [...new Map(coincidencias.map(entrada => [nombreCompleto(entrada), entrada])).values()];

    if (unicas.length === 1) {
      const nombre = nombreCompleto(unicas[0]);
      return { estado: 'ok', nombre, corregida: normalizarTexto(unicas[0].ciudad) !== normalizarTexto(candidato) };
    }
    if (unicas.length > 1) return { estado: 'ambigua', opciones: unicas.map(nombreCompleto) };
  }

  // Un lugar que no está en el catálogo pasa si ella dijo el estado.
  if (estadoDado && candidatos.length) return { estado: 'ok', nombre: `${aTitulo(candidatos[0])}, ${estadoDado}`, corregida: false };
  return { estado: 'desconocida' };
}

export function preguntaDeUbicacion(resultado, texto) {
  if (resultado.estado === 'ambigua') return `¿A cuál te refieres con "${texto}"? ${resultado.opciones.join(' o ')}.`;
  return `No ubico "${texto}". ¿Me dices la ciudad y el estado?`;
}
