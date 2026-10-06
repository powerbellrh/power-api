// Reenvía a /historial los webhooks de "enviado a cliente" cuyo registro en `agenda` falló
// (etapa `agenda_registro` con estado `error`), tomando los datos de un export de logs de Vercel.
//
// Uso (después de desplegar la corrección de backfillearPostulacion):
//   node scripts/reenviar_historial_fallidos.js logs.txt                 # solo lista (dry-run)
//   node scripts/reenviar_historial_fallidos.js logs.txt --enviar        # reenvía
//   node scripts/reenviar_historial_fallidos.js logs.txt --enviar --url=https://power-api-alpha.vercel.app/historial
//
// `logs.txt` son líneas tal como las muestra Vercel: `<fecha> [info] {json}`.
// Es seguro repetirlo: en "enviado a cliente" el handler regenera el PowerID y hace
// update/insert en `agenda` sin tocar `estatus`; no dispara WhatsApp.
import { readFileSync } from 'node:fs';

const URL_POR_DEFECTO = 'https://power-api-alpha.vercel.app/historial';

const [archivo, ...banderas] = process.argv.slice(2);
if (!archivo) {
  console.error('Uso: node scripts/reenviar_historial_fallidos.js <logs.txt> [--enviar] [--url=...]');
  process.exit(1);
}
const enviar = banderas.includes('--enviar');
const url    = banderas.find(b => b.startsWith('--url='))?.slice(6) ?? URL_POR_DEFECTO;

const fallidos = new Set();   // candidato_id con agenda_registro en error
const cuerpos  = new Map();   // candidato_id -> último webhook "enviado a cliente"

for (const linea of readFileSync(archivo, 'utf8').split(/\r?\n/)) {
  const inicio = linea.indexOf('{');
  if (inicio === -1) continue;
  let registro;
  try { registro = JSON.parse(linea.slice(inicio)); } catch { continue; }

  if (registro.etapa === 'agenda_registro' && registro.estado === 'error' && registro.candidato_id != null) {
    fallidos.add(String(registro.candidato_id));
  } else if (registro.etapa === 'webhook_recibido') {
    const cuerpo = registro.body;
    if ((cuerpo?.stage_name || '').toLowerCase().trim() === 'enviado a cliente' && cuerpo.candidate?.id != null) {
      cuerpos.set(String(cuerpo.candidate.id), cuerpo);
    }
  }
}

console.log(`${fallidos.size} candidato(s) con error en agenda_registro`);
for (const id of fallidos) {
  const cuerpo = cuerpos.get(id);
  if (!cuerpo) {
    console.log(`  ${id}: sin webhook en el log, no se puede reenviar`);
    continue;
  }
  const etiqueta = `${id} (${cuerpo.candidate.first_name ?? ''}, postulación ${cuerpo.id})`;
  if (!enviar) {
    console.log(`  ${etiqueta}: se reenviaría`);
    continue;
  }
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    console.log(`  ${etiqueta}: HTTP ${resp.status}`);
  } catch (error) {
    console.log(`  ${etiqueta}: error ${error.message}`);
  }
}
if (!enviar && fallidos.size) console.log('\nDry-run: agrega --enviar para reenviar.');
