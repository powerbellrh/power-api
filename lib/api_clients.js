import { sleep } from './postulacion_utils.js';

const ttHeaders = () => ({
  'Authorization':  `Token token=${process.env.TEAMTAILOR_API_KEY}`,
  'X-Api-Version':  '20240404',
  'Content-Type':   'application/vnd.api+json',
});

const mcHeaders = () => ({
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
});

async function ttGet(path, withDelay = false) {
  if (withDelay) await sleep(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${path}`, { headers: ttHeaders() });
  if (!r.ok) throw new Error(`TeamTailor GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ttPatch(path, body, withDelay = false) {
  if (withDelay) await sleep(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${path}`, {
    method:  'PATCH',
    headers: ttHeaders(),
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`TeamTailor PATCH ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ttPost(path, body, withDelay = false) {
  if (withDelay) await sleep(1000);
  const r = await fetch(`https://api.na.teamtailor.com/v1${path}`, {
    method:  'POST',
    headers: ttHeaders(),
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`TeamTailor POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function mcPost(path, body) {
  const r = await fetch(`https://api.manychat.com${path}`, {
    method:  'POST',
    headers: mcHeaders(),
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ManyChat ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

export { ttGet, ttPatch, ttPost, mcPost };
