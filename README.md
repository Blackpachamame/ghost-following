# GitHub Ghost Following

GitHub Ghost Following es una herramienta CLI open source para analizar señales de actividad que GitHub expone oficialmente para las cuentas seguidas por un usuario.

La CLI recupera el `following` público completo mediante la API REST y analiza las cuentas cuyo `type` es `User` mediante la API GraphQL oficial y `ContributionsCollection`. El análisis reciente usa un período UTC configurable, de 365 días por defecto. El contexto histórico es opcional y está desactivado por defecto.

La herramienta mide **actividad visible**, no actividad real ni productividad. Nunca clasifica una cuenta como “ghost” o “inactiva”.

## Requisitos

- Node.js 18 o posterior.
- npm.
- Acceso de red a `api.github.com`.
- `GITHUB_TOKEN` para el análisis GraphQL.

La obtención REST de datos públicos sigue admitiendo requests sin autenticación, pero el flujo completo de la CLI requiere un token porque GitHub GraphQL exige autenticación.

## Instalación

```bash
npm install
npm run build
```

## Uso

Windows PowerShell:

```powershell
$env:GITHUB_TOKEN="your_token_here"
npm run start -- Blackpachamame
```

Bash, macOS o Linux:

```bash
GITHUB_TOKEN="your_token_here" npm run start -- Blackpachamame
```

También se puede ejecutar el build directamente:

```bash
node dist/cli.js Blackpachamame
```

Opciones disponibles:

```text
--days <number>     Activity period in days (default: 365)
--history-years <1-5> Look back up to N years for quiet accounts (default: disabled)
--json <path>       Export full audit as JSON
--csv <path>        Export account audit as CSV
--resume            Resume a compatible saved audit
-h, --help          Show help
```

Ejemplos:

```bash
npm run start -- Blackpachamame --days 180
npm run start -- Blackpachamame --history-years 1
npm run start -- Blackpachamame --history-years 3
npm run start -- Blackpachamame --history-years 5
npm run start -- Blackpachamame --days 180 --resume
npm run start -- Blackpachamame --json reports/audit.json
npm run start -- Blackpachamame --days 180 --json reports/audit.json --csv reports/audit.csv
npm run start -- --help
```

`--days` acepta cualquier entero positivo representable; el valor modifica tanto la query reciente como `Period: last ... days`. Sin `--history-years`, el audit sólo ejecuta recent y realiza cero queries históricas. `--history-years` acepta cualquier entero entre 1 y 5; el lookup comienza inmediatamente antes del período reciente y consulta como máximo esa cantidad de ventanas anuales.

El token sólo se lee desde el entorno y se envía a GitHub en el header de autenticación. No se imprime, solicita interactivamente ni almacena. Los archivos `.env` están ignorados, aunque el proyecto no los carga automáticamente.

Los checkpoints tampoco contienen tokens, headers, respuestas GraphQL crudas ni calendarios completos. Sólo guardan el snapshot de following, el período exacto y resultados de actividad resumidos necesarios para continuar.

Si el token falta, la CLI termina antes de realizar requests:

```text
Activity analysis requires GITHUB_TOKEN.

Set it in your environment before running the analysis.
The token is never stored by this application.
```

## Exportaciones

El reporte terminal siempre se muestra. Si se especifica `--json`, `--csv` o ambos, al finalizar también aparece una sección `Exports` con las rutas escritas. Los directorios padre se crean automáticamente. Un archivo existente en una ruta solicitada explícitamente se sobrescribe; un error de filesystem produce un mensaje claro y un exit code distinto de cero.

### JSON

El JSON representa la auditoría completa sin depender del texto de terminal. Incluye `schemaVersion: 1`, fecha de generación, usuario, período exacto, summary, cuentas elegibles resumidas y rate limits disponibles:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-23T03:07:24.000Z",
  "user": "Blackpachamame",
  "period": {
    "days": 180,
    "from": "2026-02-24T03:07:24.000Z",
    "to": "2026-08-23T03:07:24.000Z"
  },
  "history": {
    "years": 0
  },
  "summary": {
    "followingTotal": 80,
    "eligibleUsers": 78,
    "unsupportedAccounts": 2,
    "active": 48,
    "noRecentVisibleActivity": 30,
    "insufficientVisibility": 0,
    "unknown": 0,
    "coverage": 100
  },
  "accounts": [],
  "rateLimits": {
    "rest": {
      "limit": 5000,
      "remaining": 4998,
      "resetAt": null
    },
    "graphql": {
      "cost": 1,
      "limit": 5000,
      "remaining": 4870,
      "resetAt": "2026-08-23T04:00:00.000Z"
    }
  }
}
```

Los campos no aplicables por cuenta se representan como `null`. Nunca se exportan el token, headers de autenticación, calendarios diarios ni payloads GraphQL crudos.

### CSV

El CSV contiene una fila por cuenta `User` elegible y estas columnas:

```text
login,profile_url,status,period_days,total_contributions,commits,pull_requests,reviews,issues,restricted_contributions,has_activity_in_past,last_visible_activity,historical_lookup_status,history_years
```

Los valores `null` se escriben como campos vacíos. Comas, comillas y saltos de línea se escapan según las reglas de CSV.
La columna aditiva `history_years` se encuentra al final; todas las columnas anteriores conservan su orden histórico.

## Qué se analiza

Para cada cuenta seguida con `type === "User"`, se consulta:

- total oficial de `contributionCalendar.totalContributions`;
- commits;
- issues;
- pull requests;
- reviews de pull requests;
- señal y conteo anonimizado de contribuciones restringidas, cuando GitHub los expone;
- `hasActivityInThePast`, como señal informativa cruda devuelta por GitHub; no se usa para decidir si existe actividad histórica visible.

Las organizaciones y cualquier otro tipo de cuenta quedan fuera del universo elegible. No se aplican heurísticas para bots, machine users o managed users.

El total del calendario se conserva como dato oficial. No se reemplaza por la suma de las subcategorías, ya que GitHub puede contabilizar otras clases de contribución.

## Clasificaciones

### `ACTIVE`

GitHub muestra al menos una contribución durante el período. Puede ser un commit, issue, pull request, review u otra contribución incluida en el total oficial. También incluye actividad privada/restringida si GitHub expone su señal anonimizada.

### `NO_RECENT_VISIBLE_ACTIVITY`

La consulta se completó correctamente y GitHub no mostró contribuciones durante el período. Puede incluir tanto una cuenta sin actividad como una persona cuya actividad privada no sea visible para quien ejecuta la herramienta.

> No recent visible activity does not mean the user is inactive. A developer may be active in private repositories, GitHub Enterprise, another account, or another platform without exposing that activity publicly.

> GitHub does not expose a reliable flag that tells this tool whether a user is hiding private activity. A user with zero visible contributions may still be active privately.

### `UNKNOWN`

La cuenta no pudo evaluarse por un error GraphQL asociado a ella, una respuesta incompleta, datos imposibles de interpretar o un HTTP 502/504 que agotó retries incluso al consultar ese singleton. Es un fallo técnico: no implica inactividad, privacidad ni que esa cuenta haya causado el error. Un error individual recuperable no detiene el análisis de las demás cuentas.

### `INSUFFICIENT_VISIBILITY`

El estado permanece en el dominio, pero esta fase no lo emite porque GitHub no expone una señal oficial fiable para distinguir un perfil público sin actividad visible de un perfil con actividad oculta por su configuración de privacidad. En particular, `userViewType` describe la vista devuelta por GraphQL y no es un detector fiable de la privacidad observada en la interfaz.

No se aplican heurísticas basadas en bio, nombre, repositorios, followers ni contadores en cero. Por eso ambos casos pueden terminar correctamente como `NO_RECENT_VISIBLE_ACTIVITY`.

Las contribuciones privadas sólo se usan como señal cuando la persona habilitó su conteo privado y GitHub expone `hasAnyRestrictedContributions` o `restrictedContributionsCount`. No se obtienen detalles sobre repositorios privados.

## Last visible activity

Cuando se usa `--history-years N`, la herramienta consulta para las cuentas `NO_RECENT_VISIBLE_ACTIVITY` hasta N ventanas históricas explícitas con `ContributionsCollection(from, to)`. Comienza inmediatamente antes del período reciente, sin solaparlo, avanza hacia atrás una ventana anual por vez y se detiene en cuanto encuentra actividad. `hasActivityInThePast` se conserva en reportes y exports como metadata informativa, pero nunca controla este lookup: una ventana explícita puede encontrar actividad visible aunque esa señal sea `false`.

En cada ventana elige la fecha más reciente entre:

- días de `contributionCalendar.weeks` cuyo `contributionCount` sea mayor que cero;
- `latestRestrictedContributionDate`, cuando GitHub expone el conteo privado anonimizado.

La decisión no depende sólo de `totalContributions`: también considera `hasAnyContributions`, `hasAnyRestrictedContributions`, `restrictedContributionsCount` y `latestRestrictedContributionDate`. Si GitHub indica actividad pero no entrega una fecha atribuible, la ventana se considera no interpretable en lugar de inventar un resultado.

El máximo configurable es de 5 años, definido por `MAX_HISTORICAL_LOOKBACK_YEARS`. El lookup distingue estos resultados:

- `FOUND`: encontró una fecha pública o restringida visible;
- `NOT_FOUND_IN_LOOKBACK`: historical fue solicitado y ninguna de las N ventanas consultadas contiene una fecha visible;
- `FAILED`: historical fue solicitado, pero la búsqueda no pudo completarse para esa cuenta;
- `NOT_REQUESTED`: historical no fue solicitado para este audit y no se ejecutó.

Los resultados sin fecha se muestran como `not requested`, `not found in Ny` o `lookup failed`, según corresponda. `NOT_REQUESTED` significa exclusivamente que no se buscó; `NOT_FOUND_IN_LOOKBACK` significa que sí se buscó y no se encontró una contribución visible dentro del alcance configurado. Ninguno demuestra inactividad absoluta: puede existir actividad anterior al lookback, privada o no visible para quien ejecuta la consulta. Historical es contexto complementario; la clasificación `NO_RECENT_VISIBLE_ACTIVITY` depende solamente del período recent.

Reports generados antes de esta corrección pueden contener el valor legacy `NO_PAST_ACTIVITY`. Los checkpoints schema 1 que lo contengan siguen siendo compatibles: `--resume` conserva el resultado recent y vuelve a ejecutar sólo el lookup historical de esa cuenta.

> `Last visible activity` means the most recent contribution activity GitHub exposes to the viewer within the configured historical lookback. It does not prove that the user was inactive after that date.

## Coverage

Coverage mide qué proporción de las cuentas `User` elegibles obtuvo una clasificación evaluable:

```text
(ACTIVE + NO_RECENT_VISIBLE_ACTIVITY) / eligible users × 100
```

`UNKNOWN` e `INSUFFICIENT_VISIBILITY` no cuentan como evaluables. Si no hay cuentas elegibles, el reporte muestra `Coverage: N/A` para evitar una división `0 / 0` engañosa.

## Ejemplo de salida

```text
GitHub Ghost Following

User: Blackpachamame
Period: last 365 days
Historical lookup: disabled

Following
---------
Total: 80
Eligible users: 78
Unsupported/non-user accounts: 2

Activity
--------
Active: 48
No recent visible activity: 30
Insufficient visibility: 0
Unknown: 0

Coverage: 100.0%

Candidates

USERNAME  LAST VISIBLE ACTIVITY  STATUS
new-user  not requested          NO_RECENT_VISIBLE_ACTIVITY
quiet     lookup failed          NO_RECENT_VISIBLE_ACTIVITY
bob       2024-09-17             NO_RECENT_VISIBLE_ACTIVITY

Other activity details

USERNAME  TOTAL  COMMITS  PRS  REVIEWS  ISSUES  RESTRICTED  STATUS
alice     824    710      42   61       11      220         ACTIVE
```

Los candidatos se ordenan por `NOT_REQUESTED`, `NOT_FOUND_IN_LOOKBACK`, `FAILED` y finalmente `FOUND` desde la fecha más antigua hasta la más reciente. El resto se ordena por `INSUFFICIENT_VISIBILITY`, `UNKNOWN` y `ACTIVE`; actualmente el producto no genera el primer estado.

## Cuentas grandes y batching

El análisis reciente agrupa hasta 25 usuarios por request GraphQL mediante aliases y variables seguras:

```text
25 = production default
```

Este tamaño se eligió empíricamente. No es un máximo garantizado por GitHub: pruebas internas con esta query observaron resource limits en tamaños mayores. Si GitHub rechaza aliases concretos con `RESOURCE_LIMIT`, la CLI conserva los aliases utilizables y divide únicamente los fallidos en mitades hasta resolverlos. Por ejemplo, 25 se divide en 12 + 13.

Un batch que agota los tres intentos con HTTP 502 o 504 también se divide secuencialmente por mitades. La reducción afecta sólo a ese grupo y puede repetirse dentro de la rama; el siguiente batch normal vuelve a ser de 25. Un singleton que vuelve a agotar 502/504 termina como `UNKNOWN`, se guarda como completado y no pasa al lookup histórico.

HTTP 503 no activa esta reducción y sigue siendo fatal. Tampoco la activan autenticación, 401, 403, 429, rate limits, errores de transporte agotados, parsing, schema u otros HTTP.

Para 5.000 usuarios elegibles, el barrido reciente requiere aproximadamente 200 requests si todos los batches de 25 funcionan. Es una estimación, no una garantía: fallbacks, cambios de GitHub y errores parciales pueden aumentar el número.

## Checkpoint y resume

Durante una auditoría se guarda:

```text
.ghost-following/checkpoints/<username>.json
```

La escritura captura un snapshot consistente, lo guarda en un temporal único y realiza rename para no reemplazar el último checkpoint válido con contenido parcial. Los commits para un mismo checkpoint se serializan: una versión anterior nunca puede terminar después y reemplazar progreso más nuevo. Se persiste después de cada subconjunto reciente resuelto, incluso una rama de fallback o un singleton `UNKNOWN`, y después de cada cuenta cuyo lookup histórico termina. Así, si una rama posterior falla, `--resume` no vuelve a consultar los aliases ya guardados. Una auditoría completa elimina su checkpoint después de producir el reporte y los exports solicitados.

Una ejecución normal comienza fresca y sobrescribe un checkpoint anterior. Para continuar explícitamente:

```bash
npm run start -- Blackpachamame --days 365 --resume
npm run start -- Blackpachamame --days 180 --resume
npm run start -- Blackpachamame --days 365 --history-years 3 --resume
```

`--resume` reutiliza el período exacto y `historyYears` guardados, y omite usuarios recientes e históricos ya completados. Si se omite `--history-years`, hereda el valor del checkpoint; si se indica, debe coincidir o el resume termina con un error de configuración incompatible. Los checkpoints schema 1 anteriores que no poseen `historyYears` se interpretan como audits legacy de 5 años. Los días solicitados también deben coincidir.

Sin `--resume`, una ejecución siempre es fresca: no reutiliza resultados, no hereda `historyYears` y no compara la configuración con un checkpoint anterior. Los argumentos de la nueva ejecución son la única autoridad.

El following se consulta nuevamente. Si cambió, la CLI informa las cantidades agregadas y eliminadas, conserva resultados de cuentas aún seguidas, analiza las nuevas y excluye del resultado final las removidas.

## Errores, progreso y rate limits

El barrido reciente muestra hitos de progreso sin imprimir una línea por usuario. Un error asociado a una cuenta produce `UNKNOWN` y permite continuar. Un error asociado sólo a la búsqueda histórica conserva `NO_RECENT_VISIBLE_ACTIVITY`, pero deja la fecha desconocida.

Cada request REST o GraphQL que recibe HTTP 502, 503 o 504 se reintenta hasta un máximo de tres intentos totales, con esperas deterministas de 1 y 2 segundos. Un `Retry-After` numérico en esos mismos estados puede reemplazar la espera, limitado internamente a 5 segundos. También se reintentan sólo códigos de transporte explícitamente clasificados como temporales; otros errores de `fetch` siguen siendo fatales sin retry. Los retries son silenciosos y conservan exactamente la misma página REST o query/variables GraphQL.

Para GraphQL, esos tres intentos forman un único presupuesto compartido entre HTTP transitorio, transporte, fallos clasificados durante la lectura del body y JSON sintácticamente inválido. Cada intento reutiliza exactamente la misma query, variables y body serializado, tanto en recent como en historical. Un JSON válido que no cumple el schema esperado sigue siendo fatal sin retry. Si el JSON inválido agota los tres intentos, el audit termina con error y puede continuarse mediante `--resume`; nunca se guarda ni imprime el body recibido.

Esta política no se aplica a 401, 403 ni 429. Tampoco reemplaza el fallback binario de los resource limits GraphQL; ambos mecanismos pueden componerse dentro del mismo árbol sin volver a consultar aliases ya resueltos.

Si un batch reciente agota los tres intentos con HTTP 502 o 504, muestra los logins exactos y reduce sólo ese batch. HTTP 503 sigue terminando la auditoría con error sin dividir. Cada request exacto que agota 502, 503 o 504 agrega una línea JSON independiente, incluso para una rama anidada o un singleton recuperado, en:

```text
.ghost-following/diagnostics/<audit-username>-failures.jsonl
```

El incidente contiene únicamente timestamp, usuario auditado, período recent, status HTTP, intentos y logins del batch. No contiene token, headers, request GraphQL, calendarios ni responses. El archivo es local, acumulativo y está cubierto por el ignore de `.ghost-following/`. Si no puede escribirse, la CLI muestra una advertencia sin cambiar el comportamiento de recuperación o error del audit.

La búsqueda histórica sólo se ejecuta cuando se solicita con `--history-years`. Las ventanas de una misma cuenta se consultan secuencialmente para poder detenerse en el primer resultado; distintas cuentas sí comparten el pool de cuatro workers. Sin el flag se generan cero trabajos y cero queries históricas. Con `--history-years 5` y 30 candidatos, el peor caso teórico sigue siendo de unas 150 queries históricas adicionales.

El coste GraphQL no se presupone; se muestra el último coste observado que GitHub devuelve.

La misma query devuelve `cost`, `limit`, `remaining` y `resetAt`; no se realiza una request adicional para consultar la cuota.

GitHub aplica rate limits independientes a REST y GraphQL. El batching reduce drásticamente las requests recientes, pero el lookup histórico sigue siendo individual y puede consumir una parte importante de la cuota. Cuando GraphQL informa cuota cero, la CLI guarda el progreso, muestra `resetAt`, termina con código no-cero y ofrece el comando `--resume`. No espera automáticamente hasta el reset.

## Troubleshooting de un batch recent

La herramienta `diagnose:recent-batch` es exclusivamente para investigar el último batch recent que agotó retries durante un audit:

```bash
npm run diagnose:recent-batch -- PratikDhanave
npm run diagnose:recent-batch -- --help
```

Lee el último incidente válido de `.ghost-following/diagnostics/<audit-username>-failures.jsonl` y reproduce exactamente sus logins y período con la query recent, cliente GraphQL y retries productivos. No vuelve a consultar el following por REST y no ejecuta historical, exports, checkpoints ni el lifecycle normal del audit.

La investigación siempre prueba primero el batch completo. Sólo un HTTP 502 o 504 agotado lo divide secuencialmente por mitades; un HTTP 503 detiene la investigación como inconclusa. Los `RESOURCE_LIMIT` GraphQL conservan una razón de split separada. Los resultados se guardan como JSON en `.ghost-following/diagnostics/investigations/` sin modificar el JSONL fuente.

Este comando puede consumir cuota GraphQL y está pensado para troubleshooting puntual, no para uso rutinario. Un timeout repetido con un singleton es evidencia para revisión manual: no demuestra que esa cuenta causó el timeout y no identifica perfiles privados.

### Recent query comparison diagnostic

Este experimento de desarrollo compara la query recent productiva (`CURRENT`) con proyecciones `CLASSIFIER_MINIMAL` y `NUMERIC_MINIMAL`, usando los mismos logins, período, retries y shapes fijos del incidente:

```bash
npm run diagnose:recent-query -- PratikDhanave
npm run diagnose:recent-query -- PratikDhanave --timestamp 2026-08-25T01:40:41.234Z
npm run diagnose:recent-query -- PratikDhanave --source archive/pratik/PratikDhanave-failures.jsonl --runs 3
npm run diagnose:recent-query -- --help
```

`--timestamp` selecciona exactamente un incidente, `--source` permite leer un JSONL archivado y `--runs` acepta de 1 a 3 repeticiones (default 1). El comando consume GraphQL real cuando se ejecuta, pero no hace REST, historical, audit, checkpoints ni exports; tampoco modifica la clasificación productiva o el failure JSONL. Ejecuta todo secuencialmente, no aplica adaptive split oculto y guarda un JSON seguro bajo `.ghost-following/diagnostics/query-comparisons/`.

### Recent batch composition probe

El probe experimental de composición/tamaño usa exclusivamente la query recent `CURRENT` sobre un incidente guardado. `FULL` selecciona todo el batch fuente; `LEFT` toma los primeros `floor(N/2)` logins y `RIGHT` el resto. Los nombres de target son case-insensitive y el default es `FULL`.

```bash
npm run diagnose:recent-composition -- PratikDhanave --source ".ghost-following/diagnostics/PratikDhanave-failures.jsonl" --timestamp "2026-08-26T13:36:53.707Z" --target RIGHT --runs 1
npm run diagnose:recent-composition -- --help
```

Por cada run mide el target, sus dos mitades y tres muestras N-1 (`DROP_FIRST`, `DROP_MIDDLE`, `DROP_LAST`). Después desciende sólo por mitades que reproduzcan 502/504 agotado, `RESOURCE_LIMIT` o body inválido. Cada split es una medición observable, no recovery productivo. `--runs` acepta 1 a 3 y `--source` permite leer un JSONL archivado.

El comando puede consumir múltiples requests GraphQL reales. No hace audit, REST, historical, checkpoints ni exports; no cambia producción ni modifica el failure JSONL. Los resultados se guardan bajo `.ghost-following/diagnostics/composition-probes/`. Los outcomes pueden variar por intermitencia del backend, y que un singleton falle no demuestra causalidad individual.

### Recent batch size benchmark

Este benchmark diagnóstico obtiene el following completo por REST una sola vez, filtra `User` y construye una muestra determinista mediante SHA-256. Todos los tamaños procesan exactamente los mismos usuarios, en el mismo orden y durante el mismo período:

```bash
npm run diagnose:recent-batch-sizes -- PratikDhanave --days 365 --sample-size 200 --sizes 6,8,10,12,15,25
npm run diagnose:recent-batch-sizes -- --help
```

Las queries GraphQL `CURRENT` se ejecutan secuencialmente y sin adaptive fallback: un batch agotado permanece fallido para poder medir la confiabilidad cruda del tamaño inicial. No hace historical, checkpoints, resume ni exports productivos, y no modifica `ACTIVITY_BATCH_SIZE` ni el resolver productivo. Los resultados schema 1 se guardan en `.ghost-following/diagnostics/batch-size-benchmarks/`.

La recomendación, cuando existe un tamaño sin processing failures, identifica sólo el mejor throughput observado en esa muestra y ejecución. No establece un tamaño óptimo ni un límite universal de GitHub.

## Desarrollo

```bash
npm run typecheck
npm test
npm run build
```

El diagnóstico temporal se conserva separado del flujo productivo y puede ejecutarse con `npm run diagnose`. Sus campos experimentales no afectan las clasificaciones ni el lookup usado por la CLI.

El proyecto usa `fetch` nativo y no tiene dependencias runtime. Los tests simulan REST y GraphQL y nunca dependen de internet.

### Development benchmark

```bash
npm run benchmark -- Blackpachamame
```

Este comando de desarrollo compara queries individuales con batches GraphQL aliased de tamaños efectivos 5, 10, 25, 30, 35, 40, 45 y 50 sobre una muestra determinista máxima de 50 usuarios elegibles. Procesa cada estrategia secuencialmente y reporta requests HTTP, coste GraphQL directo, coste por usuario, duración, bytes aproximados, éxitos, fallos, errores y cuota restante. El caso batch 1 está representado por la estrategia individual con la misma forma de query aliased.

Los mensajes GraphQL se sanitizan, agrupan y deduplican sin imprimir payloads completos. Las observaciones de mejor coste, latencia y reducción de requests sólo consideran estrategias completamente exitosas; el reporte también identifica el mayor batch exitoso y el primer batch fallido observados en esa ejecución, sin presentarlos como límites generales de GitHub.

El benchmark usa APIs reales, requiere `GITHUB_TOKEN` y consume rate limit. La query inicial usada para mostrar la cuota no se incluye en las métricas de las estrategias. No crea archivos, no forma parte de la CLI pública y no modifica el pipeline productivo.

## Limitaciones actuales

- El período reciente es configurable con `--days` y usa 365 días por defecto.
- Cuando se solicita, `last visible activity` está limitada a lo que GitHub expone mediante `ContributionsCollection` dentro de 1 a 5 años anteriores al comienzo del período reciente; una fecha ausente no significa necesariamente que la cuenta nunca haya contribuido.
- No hay activity score, interfaz web, backend, base de datos, OAuth, caché ni unfollow.
- El lookup histórico sigue procesando cuentas individualmente; sólo el análisis reciente usa batching.
- La actividad privada sólo puede observarse cuando GitHub muestra su conteo anonimizado.
- La herramienta no puede identificar de forma fiable si una persona oculta actividad privada; `userViewType` no se utiliza como señal de privacidad.
- `NO_RECENT_VISIBLE_ACTIVITY` nunca debe interpretarse como inactividad absoluta.

## Próximos pasos

- Batching histórico, sólo si las mediciones posteriores muestran que es necesario.
- Decisiones persistentes mediante KEEP/allowlist.
- Flujo posterior de review.
