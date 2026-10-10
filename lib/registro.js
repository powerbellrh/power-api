import { AsyncLocalStorage } from 'node:async_hooks';

// Registro de una solicitud, compartido por los endpoints. Todo queda en la tabla `registros`, que es la bitácora
// de lo que pasa en la API: una fila por operación y filas hijas por los hechos importantes de esa operación.
//
// Hay dos formas de dejar constancia:
//
// 1. Eventos sueltos (`log` / `registrar`). Cada evento se imprime como una línea de JSON ({ etapa, estado, ... }),
//    igual que los `console.log` de siempre; si es un fallo (ver ESTADOS_DE_FALLO) o viene con `guardar: true`, además
//    se junta para guardarlo como una fila al terminar la solicitud.
//
//      const registro = crearRegistro({ origen: 'conversaciones', referencia: idContacto, tipoReferencia: 'contacto', contexto: { flujo } });
//      await registro.ejecutar(() => procesar({ log: registro.log }));
//      await registro.guardar(supabase);
//
//    Dentro de `ejecutar`, cualquier módulo puede avisar de un evento sin recibir el registro por parámetro:
//
//      registrar('modelo', { estado: 'error', herramienta: 'extraer_nombre', error: e.message });
//
//    Fuera de `ejecutar` (un script, una prueba, un endpoint que todavía no lo usa) `registrar` no hace nada.
//
// 2. Operaciones (`abrir`). La fila se inserta al EMPEZAR con estado 'iniciado' y se actualiza al terminar con su
//    estado, sus segundos y su costo: una fila que se queda en 'iniciado' es una operación atascada o que Vercel cortó.
//    Los eventos que se junten mientras está abierta quedan como hijas suyas (`id_padre`).
//
//      const operacion = await registro.abrir(supabase, 'evaluacion', { intento: 2 });
//      ...
//      await operacion.cerrar('ok', { detalle: { modelo, calificacion } });
//
// El costo se suma solo: lib/openrouter.js avisa con `anotarCosto` de lo que cobró cada llamada hecha dentro de
// `ejecutar`, y al cerrar la operación queda en `costo_usd`.
//
// La tabla: registros(id, creado, terminado, origen, operacion, estado, referencia, tipo_referencia, id_padre, actor,
// intento, segundos, costo_usd, error, detalle jsonb).
//
// PRIVACIDAD. La tabla es permanente y no debe retener información de candidatos ni textos de las reclutadoras, así
// que `detalle` pasa por un filtro (ver `filtrarDetalle`): entran números, booleanos e identificadores; un texto solo
// entra si su clave está en CLAVES_DE_TEXTO y es corto. Cualquier otro texto se descarta sin avisar. Quien registra
// sigue siendo responsable de no mandar un dato personal como número (una edad, un sueldo).
// `contexto` se imprime en cada línea pero NUNCA se guarda: ahí va el mensaje del candidato.

const ESTADOS_DE_FALLO = new Set(['error', 'reintento', 'rechazado']);
const MAXIMO_TEXTO  = 80;
const MAXIMO_ERROR  = 300;
const MAXIMO_LISTA  = 60;
const MAXIMA_PROFUNDIDAD = 4;

// Textos que describen la operación y no a una persona: nombres de modelos, etapas, motivos, campos, categorías.
const CLAVES_DE_TEXTO = new Set([
  'modelo', 'proveedor', 'motor', 'actividad', 'herramienta', 'etapa', 'paso', 'flujo', 'motivo', 'razon', 'reglas',
  'tipo', 'cierre', 'decision', 'accion', 'filtro', 'clave', 'campo', 'campos', 'categoria', 'cambio', 'intenciones',
  'material', 'operacion', 'origen', 'problemas_de', 'periodo', 'agrupar_por', 'grafica', 'efectos', 'cliente', 'foto',
]);
// Frases que redacta un modelo para describir, sin datos de nadie, lo que pidió una reclutadora (lib/descripcion_de_texto.js).
const CLAVES_DE_DESCRIPCION = new Set(['pedido']);
const MAXIMO_DESCRIPCION = 160;

// Columnas de la tabla que salen de los datos del evento en vez de quedar dentro de `detalle`.
const COLUMNAS = ['intento', 'segundos', 'costo_usd'];

const esClaveDeId   = clave => /^id$|^id_|_id$|_ids$|^id[A-Z]|Id$/.test(clave);
const PARECE_ID     = /^[\w-]{1,64}$/;
const CORREO        = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TELEFONO      = /\+?\d[\d\s().-]{8,}\d/g;
const tieneContacto = texto => new RegExp(CORREO.source).test(texto) || new RegExp(TELEFONO.source).test(texto);

// Los mensajes de error se guardan porque sin ellos no se puede diagnosticar, pero recortados y sin teléfonos ni correos.
export function limpiarError(error) {
  if (error === null || error === undefined || error === '') return null;
  return String(error?.message ?? error).replace(CORREO, '[correo]').replace(TELEFONO, '[número]').slice(0, MAXIMO_ERROR);
}

function filtrarValor(clave, valor, profundidad) {
  if (valor === null || typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : undefined;
  if (typeof valor === 'string') {
    if (esClaveDeId(clave)) return PARECE_ID.test(valor) ? valor : undefined;
    const maximo = CLAVES_DE_DESCRIPCION.has(clave) ? MAXIMO_DESCRIPCION : CLAVES_DE_TEXTO.has(clave) ? MAXIMO_TEXTO : 0;
    return valor.length <= maximo && !tieneContacto(valor) ? valor : undefined;
  }
  if (profundidad >= MAXIMA_PROFUNDIDAD || typeof valor !== 'object') return undefined;
  if (Array.isArray(valor)) return valor.slice(0, MAXIMO_LISTA).map(elemento => filtrarValor(clave, elemento, profundidad + 1)).filter(elemento => elemento !== undefined);
  return filtrarDetalle(valor, profundidad + 1);
}

// Deja de `datos` solo lo que puede quedar guardado (ver PRIVACIDAD arriba).
export function filtrarDetalle(datos, profundidad = 0) {
  const limpio = {};
  for (const [clave, valor] of Object.entries(datos ?? {}).slice(0, MAXIMO_LISTA)) {
    if (clave.length > MAXIMO_TEXTO) continue;
    const filtrado = filtrarValor(clave, valor, profundidad);
    if (filtrado !== undefined) limpio[clave] = filtrado;
  }
  return limpio;
}

const redondear = (numero, decimales) => (Number.isFinite(numero) ? Number(numero.toFixed(decimales)) : null);

const solicitudActual = new AsyncLocalStorage();

// `origen`: el endpoint. `referencia`: a qué se refiere la solicitud (un id de postulación, de contacto, de vacante),
// para poder buscar sus filas; nunca un nombre ni un teléfono. `tipoReferencia`: postulacion | vacante | contacto |
// candidato. `actor`: quién la disparó (cron | teamtailor | manychat | el id de TeamTailor de la persona).
// `imprimir` y `ahora` solo cambian en las pruebas.
export function crearRegistro({ origen, referencia = null, tipoReferencia = null, actor = null, contexto = {}, imprimir = linea => console.log(linea), ahora = () => Date.now() }) {
  const pendientes = [];
  let actorActual = actor;
  let costoUsd = 0;
  let abierta  = null; // la operación en curso: sus eventos quedan como hijas

  const base = () => ({
    origen,
    referencia:      referencia === null || referencia === undefined ? null : String(referencia),
    tipo_referencia: tipoReferencia,
    actor:           actorActual === null || actorActual === undefined ? null : String(actorActual),
  });

  // Separa lo que va en columnas (error, intento, segundos, costo) de lo que queda en `detalle`, ya filtrado.
  const fila = (operacion, estado, datos) => {
    const { error, ...resto } = datos;
    // Todas las filas llevan las mismas claves: PostgREST lo exige al insertar varias juntas.
    const columnas = { id_padre: null };
    for (const clave of COLUMNAS) {
      columnas[clave] = typeof resto[clave] === 'number' ? resto[clave] : null;
      delete resto[clave];
    }
    return { ...base(), operacion, estado, ...columnas, error: limpiarError(error), detalle: filtrarDetalle(resto) };
  };

  const avisarSinGuardar = (cantidad, error) => imprimir(JSON.stringify({ etapa: 'registros', estado: 'sin_guardar', cantidad, error: error.message }));

  const registro = {
    log(etapa, datos = {}) {
      // `guardar: true` guarda también un evento que no es un fallo (ej. que al agente se le compactó el contexto).
      const { guardar, ...resto } = datos;
      imprimir(JSON.stringify({ etapa, ...contexto, ...resto }));
      if (!guardar && !ESTADOS_DE_FALLO.has(resto.estado)) return;

      const { estado, ...detalle } = resto;
      pendientes.push({ ...fila(etapa, estado ?? 'ok', detalle), id_padre: abierta?.id ?? null });
    },

    // Corre `funcion` con este registro como el de la solicitud en curso (lo que hace que `registrar` y `anotarCosto` lo encuentren).
    ejecutar: funcion => solicitudActual.run(registro, funcion),

    // Para cuando el actor se conoce a media solicitud (ej. la reclutadora dueña de la vacante): vale para las filas
    // que se guarden después y para la operación abierta, al cerrarla.
    asignarActor(nuevo) { actorActual = nuevo; },

    sumarCosto(usd) { if (Number.isFinite(usd) && usd > 0) costoUsd += usd; },
    get costoUsd() { return costoUsd; },

    // Inserta la fila de la operación con estado 'iniciado'. Nunca lanza: si la tabla falla, la operación sigue y
    // al cerrarla se intenta guardar la fila completa.
    async abrir(supabase, operacion, datos = {}) {
      const inicio      = ahora();
      const costoPrevio = costoUsd;
      const inicial     = { ...fila(operacion, 'iniciado', datos), creado: new Date(inicio).toISOString() };
      const actual      = { id: null };
      try {
        const { data, error } = await supabase.from('registros').insert(inicial).select('id').single();
        if (error) throw error;
        actual.id = data.id;
      } catch (e) {
        avisarSinGuardar(1, e);
      }
      abierta = actual;

      return {
        get id() { return actual.id; },

        // `estado`: ok | error | omitido | reintento. `datos` lleva el error y las cifras propias de la operación; lo
        // que se dio al abrirla se conserva. El costo es lo que se anotó desde que se abrió, salvo que se dé `costo_usd`.
        async cerrar(estado, datosFinales = {}) {
          const fin    = ahora();
          const final  = fila(operacion, estado, { ...datosFinales });
          const cambio = {
            estado,
            actor:     base().actor,
            terminado: new Date(fin).toISOString(),
            segundos:  final.segundos ?? redondear((fin - inicio) / 1000, 1),
            costo_usd: final.costo_usd ?? (costoUsd > costoPrevio ? redondear(costoUsd - costoPrevio, 6) : null),
            error:     final.error,
            detalle:   { ...inicial.detalle, ...final.detalle },
            ...(final.intento !== null ? { intento: final.intento } : {}),
          };
          imprimir(JSON.stringify({ etapa: operacion, ...contexto, estado, segundos: cambio.segundos, costo_usd: cambio.costo_usd, ...(cambio.error ? { error: cambio.error } : {}) }));
          if (abierta === actual) abierta = null;
          try {
            const { error } = actual.id
              ? await supabase.from('registros').update(cambio).eq('id', actual.id)
              : await supabase.from('registros').insert({ ...inicial, ...cambio });
            if (error) throw error;
          } catch (e) {
            avisarSinGuardar(1, e);
          }
          await registro.guardar(supabase);
        },
      };
    },

    // Guarda los eventos juntados. Nunca lanza: un problema con la tabla no debe tumbar la solicitud.
    async guardar(supabase) {
      if (!pendientes.length) return;
      const filas = pendientes.splice(0);
      try {
        const { error } = await supabase.from('registros').insert(filas);
        if (error) throw error;
      } catch (e) {
        avisarSinGuardar(filas.length, e);
      }
    },

    get pendientes() { return [...pendientes]; },
  };
  return registro;
}

// Avisa de un evento al registro de la solicitud en curso, si lo hay.
export function registrar(etapa, datos = {}) {
  solicitudActual.getStore()?.log(etapa, datos);
}

// Suma al registro de la solicitud en curso lo que cobró una llamada a un modelo (lo llama lib/openrouter.js).
export function anotarCosto(usd) {
  solicitudActual.getStore()?.sumarCosto(usd);
}
