# Diccionario de la tabla `registros`

Referencia para quien escriba o lea filas de `registros`: qué significa cada columna, qué valores admite y cómo
se llena en cada endpoint. El código que la aplica está en `lib/registro.js` y `lib/registro_de_endpoint.js`;
si cambia la regla, se cambia aquí y allá.

`registros` es la bitácora de la API: **una fila por operación** y **filas hijas** por los hechos importantes de
esa operación. Es permanente (no se limpia por antigüedad); lo único que borra filas es `/privacidad`.

## Las tres reglas

1. **Sin datos de personas.** Nada del candidato (ni nombre, teléfono, respuestas, edad, sueldo) ni textos de las
   reclutadoras. De la reclutadora solo su id de TeamTailor. Se guardan cifras, identificadores, nombres de campos
   y categorías.
2. **Todas las columnas se llenan**, aunque el dato no aplique al 100 %. Solo quedan vacías tres, porque vacías
   significan algo: `error` (no falló), `id_padre` (no es hija de otra) y `terminado` (sigue en curso).
3. **Los valores son de listas cerradas** (`origen`, `operacion`, `estado`, `tipo_referencia`, `actor` genérico):
   antes de inventar uno nuevo, revisar los de este documento.

## Columnas

| Columna | Qué es | Cómo se llena | Si no aplica |
|---|---|---|---|
| `id` | Consecutivo | Lo pone la base | — |
| `creado` | Cuándo **empezó** la operación | Operación abierta: al abrirla. Evento suelto: el momento en que se anota menos sus `segundos` | Nunca vacío |
| `terminado` | Cuándo terminó | Al cerrar la operación; en un evento suelto, el momento en que se anota | Vacío solo si `estado = 'iniciado'` |
| `origen` | El endpoint o proceso | Ver catálogo | Nunca vacío |
| `operacion` | Qué se hizo, en minúsculas y con guion bajo | Ver catálogo | Nunca vacío |
| `estado` | Cómo acabó | `iniciado`, `ok`, `error`, `omitido`, `reintento`, `rechazado` | Nunca vacío |
| `referencia` | A qué se refiere: un **identificador**, nunca un nombre ni un teléfono | Id de postulación, contacto, candidato o vacante, como texto | El valor de `origen` (ej. `cola`) |
| `tipo_referencia` | Qué clase de identificador es | `postulacion`, `contacto`, `candidato`, `vacante` | `proceso` |
| `id_padre` | La operación a la que pertenece una fila hija | Lo pone el registro cuando hay una operación abierta | Vacío (no es hija) |
| `actor` | Quién la disparó | `cron`, `teamtailor`, `manychat`, `herramientas`, o el id de TeamTailor de la persona | `sistema` (el agente sin id ligado: `reclutador`) |
| `intento` | Número de intento | Evaluación: el intento de la cola. Informes: 1 el informe, 2 la primera corrección, etc. Reintentos del modelo: el suyo | `1` |
| `segundos` | Cuánto duró, con un decimal | Operación abierta: fin menos inicio. Lo demás: lo que mida quien registra | `0` |
| `costo_usd` | Lo que cobraron los modelos | Se suma solo: `lib/openrouter.js` anota el costo de cada llamada (incluye el OCR del PDF) | `0` |
| `error` | El mensaje del fallo | Recortado a 300 caracteres y sin teléfonos ni correos | Vacío (no falló) |
| `detalle` | Las cifras propias de la operación (JSON) | Pasa por el filtro de privacidad (abajo) | `{}` |

### Estados

| Estado | Cuándo |
|---|---|
| `iniciado` | La operación se abrió y no ha cerrado. Si lleva más de unos minutos, se atoró o Vercel la cortó |
| `ok` | Terminó bien. Una herramienta que contesta "no encontré eso" también es `ok` (con `sin_resultado: true`) |
| `error` | Falló. Lleva `error`. Un estado anotado como `error_algo` se guarda como `error` con `motivo: 'algo'` |
| `omitido` | No se hizo a propósito (sin CV, calificación baja, nombre que era un teléfono). Lleva `motivo` |
| `reintento` | Falló pero se va a intentar otra vez (otro motor de PDF, otra vuelta del modelo) |
| `rechazado` | Un guardrail rechazó un mensaje del modelo. Lleva `reglas` |

## Filtro de privacidad de `detalle`

Lo aplica `filtrarDetalle` a todo lo que se guarda; lo que no pasa se descarta sin avisar.

- **Pasan siempre:** números, booleanos y `null`.
- **Identificadores:** un texto bajo una clave que es `id`, empieza con `id_` o termina en `_id` / `_ids`, si no
  tiene espacios y mide hasta 64 caracteres.
- **Textos:** solo bajo estas claves, de hasta 80 caracteres y sin teléfonos ni correos:
  `modelo`, `proveedor`, `motor`, `actividad`, `herramienta`, `etapa`, `paso`, `flujo`, `motivo`, `razon`, `reglas`,
  `tipo`, `cierre`, `decision`, `accion`, `filtro`, `clave`, `campo`, `campos`, `categoria`, `cambio`, `intenciones`,
  `material`, `operacion`, `origen`, `problemas_de`, `periodo`, `agrupar_por`, `grafica`, `efectos`, `cliente`,
  `foto`, `recurso`, `fuente`.
- **`pedido`:** hasta 160 caracteres. Es la frase con la que un modelo describe, sin datos de nadie, lo que pidió
  una reclutadora (`lib/descripcion_de_texto.js` le quita cifras, nombres conocidos y mayúsculas a media frase).
- Listas de hasta 60 elementos y objetos de hasta 4 niveles, con las mismas reglas.

El filtro no sabe si un número es personal: **quien registra no debe mandar una edad, un sueldo ni un teléfono
como número.** Sí se guarda la calificación de la evaluación (decisión tomada el 10-oct-2026).

Para agregar una clave de texto nueva: tiene que describir la operación, no a una persona, y tener pocos valores
posibles. Se agrega a `CLAVES_DE_TEXTO` en `lib/registro.js` y a la lista de arriba.

## Catálogo: qué fila deja cada cosa

`ref` = `referencia` / `tipo_referencia`. Las hijas heredan origen, referencia y actor de su operación.

| `origen` | `operacion` | Fila | `ref` | `actor` | `detalle` |
|---|---|---|---|---|---|
| `recepcion` | `postulacion_recibida` | Una por postulación que manda TeamTailor | postulación | `teamtailor` | `vacante_id`, `codigo`; si se descartó: `motivo` |
| `cola` | `corrida` | Solo cuando procesó algo o falló | `cola` / `proceso` | `cron` | `encontrados`, `enviados`, `fallidos`, `evaluaciones`, `reevaluaciones`. **Cuántas, nunca cuáles** |
| `evaluaciones` | `evaluacion` | Abierta al empezar, se cierra al terminar | postulación | `cron` | `tipo` (AD/OP), `vacante_id`, `del_chatbot`, `modelo`, `proveedor`, `motor`, `con_cv`, `con_imagen`, `tokens_entrada`, `tokens_salida`, `calificacion`, `estrellas`, `preguntas`, `whatsapp_enviado`; si falló: `etapa`, `se_reintentara`, `no_procesable` |
| `evaluaciones` | `reevaluacion` | Igual que la anterior | postulación | `cron` | Lo mismo más `calificacion_anterior` |
| `evaluaciones` | `whatsapp` | Hija: preguntas de seguimiento | (hereda) | (hereda) | `preguntas`, `motivo` (`origen_chatbot`, `calificacion_baja`, `sin_preguntas`, `sin_telefono`, `manychat`) |
| `evaluaciones` | `motor_pdf` | Hija, `reintento`: un motor de PDF falló y se probó otro | (hereda) | (hereda) | `motor` |
| `informes` | `informe` | Abierta al empezar | postulación | id de la reclutadora (o `herramientas`) | `tipo`, `vacante_id`, `cliente`, `foto`, `inbox`, `con_cv`, `llamadas[]`, `material{}`, `forma{}`, `cumplimiento{}` |
| `informes` | `correccion` | Igual; `intento` = ronda + 1 | postulación | igual | Lo mismo más `ronda`, `comentario_largo`, `minutos_desde_anterior`, `cambios[]` (`campo`, `cambio`, `parecido`), `descripcion{}` (`categoria`, `para_sistemas`, `pedido`) |
| `reclutador` | `turno` | Abierta por cada mensaje de una reclutadora al agente | contacto | id de la reclutadora (o `reclutador`) | `mensaje_largo`, `vueltas`, `herramientas`, `accion`, `graficas`, `descripcion{}` |
| `reclutador` | `herramienta` | Hija, una por herramienta usada | (hereda) | (hereda) | `herramienta`, `reutilizada`, `sin_resultado` y solo estos argumentos: `id`, `filtro`, `tipo`, `recurso`, `periodo`, `agrupar_por`, `con_etapas`, `solo_mias`, `incluir_rechazados` |
| `reclutador` | `vacante_creada` | Hija | (hereda) | (hereda) | `vacante_id`, `tipo`, `cliente` |
| `reclutador` | `accion` | Hija: editar, cerrar o mover candidatos | (hereda) | (hereda) | `tipo`, `id`, `personas`, `acciones` |
| `reclutador` | `retroalimentacion` | Hija: comentario para sistemas | (hereda) | (hereda) | `largo`, `categoria`, `pedido`. **Nunca el comentario** |
| `reclutador` | `contexto_reiniciado`, `contexto_compactado` | Hijas | (hereda) | (hereda) | Solo cifras (líneas, caracteres, probabilidad) |
| `conversaciones` | `modelo`, `guardrail` y otros | Chatbot de candidatos: **solo fallos**, no una fila por mensaje | contacto | `manychat` | `herramienta`, `paso`, `reglas`, `clave` |
| `historial` | `cambio_de_etapa` | Solo las etapas que se atienden (o fallan) | postulación | `teamtailor` | `etapa`, `vacante_id`, `codigo` |
| `notificaciones` | `envio_de_agenda` | Solo cuando mandó algo o falló | `notificaciones` / `proceso` | `cron` | `encontradas`, `enviadas`, `fallidas`, `codigo` |
| `experiencia` | `experiencia` | Una por archivo que manda un candidato | candidato | `manychat` | `codigo` |
| `emparejamiento` | `emparejamiento` | Una por consulta | vacante (si viene) | `manychat` | `vacante_id`, `coincidencias`, `uso_ia`, `codigo` |
| `estudios` | `estudio` | Abierta al empezar | `estudios` / `proceso` | `herramientas` | `fuente`, `muestra`, `codigo` |
| `sincronizar_vacantes` | `sincronizacion` | Una por corrida (cada hora) | `sincronizar_vacantes` / `proceso` | `cron` | Las cifras del resumen (`revisadas`, `nuevas`, `actualizadas`, `cerradas`, `errores`...) |
| `privacidad` | `eliminacion` | Solo cuando de verdad se borraron datos (o falló) | `privacidad` / `proceso`. **Nunca el id del candidato** | `teamtailor` | `eliminados{}`: cuántas filas de cada tabla |

Además, cualquier módulo puede dejar un fallo suelto (`error`, `reintento`, `rechazado`) con el nombre del paso
que falló como `operacion` (`manychat_envio`, `respuesta_teamtailor`, `imagen_vacante`, `agente_reclutador`...).
Queda como hija si hay una operación abierta.

## Privacidad: qué se borra

`/privacidad` borra de `registros` las filas cuya referencia sea una postulación, el contacto de ManyChat o el
candidato de quien pide la baja. Por eso:

- La referencia de una persona va **siempre** en `referencia` con su `tipo_referencia`, nunca dentro de `detalle`.
- Nunca varios identificadores juntos en una referencia (ej. una lista de postulaciones): no se podrían encontrar.

## Cómo registrar algo nuevo

- **Un endpoint que contesta con `res.status().json()`:** envolver el handler con `conRegistro` y dar `origen`,
  `operacion`, `actor`, `referencia(req)`, `tipoReferencia` y un `resumen` con cifras. Si se llama muchas veces sin
  hacer nada, `guardarSi`. Si tarda minutos, `desdeElInicio: true`.
- **Trabajo en segundo plano o con pasos:** `crearRegistro(...)`, `registro.ejecutar(...)` y dentro
  `registro.abrir(supabase, operacion, datos)` → `operacion.cerrar(estado, datos)`.
- **Un hecho dentro de una operación:** `log(nombre, { estado, guardar: true, ...cifras })`; los fallos se guardan
  solos. Desde un módulo que no recibe el registro: `registrar(...)`, `contar(...)`, `abrirOperacion(...)`.
- **La cola** (`api/cola.js`) inserta su fila a mano y con el mismo criterio; no se le agrega nada más.

Antes de dar por bueno un registro nuevo: escribir una fila de prueba, leerla y comprobar que no trae nada de una
persona y que todas las columnas quedaron llenas.

## Consultas útiles

```sql
-- Qué ha pasado, por tipo
select origen, operacion, estado, count(*), round(avg(segundos), 1) as seg, sum(costo_usd) as costo, max(creado) as ultima
from registros group by 1, 2, 3 order by ultima desc;

-- Lo que falló o se quedó atorado
select id, creado, origen, operacion, estado, referencia, error, detalle
from registros
where estado = 'error' or (estado = 'iniciado' and creado < now() - interval '10 minutes')
order by id desc limit 50;

-- Todo lo de una postulación, con sus hijas
select id, id_padre, creado, origen, operacion, estado, intento, segundos, costo_usd, detalle
from registros where tipo_referencia = 'postulacion' and referencia = '13405037' order by id;

-- Costo por día y por origen
select date_trunc('day', creado) as dia, origen, count(*), sum(costo_usd) as costo
from registros where id_padre is null group by 1, 2 order by 1 desc, 4 desc;
```
