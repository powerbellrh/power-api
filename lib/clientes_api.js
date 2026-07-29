import { dormir } from './evaluacion_postulacion.js';

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

async function mcCrear(ruta, cuerpo) {
  const r = await fetch(`https://api.manychat.com${ruta}`, {
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
  const r = await fetch(url, { headers: encabezadosMC() });
  if (!r.ok) throw new Error(`ManyChat GET ${ruta} → ${r.status}: ${await r.text()}`);
  return r.json();
}

export { ttObtener, ttActualizar, ttCrear, mcCrear, mcObtener };
