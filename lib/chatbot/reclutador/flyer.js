import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { asegurarFuenteRegistrada } from '../../imagenes/plantillas.js';
import { orChatCompletion } from '../../openrouter.js';
import { hayCriterioDiscriminatorio, horariosSinRespaldo, montosSinRespaldo } from './validaciones.js';

// Los flyers de referencia (assets/flyers) son los que ya usa PowerBell: el modelo los toma como guía de estilo. El logo
// no lo dibuja el modelo: deja un espacio libre arriba a la derecha y aquí se le pone el logo real (ponerLogo).
//
// Flyers cuadrados para publicar una vacante en redes: el modelo de imagen dibuja todo (foto, tarjetas y texto) a partir
// de los datos que dio la reclutadora. Como puede equivocar letras, el texto se le pasa literal y la reclutadora revisa
// el resultado antes de usarlo; las cifras y horarios sí se verifican en código contra lo que ella dijo (revisarFlyer).

const OPENROUTER_MODEL_FLYER = 'google/gemini-nano-banana-2.1'; // genera y también corrige una imagen con comentarios
const MAXIMO_BENEFICIOS      = 7;
const MAXIMO_TEXTO           = 80;

const limpiar = texto => String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, MAXIMO_TEXTO);

// Deja el flyer con solo los campos que se dibujan, recortados.
export function normalizarFlyer(argumentos) {
  return {
    empresa:    limpiar(argumentos.empresa),
    puesto:     limpiar(argumentos.puesto),
    sueldo:     limpiar(argumentos.sueldo),
    beneficios: (Array.isArray(argumentos.beneficios) ? argumentos.beneficios : []).map(limpiar).filter(Boolean).slice(0, MAXIMO_BENEFICIOS),
    horario:    limpiar(argumentos.horario),
    ubicacion:  limpiar(argumentos.ubicacion),
    escena:     String(argumentos.escena ?? '').trim().slice(0, 300),
    estilo:     String(argumentos.estilo ?? '').trim().slice(0, 120),
  };
}

const textoDelFlyer = flyer => [flyer.empresa, flyer.puesto, flyer.sueldo, ...flyer.beneficios, flyer.horario, flyer.ubicacion].join('\n');

// Lo que está mal en el flyer, para que el agente lo corrija: sin puesto, o con sueldo, horarios o criterios que ella no dio.
export function revisarFlyer({ flyer, textoRespaldo }) {
  const problemas = [];
  if (!flyer.puesto) problemas.push('Falta el puesto del flyer.');

  const texto = textoDelFlyer(flyer);
  const montos = montosSinRespaldo(texto, textoRespaldo);
  if (montos.length) problemas.push(`El flyer menciona montos que la reclutadora no dio (${montos.map(m => m.coincidencia.trim()).join(', ')}): quítalos o pregúntale el dato.`);

  const horarios = horariosSinRespaldo(texto, textoRespaldo);
  if (horarios.length) problemas.push(`El flyer menciona horarios que la reclutadora no dio (${horarios.map(h => h.nombre).join(', ')}): quítalos o pregúntale el dato.`);

  if (hayCriterioDiscriminatorio(texto)) problemas.push('El flyer menciona un criterio discriminatorio (edad, sexo, estado civil...): quítalo.');
  return problemas;
}

const rutaAsset = (...partes) => path.join(process.cwd(), 'assets', ...partes);
const REFERENCIAS = [
  rutaAsset('flyers', 'referencia_1.jpg'), rutaAsset('flyers', 'referencia_2.jpg'), rutaAsset('flyers', 'referencia_4.jpg'),
  rutaAsset('flyers', 'referencia_5.jpg'), rutaAsset('flyers', 'referencia_6.jpg'), rutaAsset('flyers', 'referencia_9.jpg'),
];
const LOGO_CLARO = rutaAsset('logos', 'azul.png');   // para fondos claros
const LOGO_OSCURO = rutaAsset('logos', 'blanco.png'); // para fondos oscuros

// Zona de arriba a la derecha que el modelo deja libre para el logo (proporciones del lienzo).
const ZONA_LOGO = { x: 0.70, y: 0.03, ancho: 0.27, alto: 0.11 };

const imagenComoContenido = (archivo, tipo) => ({ type: 'image_url', image_url: { url: `data:${tipo};base64,${fs.readFileSync(archivo).toString('base64')}` } });

// Prompt de la imagen: lo único que cambia entre flyers son los datos; el estilo sale de los flyers de referencia.
export function promptFlyer(flyer) {
  const lineas = [
    flyer.empresa && `Top line, small text: "${flyer.empresa}"`,
    `Main headline, very large and bold, in uppercase: "${flyer.puesto.toUpperCase()}"`,
    flyer.sueldo && `Highlighted first item of the benefits card (the most prominent one, with a money icon): "${flyer.sueldo}"`,
    ...flyer.beneficios.map(beneficio => `Benefits card item with a small round icon: "${beneficio}"`),
    flyer.horario && `Schedule item with a clock icon: "${flyer.horario}"`,
    flyer.ubicacion && `Location with a map-pin icon: "${flyer.ubicacion}"`,
    'Call-to-action with a WhatsApp icon: "Información y postulaciones por WhatsApp"',
  ].filter(Boolean);

  return [
    "Design a SQUARE 1:1 job-recruitment flyer for PowerBell, a Mexican staffing agency. The attached images are PowerBell's existing flyers: copy their visual language very closely (bold condensed headline on a strong contrasting banner or panel, a rounded card with the offer and one round icon per line, photorealistic photo of workers in uniform doing the job, a rounded call-to-action bar at the bottom, subtle decorative shapes). Use them ONLY as a style guide: do not copy their text, companies, prices or logos.",
    `Photo: ${flyer.escena || `people working as ${flyer.puesto}`}. Make the people Latin American and the setting realistic.`,
    `Colors and mood: ${flyer.estilo || 'the PowerBell palette: deep navy blue (#1D283D) and gold (#C9B06F) with white, optionally an accent like orange or yellow'}.`,
    `LOGO SPACE: the top-right corner (about ${Math.round(ZONA_LOGO.ancho * 100)}% of the width and ${Math.round(ZONA_LOGO.alto * 100)}% of the height, starting ${Math.round(ZONA_LOGO.x * 100)}% from the left and ${Math.round(ZONA_LOGO.y * 100)}% from the top) must be plain, uncluttered background with NOTHING in it (no text, no logo, no icon, no photo detail): a logo will be placed there afterwards. Do not draw any logo or the word "PowerBell" anywhere.`,
    'The text must be in Spanish and spelled correctly. Render ONLY the following text, copied exactly character by character, with no extra, invented or translated text, no phone numbers, no websites, no extra prices:',
    ...lineas.map(linea => `- ${linea}`),
    'Make every text high-contrast and easy to read on a phone. Keep generous margins so nothing is cut off at the edges.',
  ].join('\n');
}

async function pedirImagen(contenido) {
  const datos = await orChatCompletion({
    model:        OPENROUTER_MODEL_FLYER,
    modalities:   ['image', 'text'],
    image_config: { aspect_ratio: '1:1' },
    messages:     [{ role: 'user', content: contenido }],
  });
  const url = datos?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url?.includes(',')) throw new Error('OpenRouter no devolvió una imagen válida');
  return Buffer.from(url.split(',')[1], 'base64');
}

// Imagen del flyer sin logo.
export const generarFlyer = flyer =>
  pedirImagen([{ type: 'text', text: promptFlyer(flyer) }, ...REFERENCIAS.map(archivo => imagenComoContenido(archivo, 'image/jpeg'))]);

// Corrige un flyer ya generado: el modelo recibe la imagen anterior y solo el cambio pedido.
export const corregirFlyer = (imagenAnterior, cambio) => pedirImagen([
  { type: 'text', text: `Edit this recruitment flyer. Apply ONLY this change: ${cambio}. Keep the layout, the photo, the empty top-right corner and every other piece of text exactly the same, and keep all Spanish text spelled correctly. Do not add any logo.` },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${imagenAnterior.toString('base64')}` } },
]);

const luminancia = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Pone el logo real (ícono + "PowerBell") en la zona libre: oscuro sobre fondo claro y blanco sobre fondo oscuro. Si el
// fondo de la zona no quedó liso, el logo lleva una placa detrás para que se lea.
export async function ponerLogo(imagen) {
  asegurarFuenteRegistrada();
  const base = await loadImage(imagen);
  const lienzo = createCanvas(base.width, base.height);
  const ctx = lienzo.getContext('2d');
  ctx.drawImage(base, 0, 0);

  const zona = { x: ZONA_LOGO.x * base.width, y: ZONA_LOGO.y * base.height, ancho: ZONA_LOGO.ancho * base.width, alto: ZONA_LOGO.alto * base.height };
  const { data } = ctx.getImageData(Math.round(zona.x), Math.round(zona.y), Math.round(zona.ancho), Math.round(zona.alto));
  const valores = [];
  for (let i = 0; i < data.length; i += 16) valores.push(luminancia(data[i], data[i + 1], data[i + 2]));
  const media = valores.reduce((suma, valor) => suma + valor, 0) / valores.length;
  const desviacion = Math.sqrt(valores.reduce((suma, valor) => suma + (valor - media) ** 2, 0) / valores.length);

  const conPlaca = desviacion > 35; // zona con detalle: placa lisa detrás del logo
  if (conPlaca) {
    ctx.fillStyle = 'rgba(20,28,45,0.9)';
    ctx.beginPath();
    ctx.roundRect(zona.x, zona.y, zona.ancho, zona.alto, zona.alto * 0.2);
    ctx.fill();
  }
  const logoBlanco = conPlaca || media < 140;

  const icono = await loadImage(fs.readFileSync(logoBlanco ? LOGO_OSCURO : LOGO_CLARO));
  const color = logoBlanco ? '#FFFFFF' : '#1D283D';
  const margen = zona.alto * 0.12;
  const altoIcono = zona.alto - margen * 2;
  const anchoIcono = altoIcono * (icono.width / icono.height);

  let tamano = altoIcono * 0.62;
  ctx.font = `bold ${tamano}px "Roboto"`;
  const hueco = altoIcono * 0.18;
  const disponible = zona.ancho - margen * 2 - anchoIcono - hueco;
  while (ctx.measureText('PowerBell').width > disponible && tamano > 8) { tamano -= 1; ctx.font = `bold ${tamano}px "Roboto"`; }
  const anchoTexto = ctx.measureText('PowerBell').width;

  // Alineado a la derecha de la zona.
  const x0 = zona.x + zona.ancho - margen - (anchoIcono + hueco + anchoTexto);
  ctx.drawImage(icono, x0, zona.y + margen, anchoIcono, altoIcono);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('PowerBell', x0 + anchoIcono + hueco, zona.y + zona.alto / 2);
  return lienzo.toBuffer('image/png');
}
