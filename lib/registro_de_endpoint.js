import { crearRegistro } from './registro.js';
import { crearSupabase } from './supabase.js';

// Envuelve el handler de un endpoint para que cada solicitud deje una fila en `registros` (ver lib/registro.js), sin
// tocar el cuerpo del handler: se le pasa un `res` que solo guarda lo que el handler contesta, se escribe la fila y
// hasta entonces se manda la respuesta (después de responder, Vercel puede congelar la función).
//
//   export default conRegistro({ origen: 'experiencia', operacion: 'experiencia', referencia: req => req.body?.candidato, tipoReferencia: 'candidato' }, handler);
//
// De cada solicitud queda: el estado ('error' si contestó 400 o más), los segundos, el costo de los modelos que haya
// usado y lo que devuelva `resumen` (cifras e identificadores; el filtro de privacidad descarta cualquier otro texto).
//
// - `referencia(req)`: a qué se refiere la solicitud (id de postulación, de candidato...). Nunca un nombre ni un teléfono.
// - `resumen({ req, codigo, cuerpo })`: lo que va en `detalle`. Puede traer `estado` para cambiarlo (ej. 'omitido').
// - `guardarSi({ req, codigo, cuerpo })`: para los que se llaman muchas veces sin hacer nada (un cron con la cola
//   vacía, un webhook que se ignora). Los errores se guardan siempre.
// - `desdeElInicio`: inserta la fila al empezar con estado 'iniciado' (para lo que tarda: si Vercel lo corta, se nota).
//
// Las solicitudes sin permiso (401) o con otro método (405) no se registran: son ruido de quien toca la URL.
// El handler solo puede contestar con `res.status(codigo).json(cuerpo)`, que es lo que usan todos.

const SIN_REGISTRO = new Set([401, 405]);

export function conRegistro({ origen, operacion, actor = null, tipoReferencia = null, referencia = () => null, resumen = () => ({}), guardarSi = () => true, desdeElInicio = false, clienteSupabase = crearSupabase }, manejar) {
  return async function handler(req, res) {
    const respuesta = { codigo: 200, cuerpo: undefined, lista: false };
    const captura = {
      status(codigo) { respuesta.codigo = codigo; return captura; },
      json(cuerpo)   { respuesta.cuerpo = cuerpo; respuesta.lista = true; return captura; },
    };

    const registro = crearRegistro({ origen, referencia: referencia(req) ?? null, tipoReferencia, actor });
    const inicio   = Date.now();
    let supabase   = null;

    await registro.ejecutar(async () => {
      let abierta = null;
      try {
        if (desdeElInicio) abierta = await registro.abrir(supabase = clienteSupabase(), operacion);
        await manejar(req, captura);
      } catch (error) {
        // Un handler que lanza es un 500, igual que haría Vercel, pero queda registrado.
        respuesta.codigo = 500;
        respuesta.cuerpo = { error: error.message };
        respuesta.lista  = true;
      }

      const { codigo, cuerpo } = respuesta;
      if (SIN_REGISTRO.has(codigo)) return;
      const fallo = codigo >= 400;
      try {
        const { estado = fallo ? 'error' : 'ok', ...cifras } = resumen({ req, codigo, cuerpo }) ?? {};
        const datos = { ...cifras, codigo, error: fallo ? cuerpo?.error ?? cuerpo?.message ?? `HTTP ${codigo}` : null };
        if (abierta) {
          await abierta.cerrar(fallo ? 'error' : estado, datos);
        } else if (fallo || guardarSi({ req, codigo, cuerpo })) {
          registro.log(operacion, { ...datos, estado: fallo ? 'error' : estado, guardar: true, segundos: Number(((Date.now() - inicio) / 1000).toFixed(1)), costo_usd: registro.costoUsd > 0 ? Number(registro.costoUsd.toFixed(6)) : null });
        }
        if (registro.pendientes.length) await registro.guardar(supabase ?? clienteSupabase());
      } catch (error) {
        console.log(JSON.stringify({ etapa: 'registros', estado: 'sin_guardar', error: error.message })); // el registro nunca tumba la respuesta
      }
    });

    if (respuesta.lista) return res.status(respuesta.codigo).json(respuesta.cuerpo);
  };
}
