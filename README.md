# Codex meets Claude — 0.4.0

Puente MCP con un servicio persistente en WSL/Linux entre Claude Code, Codex y OpenCode: cada cliente delega en los otros dos. Claude usa Claude Agent SDK; Codex conserva codex exec en solo lectura; OpenCode usa el servicio HTTP local (opencode serve) mediante @opencode/client. Los clientes de Windows y WSL comparten cola, trabajos y resultados.

## Uso diario

Los registros instalados llaman a src/launch.js. El lanzador arranca agent-bridge.service bajo demanda; no necesitas abrir una terminal de Ubuntu. Puedes cerrar el cliente y reconectar: los trabajos del servicio siguen ejecutándose. Los clientes abiertos antes de actualizar conservan su servidor antiguo; termina esos trabajos antes de reiniciarlos.

Cada cliente recibe las herramientas de los otros dos proveedores: Claude Code, codex_* y opencode_*; Codex, claude_* y opencode_*; OpenCode, claude_* y codex_*.

- claude_start / codex_start / opencode_start: prompt y cwd absolutos; devuelven un ID durable con estado queued.
- claude_status / codex_status / opencode_status: consultar ID; estados queued, running, completed, failed, cancelled, timed_out o interrupted.
- claude_list_jobs / codex_list_jobs / opencode_list_jobs: páginas de resúmenes con after, limit, jobs, nextCursor y hasMore. status contiene el resultado completo.
- claude_events / opencode_events: eventos paginados por jobId, after y limit; truncated indica historial descartado.
- claude_cancel / codex_cancel / opencode_cancel: cancelar en cola o solicitar cancelación activa; finishedAt confirma limpieza.
- claude_diagnostics / codex_diagnostics / opencode_diagnostics: estado del servicio, límites, disponibilidad de ejecutables, retenciones de OpenCode (unrecovered), worktrees y versiones de OpenCode. No ejecuta inferencia ni comprueba autenticación.
- opencode_cleanup: elimina un worktree de trabajo (ver OpenCode).

Usa requestId estable para reintentar una solicitud sin duplicarla. Una clave con argumentos diferentes da error. La deduplicación dura mientras se conserve el trabajo en el historial; una solicitud nueva sin clave no se considera un reintento.

Para continuar, inicia otro trabajo con sessionId, o con parentJobId y un nuevo prompt en el mismo cwd. Nunca se reejecuta automáticamente un trabajo interrumpido: revisa los cambios que pudo haber hecho antes de retomarlo. Una conversación persistida no es un respaldo de archivos ni de procesos.

Claude admite permissionMode: plan (predeterminado) o acceptEdits, model, maxTurns (50 por defecto) y maxBudgetUsd. Las solicitudes de permisos adicionales se deniegan y se muestran en permissionDenials. No hay aprobación interactiva en esta versión. El presupuesto es una estimación del SDK. Se deshabilitan herramientas MCP del delegado; las reglas, skills y hooks locales de Claude siguen siendo relevantes. Codex permanece en solo lectura.

## OpenCode

opencode_start admite prompt, cwd, sessionId, model (providerID/modelID, con #variante opcional; sin él se usa el modelo predeterminado del usuario), level y worktree. Cada trabajo es un turno de una sesión OpenCode en el servicio compartido de OpenCode, con eventos en vivo en opencode_events. Una solicitud de permiso sin responder bloquearía al delegado: se rechaza siempre (nunca "always", que persistiría una aprobación) y aparece en permissionDenials. Para continuar usa parentJobId o sessionId: solo se reanudan sesiones creadas por el puente (llevan la marca agentbridge en su metadata) y con el mismo level con el que nacieron, que hay que repetir porque el valor por defecto es read-only; una sesión reanudada conserva las reglas que tenía y nunca se reescriben. Una sesión trabaja siempre en el directorio donde se creó (un prompt no lo cambia), así que reanudarla desde otro cwd se rechaza; un sessionId sin parentJobId sigue al último trabajo que ejecutó esa sesión, con su cwd, su bloqueo y su worktree.

El puente se conecta a un servicio OpenCode que ya esté en marcha y nunca arranca uno: uno arrancado desde agent-bridge.service viviría en su cgroup y moriría, con los turnos interactivos del usuario, en cada reinicio del puente. Si no hay ninguno, el trabajo falla con un mensaje que pide arrancar OpenCode (abrirlo, u opencode serve --service).

El nivel de permisos (level) lo define el puente como reglas de la sesión, no OpenCode:

- read-only (predeterminado): read, glob, grep y skill. Todo lo demás se deniega: edit, shell, red y subagentes.
- edit: lo anterior más edit. shell sigue denegado.
- build: todo permitido, shell y red incluidos, salvo subagentes. Úsalo con worktree.

read-only y edit deniegan shell porque una redirección de shell escribe archivos sin pasar por la herramienta de edición: permitirlo anularía el nivel. En los tres niveles se deniegan además subagent (no está medido que una sesión hija herede las reglas de la sesión, y sin ellas podría llamar a agentbridge_*), agentbridge_* (el delegado no vuelve a llamar al puente), question, external_directory y la lectura de .env y .env.* (salvo .env.example). Nada se deja en ask, porque un ask no puede responderse en un trabajo delegado.

La configuración propia de OpenCode (opencode.json global, de los directorios ancestros y del proyecto, y las reglas agents.<id>.permissions del agente con que corre la sesión) estrecha un nivel, pero un nivel nunca se ensancha más allá de un deny de esa configuración: OpenCode, por sí solo, deja ganar a las reglas de sesión sobre un deny global (medido en 2.2.5), así que el puente reemite los deny de la configuración tras sus reglas y, en su orden, repite sus allow/ask. Un ask de la configuración se trata como allow en esa repetición, que solo restituye lo que el nivel ya concede en esa región y nunca más. Si la configuración deniega todo lo que el nivel permitiría, el trabajo falla con ese error en lugar de lanzar un delegado inútil. La sesión corre con el agente default_agent de la configuración (build si no hay), pasado explícitamente, y se repiten las reglas ya resueltas de ese agente, que OpenCode devuelve en su orden: predeterminadas, cada archivo de configuración de menor a mayor precedencia (medido en 2.2.5) y por último las del agente. En un trabajo con worktree la configuración se lee en el cwd de origen, no en el worktree, para que sigan aplicando los opencode.json de los ancestros y un .opencode/ ignorado por git, que el worktree no tiene.

Con worktree: true el trabajo se ejecuta en un git worktree propio del puente:

- Se crea desde HEAD en <estado>/worktrees/<jobId>, rama bridge/<jobId>, y el delegado trabaja en la misma subruta que cwd. Se rechaza si cwd no es un repositorio Git o si el checkout de origen tiene cambios sin confirmar (archivos sin seguimiento incluidos); el directorio de estado no puede estar dentro del repositorio. Worktrees distintos no comparten bloqueo, así que pueden editar a la vez.
- El resultado trae worktree: id, branch, path, changedFiles (como mucho 200), changedCount, truncated y removed. Un directorio ignorado (node_modules/, un venv, target/) cuenta como una sola entrada. opencode_list_jobs omite changedFiles. Si la vista final no cabe en el almacenamiento, se guarda sin la lista de archivos y, si aún no cabe, con el resultado recortado, en vez de detener el servicio.
- Al terminar se elimina solo si se demuestra limpio: sin cambios, sin archivos sin seguimiento ni ignorados nuevos, sin commits que no estén en otra rama, y siempre que el trabajo no esté interrumpido, retenido ni compartido con otro. Un worktree con trabajo no se elimina nunca de forma automática, y nunca se fusiona: revisa la rama bridge/<jobId> y fusiónala tú.
- opencode_cleanup({worktreeId, discard}) es la eliminación explícita; worktreeId está en la vista del trabajo y en diagnostics. Se niega mientras un trabajo lo use, y si hay cambios o commits sin otro respaldo exige discard: true, que los borra junto con la rama.
- Reanudar con parentJobId, o con el sessionId de un trabajo con worktree, reutiliza el mismo worktree (se rechaza si ya no existe, en vez de ejecutar en otro directorio). Una sesión sin worktree no puede reanudarse dentro de uno nuevo.

Un trabajo OpenCode cuyo abort no pudo confirmarse (el servicio no respondió a tiempo, o el servicio del puente se detuvo con la sesión en curso y no pudo comprobarse al volver) queda retenido: conserva su proyecto y su sesión, su worktree no se elimina y el historial no lo descarta. diagnostics.unrecovered cuenta estas retenciones. opencode_cancel sobre él reintenta el abort y lo libera si el servicio registrado lo confirma, o si responde que no conoce la sesión (SessionNotFoundError, comprobado en 2.2.5), pues entonces no puede haber un delegado en marcha. Con force: true se libera sin prueba y queda openCode.interrupt: 'forced' (frente a 'confirmed' o 'unconfirmed'); el delegado podría seguir editando.

El cliente @opencode/client está fijado a 2.x (^2.2.5, 2.2.5 en package-lock.json) y se acepta cualquier servicio 2.x. diagnostics.opencode informa status (ready, incompatible si el servicio no es 2.x, unreachable si no responde o no existe), serviceVersion y clientVersion. El sondeo no arranca el servicio, dura como máximo 500 ms y solo informa: no bloquea trabajos ni impide usar Claude o Codex. Los jobs de OpenCode comparten el límite global de cuatro ejecuciones.

## Instalación WSL

Requiere Node >=22.13, systemd de usuario, git, los CLI de Claude y Codex autenticados y ejecutables en ~/.local/bin (o CLAUDE_COMMAND/CODEX_COMMAND explícitos); OpenCode es opcional para instalar. node:sqlite es experimental en Node 22; no necesita un módulo nativo adicional.

Desde este repositorio en Linux:

~~~bash
npm ci --omit=optional
node scripts/install-service.js
node scripts/configure-clients.js "$(command -v node)" "$PWD"
node src/launch.js status
~~~

Se reutiliza el Claude Code instalado mediante pathToClaudeCodeExecutable. La instalación del servicio no reinicia trabajos activos. Si cambias el código o la unidad de un servicio ya activo, reinícialo cuando su cola esté vacía.

En Windows, ejecuta con Node nativo scripts/configure-clients.js pasando las rutas LINUX de Node y del repositorio, y opcionalmente la distro:

~~~powershell
node scripts/configure-clients.js /ruta/linux/a/node /ruta/linux/al/repositorio Ubuntu
~~~

El comando registra wsl.exe → Node Linux → launch.js para los tres clientes. El argumento de launch.js es el cliente que se registra (claude, codex u opencode) y cada cliente recibe las herramientas de los otros dos. Actualiza solo claude-bridge en Codex, codex-bridge en Claude y agentbridge bajo mcp.servers en ~/.config/opencode/opencode.json (o $XDG_CONFIG_HOME/opencode); cada cambio genera un único respaldo de esas tres entradas en ~/.agent-bridge-backups. No copia la configuración de cuenta ni credenciales.

El nombre agentbridge, sin guion, es obligatorio: los niveles de permiso de OpenCode deniegan agentbridge_<herramienta> para que un delegado no vuelva a llamar al puente. Si ~/.config/opencode contiene opencode.jsonc con comentarios, el comando se niega a reescribirlo (los comentarios no se recuperarían con el rollback); añade a mano la entrada o quita los comentarios. OpenCode no necesita reiniciarse: vigila sus archivos de configuración y, tras guardar, recarga agentes, comandos, skills, servidores MCP y plugins (/reload fuerza la recarga a mano); Claude Code y Codex sí necesitan reiniciarse para ver el cambio. El archivo de OpenCode se reescribe como JSON re-serializado: se conservan contenido, orden de claves e indentación, pero no el formato original (p. ej. un array en una línea pasa a varias), y el rollback tampoco lo restaura.

Quien actualice desde una versión con dos clientes debe volver a ejecutar scripts/configure-clients.js: el argumento de launch.js ahora nombra al cliente, no al proveedor que sirve (Codex arrancaba launch.js claude), así que un registro antiguo ofrece a cada cliente sus propias herramientas y no las de los otros. Hasta entonces el puente avisa por stderr en initialize cuando el cliente es Claude Code o Codex y el registro no coincide; OpenCode no tiene registros antiguos y no se compara. La instalación del servicio comprueba OPENCODE_COMMAND (por defecto ~/.opencode/bin/opencode) solo para avisar en stderr si falta, y continúa; no lo guarda en la unidad, porque el servicio nunca arranca OpenCode.

Rollback, con el Node del sistema donde cambiaste las configuraciones:

~~~bash
node scripts/configure-clients.js rollback /ruta/al/respaldo.json
~~~

El rollback restaura solo esas entradas y se niega a pisar cambios posteriores en ellas. Los cambios ajenos permanecen. src/server.js conserva el modo anterior de ejecución dentro del proceso MCP.

## Operación y límites

~~~bash
node src/launch.js status
systemctl --user status agent-bridge.service
journalctl --user -u agent-bridge.service -n 50
systemctl --user stop agent-bridge.service
systemctl --user restart agent-bridge.service
~~~

Un nuevo cliente vuelve a arrancar el servicio detenido. Parar WSL o Windows interrumpe ejecuciones. systemd elimina procesos hijos al detener/reiniciar; el siguiente arranque marca los trabajos activos interrupted. Los trabajos que nunca comenzaron permanecen en cola.

- Cuatro ejecuciones globales y 100 solicitudes en cola; exceso de cola devuelve error.
- Una ejecución por raíz Git y una por sesión/proveedor. Subdirectorios comparten bloqueo; worktrees distintos no. Fuera de Git se usa el cwd real.
- Los bloqueos coordinan solo este puente, no terminales ni agentes externos.
- Plazo de ejecución: 60 minutos, separado del tiempo de espera en cola.
- Historial: 1000 trabajos terminados o 30 días; limpieza al arrancar y terminar trabajos.
- 256 eventos recientes por trabajo; cada mensaje SDK/JSONL se limita a 4 MB. La salida acumulada de muchos mensajes pequeños no corta el trabajo. Los resultados individuales siguen limitados.
- Páginas de hasta 100 entradas. No se almacena razonamiento ni argumentos de herramientas.

SQLite y socket privados están en ~/.local/state/agent-bridge. No coloques la base en una unidad Windows o UNC. El servicio acepta rutas Linux, unidades locales Windows y UNC de su propia distro, y las resuelve a Linux. Rechaza otras distros/recursos de red.

Para cambiar límites usa un override de systemd con Environment=BRIDGE_MAX_ACTIVE=..., BRIDGE_MAX_QUEUED=..., BRIDGE_TIMEOUT_MS=...; aplica el cambio con la cola vacía. BRIDGE_STATE_DIR cambia almacenamiento/socket y debe coincidir en servidor y fachadas. Borrar el estado elimina historial y deduplicación.

## Skills y plugins

plugin/skills/agent-bridge/SKILL.md describe cola, recuperación e idempotencia. Los manifiestos de Codex/Claude están en plugin/ y el catálogo en .claude-plugin/marketplace.json. Los registros MCP se instalan aparte porque dependen de rutas locales.

## Validación

~~~bash
npm test
BRIDGE_SYSTEMD_TEST=1 node --test test/systemd.test.js
BRIDGE_SOAK_MS=60000 node --test test/soak.test.js
# Consume cuota; requiere servicio instalado y cuentas autenticadas:
BRIDGE_LIVE_SERVICE=1 node --test test/persistent-live.test.js
# Consume cuota del modelo predeterminado de OpenCode; requiere opencode instalado:
BRIDGE_LIVE_OPENCODE=1 node --test test/opencode-live.test.js test/opencode-precedence.test.js
~~~

Las pruebas cubren cola, persistencia, cancelación, reconexión, deduplicación, rutas y carga controlada. La prueba systemd crea una unidad temporal y mata su proceso principal para verificar limpieza y recuperación. opencode-live.test.js comprueba contra el servicio real que la metadata de una sesión sobrevive a session.get y que interrumpir una sesión desconocida devuelve SessionNotFoundError (sin modelo), y después un trabajo read-only, uno edit en worktree que deja su rama, una cancelación a mitad y una reanudación. Si el modelo está sin cuota (HTTP 429) esa segunda prueba se omite con un aviso, no pasa: es un resultado no concluyente. opencode-precedence.test.js fija cómo se combinan las reglas de sesión con la configuración y, sin modelo, el orden de la configuración, el agente efectivo y el directorio de la sesión. Las pruebas reales cortas no prueban estabilidad durante horas con modelos reales.

## Contenedor futuro

El servicio se ejecuta en primer plano con node src/service.js; su lógica no depende de WSL ni de systemd. Un despliegue futuro debe supervisar el árbol de procesos, montar proyectos/estado/sesiones con rutas estables y provisionar autenticación fuera de la imagen. Un motor de contenedores activo seguirá siendo necesario. Esta entrega no incluye Dockerfile ni despliegue en contenedor.

## Referencias

- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Sesiones](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Alojamiento del SDK](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Plugin Codex para Claude Code](https://github.com/openai/codex-plugin-cc)
- [claude-code-agent-for-codex](https://github.com/Qihao-Duan/claude-code-agent-for-codex)
- [mcp-agents](https://github.com/thomaswitt/mcp-agents)
