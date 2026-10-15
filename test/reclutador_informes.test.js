import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import {
  MENSAJE_ARMANDO, MENSAJE_CORRIGIENDO, MENSAJE_ERROR_INFORME, MENSAJE_NO_ENCONTRADO, MENSAJE_YA_EN_CURSO, enlaceDeInforme,
} from '../lib/chatbot/reclutador/informe.js';
import { datosSimples, dibujarInforme, disposicion, nombreDelArchivo, unirConCurriculum } from '../lib/informes/pdf.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

// Informes de candidatos desde el chat del agente reclutador: pegar el enlace de la postulación, recibir el PDF y
// corregirlo con comentarios, como en PowerInforme (power_informe.py).

const TELEFONO = '5213312345678';
const CONTACTO = 4242;
const ENLACE   = 'https://app.teamtailor.com/companies/abc123/jobs/555555-almacenista/candidates/segment/all?jobApplicationId=987654';

const INFORME = {
  tipo: 'administrativo', reclutador: 'LAURA PÉREZ',
  simple: { NOMBRE: 'ANA LÓPEZ PÉREZ', CLIENTE: 'PENINSULA', VACANTE: 'ALMACENISTA', ESTADOCIVIL: 'Soltera, sin hijos', EDUCACION: 'Preparatoria', DOMICILIO: 'Zapopan, Jalisco', SUELDODESEADO: '$12,000 mensuales', EDAD: '31 años', COMENTARIOS: 'Destaca por su orden. Se recomienda avanzar en el proceso.', FOTO: 'https://fotos.test/ana.jpg' },
  trayectoria: [{ compania: 'Bodegas del Norte', periodo: 'Marzo 2021 a la fecha', puesto: 'Almacenista', sueldo: '$10,000 mensuales', salida: 'Crecimiento' }],
  apego_vacante: [{ area: 'Inventarios', evidencia: 'Conciliaba inventarios cada semana.' }],
  competencias: [{ competencia: 'Orden', nivel: 'Avanzado' }],
  curriculum: 'https://cv.test/ana.pdf',
};

let entorno;
let informes;
afterEach(() => entorno?.restaurar());

function nuevoEntorno({ generar } = {}) {
  entorno = crearEntornoConversaciones({
    tablas: {
      roles: [{ id: 2, nombre: 'gerente' }],
      usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '777' }],
    },
    respuestasTeamTailor: { '/job-applications/111222': { data: { id: '111222', relationships: { job: { data: { id: '444444' } } } } } },
  });
  informes = { pedidos: [], subidos: [] };
  informes.generar = generar ?? (async pedido => {
    informes.pedidos.push(pedido);
    const version = informes.pedidos.length;
    return { estado: 'ok', candidato: '313131', informe: { ...INFORME, simple: { ...INFORME.simple, COMENTARIOS: `Versión ${version}.` } } };
  });
}

function escribir(texto) {
  return procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono: TELEFONO, idContacto: CONTACTO, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
    log: entorno.log,
    extractores: crearExtractores(entorno.supabase),
    pausaMs: 0,
    reclutadores: { informes: {
      generar:  pedido => informes.generar(pedido),
      armarPdf: async () => ({ pdf: Buffer.from('%PDF-falso'), conFoto: true, conCurriculum: true }),
      subirPdf: async (_, { candidato, postulacion }, pdf, nombre) => { informes.subidos.push({ candidato, postulacion, nombre }); return `https://firmada.test/informes/${postulacion}/${informes.subidos.length}.pdf`; },
    } },
  });
}

const estado = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO).temporal.reclutador;
const corregir = comentarios => ({ herramienta: 'corregir_informe', argumentos: { comentarios } });

// ── Enlace ───────────────────────────────────────────────────────────────

test('el enlace de una postulación da la postulación y la vacante, como power_informe.py', () => {
  assert.deepEqual(enlaceDeInforme(`Hazme el informe de este, porfa ${ENLACE}`), { postulacion: '987654', vacante: '555555' });
  assert.deepEqual(enlaceDeInforme('https://app.teamtailor.com/companies/abc/jobs/555555/candidates/123456'), { postulacion: '123456', vacante: '555555' }, 'enlace viejo');
  assert.deepEqual(enlaceDeInforme('https://app.teamtailor.com/companies/abc/candidates/segment/all?jobApplicationId=111222'), { postulacion: '111222', vacante: null }, 'sin vacante');
  assert.equal(enlaceDeInforme('https://app.teamtailor.com/companies/abc/jobs/555555/edit'), null, 'el enlace de una vacante sola lo atiende el agente');
  assert.equal(enlaceDeInforme('cierra la vacante 555555 por favor'), null);
  assert.equal(enlaceDeInforme('https://otra-pagina.test/jobs/1?jobApplicationId=2'), null, 'solo enlaces de TeamTailor');
});

// ── Informe nuevo ────────────────────────────────────────────────────────

test('pega el enlace: se arma el informe sin pasar por el agente y le llega el enlace al PDF', async () => {
  nuevoEntorno();
  const resultado = await escribir(ENLACE);

  assert.equal(resultado.accion, 'informe');
  assert.equal(entorno.peticionesModelo.length, 0, 'no se llama al agente');
  assert.equal(informes.pedidos.length, 1);
  assert.deepEqual(
    { postulacion: informes.pedidos[0].postulacionId, vacante: informes.pedidos[0].vacanteId, canal: informes.pedidos[0].canal, comentarios: informes.pedidos[0].comentarios },
    { postulacion: '987654', vacante: '555555', canal: 'agente', comentarios: undefined },
  );
  assert.equal(entorno.mensajes[0], MENSAJE_ARMANDO);
  assert.match(entorno.mensajes[1], /^Listo, aquí está el informe:\n\nhttps:\/\/firmada\.test\/informes\/987654\/1\.pdf\n\n_El enlace vale 24 horas\._\n\n¿Quieres que le cambie algo\?/);
  assert.equal(informes.subidos[0].candidato, '313131', 'en la carpeta del candidato, para que /privacidad lo borre');
  assert.match(informes.subidos[0].nombre, /^Peninsula - Informe Ana López Pérez\. Almacenista\. [A-Z][a-z]{2}\d{2} - Laura Pérez\.pdf$/);

  const guardado = estado().informe;
  assert.deepEqual({ postulacion: guardado.postulacion, vacante: guardado.vacante, version: guardado.version, rondas: guardado.rondas }, { postulacion: '987654', vacante: '555555', version: 1, rondas: [] });
  assert.equal(guardado.respuesta.curriculum, undefined, 'el enlace del CV caduca: no se guarda');
  assert.equal(guardado.respuesta.simple.NOMBRE, 'ANA LÓPEZ PÉREZ');
  assert.deepEqual(estado().informes_en_curso, {}, 'ya no está en curso');
  assert.match(entorno.supabase.tablas.conversaciones[0].historial, /agente: Listo, aquí está el informe/);
});

test('un enlace sin la vacante: se le pregunta a TeamTailor de qué vacante es la postulación', async () => {
  nuevoEntorno();
  await escribir('https://app.teamtailor.com/companies/abc/candidates/segment/all?jobApplicationId=111222');
  assert.equal(informes.pedidos[0].vacanteId, '444444');
});

test('el mismo enlace mientras se arma no arma otro informe', async () => {
  nuevoEntorno();
  let soltar;
  const pendiente = new Promise(resolve => { soltar = resolve; });
  informes.generar = async pedido => { informes.pedidos.push(pedido); await pendiente; return { estado: 'ok', informe: INFORME }; };

  const primero = escribir(ENLACE);
  while (!informes.pedidos.length) await new Promise(resolve => setImmediate(resolve));
  await escribir(`otra vez ${ENLACE}`);
  assert.equal(informes.pedidos.length, 1);
  assert.ok(entorno.mensajes.includes(MENSAJE_YA_EN_CURSO));

  soltar();
  await primero;
  assert.equal(estado().informe.version, 1);
});

test('si TeamTailor no tiene la postulación o algo falla, se le avisa y el enlace queda libre para reintentar', async () => {
  nuevoEntorno({ generar: async () => ({ estado: 'no_encontrado' }) });
  await escribir(ENLACE);
  assert.equal(entorno.mensajes.at(-1), MENSAJE_NO_ENCONTRADO);
  assert.deepEqual(estado().informes_en_curso, {});

  nuevoEntorno({ generar: async () => { throw new Error('OpenRouter caído'); } });
  await escribir(ENLACE);
  assert.equal(entorno.mensajes.at(-1), MENSAJE_ERROR_INFORME);
  assert.deepEqual(estado().informes_en_curso, {});
  assert.equal(estado().informe, undefined);
});

// ── Correcciones ─────────────────────────────────────────────────────────

test('sus comentarios corrigen el último informe: las rondas se acumulan y cada versión lleva la anterior', async () => {
  nuevoEntorno();
  await escribir(ENLACE);

  entorno.encolarModelo('agente', corregir('el estado civil es casada, 2 hijos'));
  const resultado = await escribir('cámbiale el estado civil, es casada con 2 hijos');
  assert.equal(resultado.accion, 'corregir_informe');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /INFORME RECIENTE[^\n]*versión 1 del informe de la postulación 987654 \(vacante 555555\)/);
  assert.equal(informes.pedidos[1].comentarios, 'Ronda 2: el estado civil es casada, 2 hijos');
  assert.equal(informes.pedidos[1].respuestaAnterior.simple.COMENTARIOS, 'Versión 1.');
  assert.deepEqual([informes.pedidos[1].postulacionId, informes.pedidos[1].vacanteId], ['987654', '555555']);
  assert.ok(entorno.mensajes.includes(MENSAJE_CORRIGIENDO));
  assert.match(entorno.mensajes.at(-1), /^Listo, apliqué tus cambios\. Aquí está la versión 2 del informe:/);
  assert.match(informes.subidos[1].nombre, / v2 - Laura Pérez\.pdf$/);

  entorno.encolarModelo('agente', corregir('quita la frase de su área de oportunidad'));
  await escribir('quita lo de su área de oportunidad');
  assert.equal(informes.pedidos[2].comentarios, 'Ronda 2: el estado civil es casada, 2 hijos\nRonda 3: quita la frase de su área de oportunidad');
  assert.equal(informes.pedidos[2].respuestaAnterior.simple.COMENTARIOS, 'Versión 2.');
  assert.equal(estado().informe.version, 3);
});

test('una corrección que quedó igual después de dos intentos no se presenta como aplicada', async () => {
  nuevoEntorno();
  await escribir(ENLACE);
  informes.generar = async pedido => { informes.pedidos.push(pedido); return { estado: 'ok', candidato: '313131', sinCambios: true, informe: INFORME }; };

  entorno.encolarModelo('agente', corregir('en motivos de salida ponle: Mal ambiente laboral, compañeras hostiles'));
  await escribir('en motivos de salida ponle: Mal ambiente laboral, compañeras hostiles');
  assert.match(entorno.mensajes.at(-1), /^Una disculpa, lo intenté dos veces y el informe quedó igual\. Te dejo la versión 2/);
  assert.match(entorno.mensajes.at(-1), /¿Me dices otra vez qué parte cambiar y el texto exacto que quieres\?$/);
  assert.doesNotMatch(entorno.mensajes.at(-1), /apliqué tus cambios/);
  assert.equal(estado().informe.version, 2, 'la versión se guarda igual: la siguiente corrección parte de ella');
});

test('corregir_informe sin un informe reciente se le devuelve al agente para que conteste', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', corregir('cambia el sueldo'), { herramienta: 'responder', argumentos: { mensaje: 'Pégame el enlace del candidato y lo armo.' } });
  await escribir('cámbiale el sueldo al informe');
  assert.equal(informes.pedidos.length, 0);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /CORRIGE: No hay ningún INFORME RECIENTE/);
  assert.deepEqual(entorno.mensajes, ['Pégame el enlace del candidato y lo armo.']);
});

// ── PDF ──────────────────────────────────────────────────────────────────

test('los datos simples y las columnas, como las plantillas de PowerInforme', () => {
  assert.equal(datosSimples(INFORME).VACANTE, 'PENINSULA - ALMACENISTA');
  assert.equal(datosSimples(INFORME).TELEFONO, '-');
  assert.equal(datosSimples({ simple: { CLIENTE: '-', VACANTE: 'ALMACENISTA' } }).VACANTE, 'ALMACENISTA', 'sin cliente no queda "- - ALMACENISTA"');

  const columnas = informe => disposicion(informe).columnas.map(([campo]) => campo);
  const sinPeriodoNiSueldo = [{ compania: 'X', periodo: '-', puesto: 'Y', sueldo: '', salida: 'Z' }];
  assert.deepEqual(columnas({ tipo: 'operativo', trayectoria: sinPeriodoNiSueldo }), ['compania', 'puesto', 'salida']);
  assert.deepEqual(columnas({ tipo: 'administrativo', trayectoria: sinPeriodoNiSueldo }), ['compania', 'periodo', 'puesto', 'sueldo', 'salida'], 'fuera de Inbox se deja el "-"');
  assert.deepEqual(columnas({ tipo: 'administrativo', inbox: true, trayectoria: [{ compania: 'X', periodo: '2020', sueldo: '-', salida: '-' }] }), ['compania', 'periodo', 'puesto']);
  assert.equal(disposicion({ tipo: 'administrativo', inbox: true, simple: { ESTADOCIVIL: '-' } }).conEstadoCivil, false);
  assert.equal(disposicion({ tipo: 'administrativo', simple: { ESTADOCIVIL: '-' } }).conEstadoCivil, true);
  assert.equal(disposicion({ tipo: 'operativo' }).conTelefono, true);
});

test('el nombre del archivo, como build_pdf_filename', () => {
  const octubre = new Date('2026-10-11T18:00:00Z');
  assert.equal(nombreDelArchivo(INFORME, 1, octubre), 'Peninsula - Informe Ana López Pérez. Almacenista. Oct26 - Laura Pérez.pdf');
  assert.equal(nombreDelArchivo({ ...INFORME, reclutador: undefined, simple: { ...INFORME.simple, CLIENTE: '-' } }, 3, octubre), 'Informe Ana López Pérez. Almacenista. Oct26 v3.pdf');
  const separados = { ...INFORME, simple: { ...INFORME.simple, NOMBRE: 'ANA LÓPEZ PÉREZ'.normalize('NFD') } };
  assert.equal(nombreDelArchivo(separados, 1, octubre), 'Peninsula - Informe Ana López Pérez. Almacenista. Oct26 - Laura Pérez.pdf', 'los acentos quedan como una sola letra');
});

test('el PDF se dibuja y el CV va al final; un CV que no es PDF se deja fuera', async () => {
  const informe = await dibujarInforme(INFORME);
  assert.equal(informe.subarray(0, 5).toString(), '%PDF-');
  const cv = await dibujarInforme({ ...INFORME, tipo: 'operativo', telefono: '3312345678' });

  const unido = await unirConCurriculum(informe, cv);
  assert.equal(unido.conCurriculum, true);
  assert.equal((await PDFDocument.load(unido.pdf)).getPageCount(), 2);

  const solo = await unirConCurriculum(informe, Buffer.from('no es un pdf'));
  assert.deepEqual([solo.conCurriculum, solo.pdf], [false, informe]);
});
