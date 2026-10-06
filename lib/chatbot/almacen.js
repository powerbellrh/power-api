import { timestampCdmx } from './utilidades.js';

// Acceso a la tabla `chatbot` de Supabase (una fila por teléfono).

// El teléfono se guarda desde el primer mensaje (el consentimiento de privacidad ya
// se resuelve del lado de ManyChat antes de llegar aquí), así que la fila se puede
// localizar por `telefono` o por `manychat` (id de suscriptor) indistintamente.
export async function obtenerOCrearContacto(supabase, idSuscriptor, telefono) {
  const { data: porTelefono, error: errorPorTelefono } = await supabase
    .from('chatbot')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle();
  if (errorPorTelefono) throw errorPorTelefono;
  if (porTelefono) return { fila: porTelefono, esNuevo: false };

  const { data: porSuscriptor, error: errorPorSuscriptor } = await supabase
    .from('chatbot')
    .select('*')
    .eq('manychat', idSuscriptor)
    .maybeSingle();
  if (errorPorSuscriptor) throw errorPorSuscriptor;
  if (porSuscriptor) {
    if (porSuscriptor.telefono) return { fila: porSuscriptor, esNuevo: false };

    const { data: actualizado, error: errorTelefono } = await supabase
      .from('chatbot')
      .update({ telefono })
      .eq('id', porSuscriptor.id)
      .select()
      .single();
    if (errorTelefono) throw errorTelefono;
    return { fila: actualizado, esNuevo: false };
  }

  const { data: creado, error: errorInsercion } = await supabase
    .from('chatbot')
    .insert({ manychat: idSuscriptor, telefono, creado: timestampCdmx() })
    .select()
    .single();
  if (errorInsercion) throw errorInsercion;
  return { fila: creado, esNuevo: true };
}

// Guarda los cambios en Supabase y los refleja en la fila en memoria. Si Supabase falla se
// registra el error pero la conversación sigue con el valor en memoria durante este turno.
export async function actualizarFila({ supabase, fila, log }, cambios) {
  Object.assign(fila, cambios);
  const { error } = await supabase.from('chatbot').update(cambios).eq('id', fila.id);
  if (error) log('supabase_fila', { estado: 'error', campos: Object.keys(cambios), error: error.message });
}

export async function agregarMensajeConversacion(supabase, fila, actor, texto, { actualizarTimestamp = false, reiniciarRecordatorios = false } = {}) {
  const linea = `[${timestampCdmx()}] ${actor}: ${texto}`;
  const conversacion = fila.conversacion ? `${fila.conversacion}\n${linea}` : linea;

  const cambios = { conversacion };
  if (actualizarTimestamp)     cambios.actualizado   = timestampCdmx();
  if (reiniciarRecordatorios)  cambios.recordatorios = 0;

  const { error } = await supabase.from('chatbot').update(cambios).eq('id', fila.id);
  if (error) console.log(JSON.stringify({ etapa: 'supabase_conversacion', estado: 'error', mensaje: error.message, actor }));

  Object.assign(fila, cambios);
}

// Todo mensaje del candidato reinicia la cuenta de recordatorios por inactividad: si escribe
// después de que se le cerró la conversación, la postulación se reanuda donde se quedó.
export async function registrarMensajeCandidato(supabase, fila, mensaje) {
  await agregarMensajeConversacion(supabase, fila, 'usuario', mensaje, { actualizarTimestamp: true, reiniciarRecordatorios: true });
}

export async function registrarSolicitudEliminacion({ supabase, fila, log }) {
  if (fila.solicitud_eliminacion) return;

  const ahora = timestampCdmx();
  const { error } = await supabase.from('chatbot').update({ solicitud_eliminacion: ahora }).eq('id', fila.id);
  if (error) {
    log('supabase_baja', { estado: 'error', error: error.message });
    return;
  }

  fila.solicitud_eliminacion = ahora;
  log('supabase_baja', { estado: 'ok' });
}
