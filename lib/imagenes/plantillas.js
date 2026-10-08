import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import fs from 'fs';

// Dibuja las imágenes del candidato sobre sus plantillas: el PowerID (credencial para su cita) y la felicitación.

const rutaPlantilla = archivo => path.join(process.cwd(), 'assets', 'templates', archivo);

const POWERID = {
  imagen: rutaPlantilla('PowerID.png'),
  ancho: 1080,
  alto: 1920,
  campos: {
    fotografia: { x: 300, y: 255, width: 480, height: 480, forma: 'circulo' },
    nombre:     { x: 540, y: 800,  fontSize: 48, fontWeight: 'bold',   color: '#FFFFFF', align: 'center', maxWidth: 950 },
    vacante:    { x: 110, y: 930,  fontSize: 36, fontWeight: 'normal', color: '#FFFFFF', align: 'left',   maxWidth: 530 },
    telefono:   { x: 680, y: 930,  fontSize: 36, fontWeight: 'normal', color: '#FFFFFF', align: 'left' },
    citado:     { x: 110, y: 1100, fontSize: 36, fontWeight: 'bold',   color: '#FFFFFF', align: 'left',   maxWidth: 880 },
  },
};

const FELICITACION = {
  imagen: rutaPlantilla('Felicitacion.png'),
  ancho: 1080,
  alto: 1080,
  campos: {
    nombre: { x: 540, y: 700, fontSize: 50, fontWeight: 'bold', color: '#FFFFFF', align: 'center', maxWidth: 450 },
  },
};

let fuenteRegistrada = false;

function asegurarFuenteRegistrada() {
  if (fuenteRegistrada) return;
  fuenteRegistrada = true;

  const regular = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Regular.ttf');
  const negrita = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Bold.ttf');

  if (fs.existsSync(regular) && fs.existsSync(negrita)) {
    registerFont(regular, { family: 'Roboto' });
    registerFont(negrita, { family: 'Roboto', weight: 'bold' });
  }
}

async function lienzoConPlantilla(plantilla) {
  asegurarFuenteRegistrada();

  const canvas = createCanvas(plantilla.ancho, plantilla.alto);
  const ctx = canvas.getContext('2d');

  const fondo = await loadImage(plantilla.imagen);
  ctx.drawImage(fondo, 0, 0, plantilla.ancho, plantilla.alto);

  return { canvas, ctx };
}

// Si el texto no cabe en `maxWidth`, sigue en renglones debajo.
function dibujarTextoEnRenglones(ctx, texto, config) {
  const { x, y, fontSize = 24, fontWeight = 'normal', color = '#000000', maxWidth, align = 'left' } = config;
  ctx.font = `${fontWeight} ${fontSize}px "Roboto"`;
  ctx.fillStyle = color;
  ctx.textAlign = align;

  if (!maxWidth) {
    ctx.fillText(texto, x, y);
    return;
  }

  const palabras = texto.split(' ');
  const lineas = [];
  let lineaActual = palabras[0];

  for (let i = 1; i < palabras.length; i++) {
    const candidata = `${lineaActual} ${palabras[i]}`;
    if (ctx.measureText(candidata).width < maxWidth) {
      lineaActual = candidata;
    } else {
      lineas.push(lineaActual);
      lineaActual = palabras[i];
    }
  }
  lineas.push(lineaActual);

  const alturaLinea = fontSize * 1.2;
  lineas.forEach((linea, i) => ctx.fillText(linea, x, y + i * alturaLinea));
}

// Si el texto no cabe en `maxWidth`, se achica la letra hasta que quepa en un solo renglón.
function dibujarTextoAjustado(ctx, texto, config) {
  const { x, y, fontSize = 24, fontWeight = 'normal', color = '#000000', maxWidth, align = 'left' } = config;
  let tamanoActual = fontSize;

  if (maxWidth) {
    ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
    while (ctx.measureText(texto).width > maxWidth && tamanoActual > 8) {
      tamanoActual -= 1;
      ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
    }
  }

  ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(texto, x, y);
}

async function dibujarFoto(ctx, urlFoto, config) {
  const { x, y, width, height, forma = 'rectangulo' } = config;

  try {
    const foto = await Promise.race([
      loadImage(urlFoto),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout cargando imagen')), 15000)),
    ]);

    if (forma === 'circulo') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + width / 2, y + height / 2, width / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(foto, x, y, width, height);
      ctx.restore();
    } else {
      ctx.drawImage(foto, x, y, width, height);
    }
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'dibujar_foto', estado: 'error', mensaje: e.message }));

    ctx.fillStyle = '#cccccc';
    if (forma === 'circulo') {
      ctx.beginPath();
      ctx.arc(x + width / 2, y + height / 2, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, width, height);
    }

    ctx.fillStyle = '#666666';
    ctx.font = '14px "Roboto"';
    ctx.textAlign = 'center';
    ctx.fillText('Sin foto', x + width / 2, y + height / 2);
  }
}

export async function generarCredencial({ nombre, vacante, fotografia, telefono, citado }) {
  const { canvas, ctx } = await lienzoConPlantilla(POWERID);

  if (fotografia) await dibujarFoto(ctx, fotografia, POWERID.campos.fotografia);
  if (nombre)     dibujarTextoEnRenglones(ctx, nombre, POWERID.campos.nombre);
  if (vacante)    dibujarTextoEnRenglones(ctx, vacante, POWERID.campos.vacante);
  if (telefono)   dibujarTextoEnRenglones(ctx, telefono, POWERID.campos.telefono);
  if (citado)     dibujarTextoEnRenglones(ctx, citado, POWERID.campos.citado);

  return canvas.toBuffer('image/png');
}

export async function generarFelicitacion(nombre) {
  const { canvas, ctx } = await lienzoConPlantilla(FELICITACION);

  if (nombre) dibujarTextoAjustado(ctx, nombre, FELICITACION.campos.nombre);

  return canvas.toBuffer('image/png');
}
