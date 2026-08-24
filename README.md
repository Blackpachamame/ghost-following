# GitHub Ghost Following

GitHub Ghost Following es una herramienta CLI open source para analizar señales de actividad que GitHub expone oficialmente para las cuentas seguidas por un usuario.

La CLI recupera el `following` público completo mediante la API REST y analiza las cuentas cuyo `type` es `User` mediante la API GraphQL oficial y `ContributionsCollection`. El análisis reciente usa un período UTC configurable, de 365 días por defecto, y busca de forma limitada la última contribución visible de los candidatos sin actividad reciente.

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
--json <path>       Export full audit as JSON
--csv <path>        Export account audit as CSV
--resume            Resume a compatible saved audit
-h, --help          Show help
```

Ejemplos:

```bash
npm run start -- Blackpachamame --days 180
npm run start -- Blackpachamame --days 180 --resume
npm run start -- Blackpachamame --json reports/audit.json
npm run start -- Blackpachamame --days 180 --json reports/audit.json --csv reports/audit.csv
npm run start -- --help
```

`--days` acepta cualquier entero positivo representable; el valor modifica tanto la query reciente como `Period: last ... days`. El lookup histórico comienza inmediatamente antes del período reciente y mantiene su límite independiente de cinco años.

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
login,profile_url,status,period_days,total_contributions,commits,pull_requests,reviews,issues,restricted_contributions,has_activity_in_past,last_visible_activity,historical_lookup_status
```

Los valores `null` se escriben como campos vacíos. Comas, comillas y saltos de línea se escapan según las reglas de CSV.

## Qué se analiza

Para cada cuenta seguida con `type === "User"`, se consulta:

- total oficial de `contributionCalendar.totalContributions`;
- commits;
- issues;
- pull requests;
- reviews de pull requests;
- señal y conteo anonimizado de contribuciones restringidas, cuando GitHub los expone;
- `hasActivityInThePast`, para saber si GitHub afirma que existe actividad anterior al período consultado.

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

La cuenta no pudo evaluarse por un error GraphQL asociado a ella, una respuesta incompleta o datos imposibles de interpretar. Un error individual no detiene el análisis de las demás cuentas.

### `INSUFFICIENT_VISIBILITY`

El estado permanece en el dominio, pero esta fase no lo emite porque GitHub no expone una señal oficial fiable para distinguir un perfil público sin actividad visible de un perfil con actividad oculta por su configuración de privacidad. En particular, `userViewType` describe la vista devuelta por GraphQL y no es un detector fiable de la privacidad observada en la interfaz.

No se aplican heurísticas basadas en bio, nombre, repositorios, followers ni contadores en cero. Por eso ambos casos pueden terminar correctamente como `NO_RECENT_VISIBLE_ACTIVITY`.

Las contribuciones privadas sólo se usan como señal cuando la persona habilitó su conteo privado y GitHub expone `hasAnyRestrictedContributions` o `restrictedContributionsCount`. No se obtienen detalles sobre repositorios privados.

## Last visible activity

Sólo para cuentas clasificadas como `NO_RECENT_VISIBLE_ACTIVITY` y con `hasActivityInThePast === true`, la herramienta consulta ventanas históricas explícitas con `ContributionsCollection(from, to)`. Comienza inmediatamente antes del período reciente, sin solaparlo, avanza hacia atrás una ventana anual por vez y se detiene en cuanto encuentra actividad. Si `hasActivityInThePast === false`, no realiza ninguna consulta histórica.

En cada ventana elige la fecha más reciente entre:

- días de `contributionCalendar.weeks` cuyo `contributionCount` sea mayor que cero;
- `latestRestrictedContributionDate`, cuando GitHub expone el conteo privado anonimizado.

La decisión no depende sólo de `totalContributions`: también considera `hasAnyContributions`, `hasAnyRestrictedContributions`, `restrictedContributionsCount` y `latestRestrictedContributionDate`. Si GitHub indica actividad pero no entrega una fecha atribuible, la ventana se considera no interpretable en lugar de inventar un resultado.

El lookback es de 5 años, definido por `HISTORICAL_LOOKBACK_YEARS`. El lookup distingue estos resultados:

- `FOUND`: encontró una fecha pública o restringida visible;
- `NOT_FOUND_IN_LOOKBACK`: GitHub afirma actividad pasada, pero ninguna de las cinco ventanas contiene una fecha visible;
- `NO_PAST_ACTIVITY`: GitHub afirma que no hay actividad anterior y no se consultan ventanas;
- `FAILED`: falló la búsqueda histórica de esa cuenta.

Los dos últimos resultados sin fecha se muestran como `no past activity`, `not found in 5y` o `lookup failed`, según corresponda. Un fallo histórico conserva el estado principal `NO_RECENT_VISIBLE_ACTIVITY`.

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

USERNAME  LAST VISIBLE ACTIVITY  PAST ACTIVITY  STATUS
new-user  no past activity       no             NO_RECENT_VISIBLE_ACTIVITY
quiet     not found in 5y        yes            NO_RECENT_VISIBLE_ACTIVITY
bob       2024-09-17             yes            NO_RECENT_VISIBLE_ACTIVITY

Other activity details

USERNAME  TOTAL  COMMITS  PRS  REVIEWS  ISSUES  RESTRICTED  STATUS
alice     824    710      42   61       11      220         ACTIVE
```

Los candidatos sin actividad pasada aparecen primero, seguidos por los que tienen actividad pasada no encontrada dentro del lookback, los lookups fallidos y finalmente las fechas desde la más antigua hasta la más reciente. El resto se ordena por `INSUFFICIENT_VISIBILITY`, `UNKNOWN` y `ACTIVE`; actualmente el producto no genera el primer estado.

## Cuentas grandes y batching

El análisis reciente agrupa hasta 25 usuarios por request GraphQL mediante aliases y variables seguras:

```text
25 = production default
```

Este tamaño se eligió empíricamente. No es un máximo garantizado por GitHub: pruebas internas con esta query observaron resource limits en tamaños mayores. Si GitHub rechaza un batch por límites de recursos o complejidad, la CLI conserva los aliases utilizables y divide únicamente los fallidos en mitades hasta resolverlos. Por ejemplo, 25 se divide en 12 + 13. Un fallo individual definitivo produce `UNKNOWN`.

Los errores de autenticación, token inválido, rate limit global, HTTP global o schema no activan esa división. La CLI aborta con código distinto de cero.

Para 5.000 usuarios elegibles, el barrido reciente requiere aproximadamente 200 requests si todos los batches de 25 funcionan. Es una estimación, no una garantía: fallbacks, cambios de GitHub y errores parciales pueden aumentar el número.

## Checkpoint y resume

Durante una auditoría se guarda:

```text
.ghost-following/checkpoints/<username>.json
```

La escritura usa un archivo temporal y rename para no reemplazar el último checkpoint válido con contenido parcial. Se persiste después de cada batch reciente resuelto y después de cada cuenta cuyo lookup histórico termina. Una auditoría completa elimina su checkpoint después de producir el reporte y los exports solicitados.

Una ejecución normal comienza fresca y sobrescribe un checkpoint anterior. Para continuar explícitamente:

```bash
npm run start -- Blackpachamame --resume
npm run start -- Blackpachamame --days 180 --resume
```

`--resume` reutiliza el período exacto guardado y omite usuarios recientes e históricos ya completados. Los días solicitados deben coincidir; un checkpoint de 365 días no puede reanudarse con `--days 180`.

El following se consulta nuevamente. Si cambió, la CLI informa las cantidades agregadas y eliminadas, conserva resultados de cuentas aún seguidas, analiza las nuevas y excluye del resultado final las removidas.

## Errores, progreso y rate limits

El barrido reciente muestra hitos de progreso sin imprimir una línea por usuario. Un error asociado a una cuenta produce `UNKNOWN` y permite continuar. Un error asociado sólo a la búsqueda histórica conserva `NO_RECENT_VISIBLE_ACTIVITY`, pero deja la fecha desconocida.

La búsqueda histórica se ejecuta únicamente para candidatos sin actividad reciente cuyo `hasActivityInThePast` sea verdadero. Las ventanas de una misma cuenta se consultan secuencialmente para poder detenerse en el primer resultado; distintas cuentas sí comparten el pool de cuatro workers. Se generan como máximo 5 queries adicionales por candidato y ninguna cuando la señal de actividad pasada es falsa. Con 30 candidatos, el peor caso teórico es de unas 150 queries históricas adicionales.

El coste GraphQL no se presupone; se muestra el último coste observado que GitHub devuelve.

La misma query devuelve `cost`, `limit`, `remaining` y `resetAt`; no se realiza una request adicional para consultar la cuota.

GitHub aplica rate limits independientes a REST y GraphQL. El batching reduce drásticamente las requests recientes, pero el lookup histórico sigue siendo individual y puede consumir una parte importante de la cuota. Cuando GraphQL informa cuota cero, la CLI guarda el progreso, muestra `resetAt`, termina con código no-cero y ofrece el comando `--resume`. No espera automáticamente hasta el reset.

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
- `last visible activity` está limitada a lo que GitHub expone mediante `ContributionsCollection` dentro de cinco años anteriores al comienzo del período reciente; una fecha ausente no significa necesariamente que la cuenta nunca haya contribuido.
- No hay activity score, interfaz web, backend, base de datos, OAuth, caché ni unfollow.
- El lookup histórico sigue procesando cuentas individualmente; sólo el análisis reciente usa batching.
- La actividad privada sólo puede observarse cuando GitHub muestra su conteo anonimizado.
- La herramienta no puede identificar de forma fiable si una persona oculta actividad privada; `userViewType` no se utiliza como señal de privacidad.
- `NO_RECENT_VISIBLE_ACTIVITY` nunca debe interpretarse como inactividad absoluta.

## Próximos pasos

- Batching histórico, sólo si las mediciones posteriores muestran que es necesario.
- Decisiones persistentes mediante KEEP/allowlist.
- Flujo posterior de review.
