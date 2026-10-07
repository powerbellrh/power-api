import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agregarLineaHistorial, esRespuestaAtrasada, guardarConversacion, INTENTOS_BLOQUEO, obtenerOCrearConversacion, procesarConBloqueo,
} from '../lib/chatbot/conversacion.js';
import { FLUJOS } from '../lib/chatbot/flujos.js';

// Supabase en memoria, solo con lo que usa conversacion.js: select/eq/maybeSingle, insert/select/single
// (con restricción única en telefono y manychat, como la tabla real) y update con filtros encadenados.
function crearSupabase() {
  const filas = [];
  let siguienteId = 1;
  const pausa = () => new Promise(resolver => setImmediate(resolver));

  return {
    filas,
    from() {
      return {
        select: () => {
          const filtros = [];
          const consulta = {
            eq: (columna, valor) => { filtros.push([columna, valor]); return consulta; },
            maybeSingle: async () => {
              await pausa();
              const fila = filas.find(f => filtros.every(([c, v]) => f[c] === v));
              return { data: fila ? structuredClone(fila) : null, error: null };
            },
          };
          return consulta;
        },
        insert: nueva => ({
          select: () => ({
            single: async () => {
              await pausa();
              if (filas.some(f => f.telefono === nueva.telefono || f.manychat === nueva.manychat)) {
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              const fila = { id: siguienteId++, paso: 'sin_vacante', temporal: {}, intentos: 0, recordatorios: 0, version: 0, flujo_enviado: null, historial: null, ...nueva };
              filas.push(fila);
              return { data: structuredClone(fila), error: null };
            },
          }),
        }),
        update: cambios => {
          const filtros = [];
          const consulta = {
            eq: (columna, valor) => { filtros.push([columna, valor]); return consulta; },
            select: async () => {
              await pausa();
              const afectadas = filas.filter(f => filtros.every(([c, v]) => f[c] === v));
              afectadas.forEach(f => Object.assign(f, structuredClone(cambios)));
              return { data: afectadas.map(f => ({ id: f.id })), error: null };
            },
          };
          return consulta;
        },
      };
    },
  };
}

const contacto = { telefono: '5213300000000', idContacto: 1234567 };

test('crea la conversación del contacto la primera vez y la reutiliza después', async () => {
  const supabase = crearSupabase();
  const primera = await obtenerOCrearConversacion(supabase, contacto);
  const segunda = await obtenerOCrearConversacion(supabase, contacto);

  assert.equal(primera.esNueva, true);
  assert.equal(segunda.esNueva, false);
  assert.equal(supabase.filas.length, 1);
  assert.equal(primera.conversacion.manychat, 1234567);
  assert.equal(primera.conversacion.paso, 'sin_vacante');
});

test('dos primeros mensajes simultáneos crean una sola conversación', async () => {
  const supabase = crearSupabase();
  const [a, b] = await Promise.all([obtenerOCrearConversacion(supabase, contacto), obtenerOCrearConversacion(supabase, contacto)]);

  assert.equal(supabase.filas.length, 1);
  assert.equal(a.conversacion.id, b.conversacion.id);
  assert.deepEqual([a.esNueva, b.esNueva].sort(), [false, true]);
});

test('guardar solo aplica si la versión sigue siendo la leída, y la sube en uno', async () => {
  const supabase = crearSupabase();
  const { conversacion } = await obtenerOCrearConversacion(supabase, contacto);

  const guardada = await guardarConversacion(supabase, conversacion, { paso: 'nombre' });
  assert.equal(guardada.version, 1);
  assert.equal(guardada.paso, 'nombre');
  assert.equal(supabase.filas[0].version, 1);

  // Con la versión vieja ya no escribe nada.
  const perdida = await guardarConversacion(supabase, conversacion, { paso: 'edad' });
  assert.equal(perdida, null);
  assert.equal(supabase.filas[0].paso, 'nombre');
});

test('dos mensajes solapados no se pisan: el segundo vuelve a leer y decide de nuevo', async () => {
  const supabase = crearSupabase();
  let llamadas = 0;
  const decidir = async conversacion => {
    llamadas++;
    await new Promise(resolver => setTimeout(resolver, 5)); // ventana donde el otro mensaje también lee
    return { cambios: { temporal: { contador: (conversacion.temporal.contador ?? 0) + 1 } } };
  };

  await Promise.all([procesarConBloqueo(supabase, contacto, decidir), procesarConBloqueo(supabase, contacto, decidir)]);

  assert.equal(supabase.filas[0].temporal.contador, 2, 'no se perdió ninguna actualización');
  assert.equal(supabase.filas[0].version, 2);
  assert.equal(llamadas, 3, 'uno de los dos tuvo que repetir su decisión');
});

test('el historial se agrega en el mismo guardado que los cambios', async () => {
  const supabase = crearSupabase();
  const { conversacion } = await procesarConBloqueo(supabase, contacto, async () => ({
    cambios: { paso: 'nombre' },
    lineas: [{ actor: 'candidato', texto: 'Hola' }, { actor: 'bot', texto: '¿Cómo te llamas?' }],
  }));

  const lineas = conversacion.historial.split('\n');
  assert.equal(lineas.length, 2);
  assert.match(lineas[0], /^\[.+\] candidato: Hola$/);
  assert.match(lineas[1], /^\[.+\] bot: ¿Cómo te llamas\?$/);
  assert.equal(supabase.filas[0].version, 1, 'un solo guardado');
});

test('si no hay nada que cambiar no se escribe ni se sube la versión', async () => {
  const supabase = crearSupabase();
  const resultado = await procesarConBloqueo(supabase, contacto, async () => ({ ignorado: true }));

  assert.equal(resultado.decision.ignorado, true);
  assert.equal(supabase.filas[0].version, 0);
});

test('si siempre pierde la carrera, falla en vez de repetir sin fin', async () => {
  const supabase = crearSupabase();
  let llamadas = 0;
  await assert.rejects(
    () => procesarConBloqueo(supabase, contacto, async () => {
      llamadas++;
      supabase.filas[0].version++; // otro mensaje siempre se adelanta
      return { cambios: { paso: 'nombre' } };
    }),
    /en conflicto/,
  );
  assert.equal(llamadas, INTENTOS_BLOQUEO);
});

test('agregarLineaHistorial une las líneas con salto de línea', () => {
  const uno = agregarLineaHistorial(null, 'candidato', 'Hola');
  const dos = agregarLineaHistorial(uno, 'bot', 'Hola, ¿cómo te llamas?');
  assert.equal(dos.split('\n').length, 2);
});

test('una respuesta de un flujo distinto del último enviado es atrasada, salvo la de recepción', () => {
  const conversacion = { flujo_enviado: FLUJOS.MENSAJE.flow_ns };

  assert.equal(esRespuestaAtrasada(conversacion, FLUJOS.MENSAJE.flow_ns), false);
  assert.equal(esRespuestaAtrasada(conversacion, FLUJOS.IMAGEN_Y_MENSAJE.flow_ns), true);
  assert.equal(esRespuestaAtrasada(conversacion, FLUJOS.RECEPCION.flow_ns), false);
  assert.equal(esRespuestaAtrasada({ flujo_enviado: null }, FLUJOS.MENSAJE.flow_ns), false);
  assert.equal(esRespuestaAtrasada(conversacion, ''), false);
});
