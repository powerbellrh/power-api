export function dormir(ms) {
  return new Promise(resolver => setTimeout(resolver, ms));
}

const encabezadosTT = () => ({
  'Authorization':  `Token token=${process.env.TEAMTAILOR_API_KEY}`,
  'X-Api-Version':  '20240404',
  'Content-Type':   'application/vnd.api+json',
});

const encabezadosMC = () => ({
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
});

async function ttObtener(ruta, conRetraso = false) {
  if (conRetraso) await dormir(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${ruta}`, { headers: encabezadosTT() });
  if (!r.ok) throw new Error(`TeamTailor GET ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ttActualizar(ruta, cuerpo, conRetraso = false) {
  if (conRetraso) await dormir(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${ruta}`, {
    method:  'PATCH',
    headers: encabezadosTT(),
    body:    JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`TeamTailor PATCH ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ttCrear(ruta, cuerpo, conRetraso = false) {
  if (conRetraso) await dormir(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${ruta}`, {
    method:  'POST',
    headers: encabezadosTT(),
    body:    JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`TeamTailor POST ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ttSubirArchivoTransitorio(buffer, nombreArchivo, tipoMime, conRetraso = false) {
  if (conRetraso) await dormir(1000);
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: tipoMime }), nombreArchivo);

  const r = await fetch('https://api.na.teamtailor.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Token token=${process.env.TEAMTAILOR_API_KEY}`,
      'X-Api-Version':  '20240404',
    },
    body: formData,
  });
  if (!r.ok) throw new Error(`TeamTailor POST /files → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ManyChat limita las peticiones por segundo y contesta 429 ("Api max rps reached") cuando se pasan. El 15-oct-2026
// TeamTailor mandó 24 bajas en el mismo minuto y 21 peticiones de /privacidad se perdieron así (10 contactos quedaron
// sin la etiqueta de baja). Un 429 significa que ManyChat no hizo nada, así que repetir es seguro: se espera 1, 2 y 4 s
// (más una parte al azar, para que las solicitudes que chocaron no vuelvan a chocar) antes de darse por vencido.
const ESPERAS_MC_429 = [1000, 2000, 4000];

async function mcPedir(url, opciones) {
  for (let intento = 0; ; intento++) {
    const r = await fetch(url, opciones);
    if (r.status !== 429 || intento >= ESPERAS_MC_429.length) return r;
    await dormir(ESPERAS_MC_429[intento] + Math.random() * 1000);
  }
}

async function mcCrear(ruta, cuerpo) {
  const r = await mcPedir(`https://api.manychat.com${ruta}`, {
    method:  'POST',
    headers: encabezadosMC(),
    body:    JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`ManyChat ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function mcObtener(ruta, parametros = {}) {
  const qs = new URLSearchParams(parametros).toString();
  const url = `https://api.manychat.com${ruta}${qs ? `?${qs}` : ''}`;
  const r = await mcPedir(url, { headers: encabezadosMC() });
  if (!r.ok) throw new Error(`ManyChat GET ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// TeamTailor contesta 404 cuando lo que se pide ya no existe (una vacante borrada, una postulación eliminada).
const esNoEncontrada = error => /→ 404/.test(error.message);

export { esNoEncontrada, ttObtener, ttActualizar, ttCrear, ttSubirArchivoTransitorio, mcCrear, mcObtener };
