import { AsyncLocalStorage } from 'node:async_hooks';

// Registro de una solicitud, compartido por los endpoints. Hace dos cosas con cada evento:
// - lo imprime como una línea de JSON ({ etapa, estado, ... }), igual que los `console.log` de siempre;
// - si es un fallo (ver ESTADOS_DE_FALLO) o viene con `guardar: true`, lo junta para guardarlo en la tabla `eventos` al terminar la solicitud, que
//   es donde se pueden contar: cuántas veces falló el modelo, qué guardrail rechazó más mensajes, qué endpoint falla.
//
// Uso en un endpoint:
//
//   const registro = crearRegistro({ origen: 'conversaciones', referencia: idContacto, contexto: { flujo } });
//   await registro.ejecutar(() => procesar({ log: registro.log }));
//   await registro.guardar(supabase);
//
// Dentro de `ejecutar`, cualquier módulo puede avisar de un evento sin recibir el registro por parámetro:
//
//   registrar('modelo', { estado: 'error', herramienta: 'extraer_nombre', error: e.message });
//
// Fuera de `ejecutar` (un script, una prueba, un endpoint que todavía no lo usa) `registrar` no hace nada.
//
// La tabla: eventos(id, creado, origen, etapa, estado, referencia, detalle jsonb).
// `contexto` se imprime en cada línea pero NO se guarda: ahí van los datos personales (el mensaje del candidato).

const ESTADOS_DE_FALLO = new Set(['error', 'reintento', 'rechazado']);
const MAXIMO_TEXTO_DETALLE = 500;

const solicitudActual = new AsyncLocalStorage();

const recortar = valor => (typeof valor === 'string' ? valor.slice(0, MAXIMO_TEXTO_DETALLE) : valor);

// `origen`: el endpoint. `referencia`: a qué se refiere la solicitud (un id de contacto, de postulación...), para
// poder buscar sus eventos; nunca un nombre ni un teléfono. `imprimir` solo cambia en las pruebas.
export function crearRegistro({ origen, referencia = null, contexto = {}, imprimir = linea => console.log(linea) }) {
  const pendientes = [];

  const registro = {
    log(etapa, datos = {}) {
      // `guardar: true` guarda también un evento que no es un fallo (ej. que al agente se le compactó el contexto).
      const { guardar, ...resto } = datos;
      imprimir(JSON.stringify({ etapa, ...contexto, ...resto }));
      if (!guardar && !ESTADOS_DE_FALLO.has(resto.estado)) return;

      const { estado, ...detalle } = resto;
      pendientes.push({
        origen, etapa, estado,
        referencia: referencia === null ? null : String(referencia),
        detalle:    Object.fromEntries(Object.entries(detalle).map(([clave, valor]) => [clave, recortar(valor)])),
      });
    },

    // Corre `funcion` con este registro como el de la solicitud en curso (lo que hace que `registrar` lo encuentre).
    ejecutar: funcion => solicitudActual.run(registro, funcion),

    // Guarda los fallos juntados. Nunca lanza: un problema con la tabla no debe tumbar la solicitud.
    async guardar(supabase) {
      if (!pendientes.length) return;
      const eventos = pendientes.splice(0);
      try {
        const { error } = await supabase.from('eventos').insert(eventos);
        if (error) throw error;
      } catch (e) {
        imprimir(JSON.stringify({ etapa: 'eventos', estado: 'sin_guardar', cantidad: eventos.length, error: e.message }));
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
