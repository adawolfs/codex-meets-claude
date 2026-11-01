# Codex meets Claude — 0.3.0

Puente MCP bidireccional con un servicio persistente en WSL/Linux. Codex → Claude usa Claude Agent SDK; Claude → Codex conserva codex exec en solo lectura. Los clientes de Windows y WSL comparten cola, trabajos y resultados.

## Uso diario

Los registros instalados llaman a src/launch.js. El lanzador arranca agent-bridge.service bajo demanda; no necesitas abrir una terminal de Ubuntu. Puedes cerrar el cliente y reconectar: los trabajos del servicio siguen ejecutándose. Los clientes abiertos antes de actualizar conservan su servidor antiguo; termina esos trabajos antes de reiniciarlos.

- claude_start / codex_start: prompt y cwd absolutos; devuelven un ID durable con estado queued.
- claude_status / codex_status: consultar ID; estados queued, running, completed, failed, cancelled, timed_out o interrupted.
- claude_list_jobs / codex_list_jobs: páginas de resúmenes con after, limit, jobs, nextCursor y hasMore. status contiene el resultado completo.
- claude_events: eventos paginados por jobId, after y limit; truncated indica historial descartado.
- claude_cancel / codex_cancel: cancelar en cola o solicitar cancelación activa; finishedAt confirma limpieza.
- claude_diagnostics / codex_diagnostics: estado del servicio, límites y disponibilidad de ejecutables. No ejecuta inferencia ni comprueba autenticación.

Usa requestId estable para reintentar una solicitud sin duplicarla. Una clave con argumentos diferentes da error. La deduplicación dura mientras se conserve el trabajo en el historial; una solicitud nueva sin clave no se considera un reintento.

Para continuar, inicia otro trabajo con sessionId, o con parentJobId y un nuevo prompt en el mismo cwd. Nunca se reejecuta automáticamente un trabajo interrumpido: revisa los cambios que pudo haber hecho antes de retomarlo. Una conversación persistida no es un respaldo de archivos ni de procesos.

Claude admite permissionMode: plan (predeterminado) o acceptEdits, model, maxTurns (50 por defecto) y maxBudgetUsd. Las solicitudes de permisos adicionales se deniegan y se muestran en permissionDenials. No hay aprobación interactiva en esta versión. El presupuesto es una estimación del SDK. Se deshabilitan herramientas MCP del delegado; las reglas, skills y hooks locales de Claude siguen siendo relevantes. Codex permanece en solo lectura.

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

El nombre agentbridge, sin guion, es obligatorio: los niveles de permiso de OpenCode deniegan agentbridge_<herramienta> para que un delegado no vuelva a llamar al puente. Si ~/.config/opencode contiene opencode.jsonc con comentarios, el comando se niega a reescribirlo (los comentarios no se recuperarían con el rollback); añade a mano la entrada o quita los comentarios. OpenCode no necesita reiniciarse (`opencode reload` recarga su configuración); Claude Code y Codex sí necesitan reiniciarse para ver el cambio. El archivo de OpenCode se reescribe como JSON re-serializado: se conservan contenido, orden de claves e indentación, pero no el formato original (p. ej. un array en una línea pasa a varias), y el rollback tampoco lo restaura.

Si actualizas desde una versión con dos clientes, vuelve a ejecutar el comando: los registros antiguos de Codex y Claude pasan al proveedor equivocado como argumento (Codex arrancaba launch.js claude) y reciben las herramientas incorrectas. Hasta entonces el puente avisa de ello en el arranque. Con la instalación del servicio, OPENCODE_COMMAND (por defecto ~/.opencode/bin/opencode) se guarda en la unidad; si falta, la instalación continúa y escribe un aviso en stderr.

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
~~~

Las pruebas cubren cola, persistencia, cancelación, reconexión, deduplicación, rutas y carga controlada. La prueba systemd crea una unidad temporal y mata su proceso principal para verificar limpieza y recuperación. Las pruebas reales cortas no prueban estabilidad durante horas con modelos reales.

## Contenedor futuro

El servicio se ejecuta en primer plano con node src/service.js; su lógica no depende de WSL ni de systemd. Un despliegue futuro debe supervisar el árbol de procesos, montar proyectos/estado/sesiones con rutas estables y provisionar autenticación fuera de la imagen. Un motor de contenedores activo seguirá siendo necesario. Esta entrega no incluye Dockerfile ni despliegue en contenedor.

## Referencias

- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Sesiones](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Alojamiento del SDK](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Plugin Codex para Claude Code](https://github.com/openai/codex-plugin-cc)
- [claude-code-agent-for-codex](https://github.com/Qihao-Duan/claude-code-agent-for-codex)
- [mcp-agents](https://github.com/thomaswitt/mcp-agents)
