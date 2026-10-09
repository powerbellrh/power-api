-- Fallos que registran los endpoints (ver lib/registro.js). Correr una vez en Supabase.
-- No guarda datos personales: `referencia` es un id (de contacto, de postulación...) y `detalle` lo que describe el fallo.

create table if not exists eventos (
  id         bigint generated always as identity primary key,
  creado     timestamptz not null default now(),
  origen     text not null,   -- el endpoint: 'conversaciones', 'evaluaciones', ...
  etapa      text not null,   -- qué falló: 'modelo', 'guardrail', 'manychat_envio', ...
  estado     text not null,   -- 'error', 'reintento' o 'rechazado'
  referencia text,            -- a qué se refiere la solicitud (id de contacto de ManyChat, id de postulación...)
  detalle    jsonb not null default '{}'::jsonb
);

create index if not exists eventos_creado_idx on eventos (creado desc);
create index if not exists eventos_origen_etapa_idx on eventos (origen, etapa, creado desc);

-- Solo la API (service role) lee y escribe.
alter table eventos enable row level security;

-- Para no acumular: borrar de vez en cuando lo que tenga más de 90 días.
-- delete from eventos where creado < now() - interval '90 days';
