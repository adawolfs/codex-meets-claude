# Puente persistente en WSL, preparado para contenedor

Fecha: 2026-10-31
Estado: aprobado por el usuario; implementación 0.3.0 completada y verificada.

## Intención y decisiones
El usuario eligió comenzar con un servicio en WSL y considera un contenedor más adelante para evitar iniciar manualmente el entorno. La primera entrega debe permitir usar el puente desde Codex y Claude en Windows o WSL sin abrir Ubuntu, conservar resultados y desacoplar los trabajos de la conexión MCP.

Decisiones confirmadas: WSL primero; portabilidad futura a contenedor. Propuestas del implementador: un coordinador para ambos proveedores, systemd de usuario, SQLite local y arranque bajo demanda. El contenedor no forma parte de esta entrega.

## Alternativas consideradas
1. Servicio único en WSL, elegido en la conversación: cola y estado comunes, reutiliza los CLI autenticados; Windows depende de WSL.
2. Servicios nativos independientes en Windows y WSL: independencia de ejecución, a cambio de sincronización y posibles conflictos. No elegido.
3. Contenedor desde ahora: despliegue reproducible, pero introduce antes de tiempo autenticación, volúmenes y runtime. Queda como siguiente despliegue del mismo servicio.

## Situación actual y alcance
Hoy src/server.js posee JobManager y cancela trabajos al desconectarse. Claude usa Agent SDK 0.3.316; Codex usa exec en solo lectura. Los registros de cada proceso no se comparten. Mantener estos backends y nombres MCP; separar transporte, coordinación y ejecución.

Esta entrega incluye servicio persistente, cola limitada para ambos proveedores, historial durable, reconexión, coordinación por proyecto/sesión, diagnóstico y actualización de las instalaciones existentes. Permisos interactivos, interfaz web, Codex App Server, sincronización remota y ejecución en contenedor se posponen. Los permisos adicionales de Claude seguirán denegándose y mostrándose.

## Arquitectura propuesta
- Servicio Linux Node.js, ejecutable en primer plano; sin dependencias de WSL dentro de su lógica de trabajos.
- systemd de usuario supervisa el servicio y su grupo de procesos. El WSL actual tiene systemd como PID 1, user manager running y Node 22.23.4.
- Fachadas MCP ligeras mantienen las herramientas actuales. Al conectarse, comprueban/inician el servicio y realizan llamadas locales. Su cierre no cancela trabajos.
- En Windows la entrada registrada invoca wsl.exe -d Ubuntu con argumentos separados y rutas explícitas para iniciar la fachada Linux; no requiere una terminal interactiva ni un login shell. En WSL se llama directamente al mismo lanzador.
- Comunicación interna por socket Unix en directorio privado del usuario (0700, socket 0600), sin puerto TCP ni acceso remoto. HTTP local sobre socket con API versionada permite reutilizar clientes sencillos. Límites de tamaño de entrada y respuesta.
- Proveedor permitido fijado por cada registro MCP; un cliente claude-bridge no cambia accidentalmente al proveedor Codex.
- Arranque idempotente mediante systemd y sondeo de readiness con plazo; varios clientes no crean varios coordinadores. Configuración/rutas de ejecutables explícitas, sin depender del PATH interactivo.
- El servicio sigue vivo al cerrar las fachadas. Detener WSL, reiniciar Windows o parar el servicio interrumpe las ejecuciones; no se promete supervivencia a esos eventos.

## Persistencia y contrato
SQLite local en el filesystem Linux, fuera del repositorio, por defecto ~/.local/state/agent-bridge. Propuesta: node:sqlite en el servicio (Node >=22.13); probar compatibilidad en el runtime existente. No colocar la base en /mnt/c ni en UNC. Esquema versionado y migraciones transaccionales.

Guardar jobId, provider, requestId, prompt/opciones necesarias para ejecución, cwd canónico, sesión, fechas, estado, resultado/error, uso/costo y eventos acotados. No almacenar credenciales, entorno completo, argumentos de herramientas ni razonamiento. Los prompts y resultados son datos sensibles locales protegidos por permisos del usuario.

Estados: queued, running, completed, failed, cancelled, timed_out, interrupted. El ID de trabajo es durable y separado del sessionId del proveedor. Conservar campos actuales; los clientes/skills deben reconocer queued/interrupted. Las listas se paginan y no incluyen resultados completos por defecto; status recupera un trabajo. Eventos con cursores monotónicos por trabajo, paginación y señal de truncamiento.

Añadir requestId opcional a start: misma clave y misma solicitud devuelve el mismo trabajo; una clave con contenido diferente da error. La fachada asigna una clave antes de enviar y la reutiliza en reintentos de transporte. Sin clave explícita, una invocación nueva del agente es una solicitud nueva. Confirmar start solo tras persistir la solicitud. Persistir estado terminal antes de publicarlo. No reintentar ejecuciones por errores del proveedor.

## Cola y coordinación
Propuesta inicial configurable: 4 trabajos globales activos, 100 en cola; exceder la cola devuelve un error claro. FIFO entre trabajos elegibles, sin bloquear proyectos independientes por el primer trabajo ocupado. Ambos proveedores comparten límites. Un turno activo por sesión/proveedor y un trabajo por raíz Git; fuera de Git, por cwd real. Resolver la raíz Git para identificar subdirectorios del mismo checkout; los worktrees distintos son proyectos distintos. Serializar también tareas en solo lectura en esta versión: elección conservadora para simplicidad, revisable después.

Los bloqueos solo cubren solicitudes que pasan por este servicio; no coordinan terminales ni agentes externos. No prometer aislamiento de filesystem. No crear worktrees automáticamente.

Separar tiempo en cola del plazo de ejecución. Valores configurables: 60 minutos de ejecución por defecto, 50 turnos Claude salvo opción explícita. Sustituir el corte por 4 MB acumulados del backend Claude por retención acotada de eventos/progreso y límites por mensaje/resultado, para que una tarea extensa no falle por haber generado muchos eventos pequeños. Mantener límites explícitos y documentados en Codex; revisar su acumulación de stdout para evitar crecimiento sin límite.

Retención propuesta: 1000 trabajos terminales o 30 días; 256 eventos recientes por trabajo; límites de bytes por evento, resultado y registro. Nunca podar queued/running. Tras expirar la retención, un ID devuelve not found explícito. Diagnóstico muestra ocupación, límites y política de retención.

## Reinicios, cancelación y recuperación
- Desconexión de una fachada: ejecución continúa; reconectar y consultar el ID.
- Cancelación en cola: persistir cancelled sin lanzar proceso.
- Cancelación activa: solicitar abort/terminación, mantener bloqueo hasta confirmar limpieza y publicar finishedAt al concluir.
- Parada ordenada del servicio: detener nuevas ejecuciones, cerrar árboles de procesos con plazo y escalado; marcar activas interrupted, conservar la cola pendiente.
- Fallo abrupto: systemd mata procesos restantes antes de reiniciar; al abrir la base marcar running como interrupted. No relanzarlas automáticamente, pues pueden haber editado archivos. Las queued nunca iniciadas vuelven a ser elegibles tras el arranque.
- Retomar una interrumpida es una nueva solicitud explícita vinculada al trabajo anterior, usando sessionId cuando exista y manteniendo proveedor/proyecto. Si no se capturó una sesión, informar que solo puede iniciarse un trabajo nuevo; no fingir continuidad.
- No prometer exactly-once de herramientas externas. Si una mutación ocurrió antes de un fallo, consultar el estado del proyecto antes de retomar.

## Windows, rutas y despliegue futuro
Aceptar rutas Linux y traducir rutas Windows de unidades locales y UNC correspondientes a la distro Ubuntu. Canonicalizar y verificar directorio dentro del servicio. Rechazar rutas a otras distros o recursos no accesibles con mensaje accionable; no adivinar. Ejecutar los proveedores con rutas Linux. Toda conversión usa argumentos separados, sin interpolación shell de prompts/rutas.

Preparar configuración de ejecutables, almacenamiento, socket y mapeo de proyectos independiente de nombres de usuario. La futura imagen ejecutará el mismo servicio en primer plano; montará proyectos, estado y sesiones en volúmenes separados. Credenciales se provisionarán fuera de la imagen y del repositorio. Mantener rutas estables o un mapeo explícito para sesiones. No montar automáticamente todo el home.

Un contenedor elimina la dependencia de esta distro Ubuntu como instalación de desarrollo, pero necesita un motor activo y acceso al almacenamiento; no elimina la necesidad de un entorno de ejecución. Selección de Docker/Podman, autenticación y despliegue quedan para esa etapa.

## Experiencia y operación
Mantener claude_start/status/events/cancel/list_jobs y codex_start/status/cancel/list_jobs, ampliando esquemas de forma documentada para cola, paginación e idempotencia. Añadir operación de diagnóstico accesible por CLI y MCP: servicio/backend listos, versión, rutas, cola, errores de autenticación sanitizados; nunca volcar secretos. Evitar pruebas de inferencia pagadas en health checks.

Actualizar skills/plugins para que esperen queued, recuperen trabajos por ID y distingan interrupted de failed. Antes de modificar registros globales, respaldar los registros afectados y ofrecer rollback al modo anterior. La actualización no debe matar trabajos preexistentes del modo antiguo; advertir su carácter no migrable y mantener sus clientes hasta que terminen.

## Criterios de aceptación
1. Dos fachadas comparten trabajos y solo se inicia un servicio.
2. Cerrar/reabrir una fachada durante una consulta conserva el trabajo y permite obtener su resultado.
3. Reiniciar el servicio conserva resultados y cola, marca tareas activas interrupted y no repite mutaciones.
4. Límites, FIFO elegible, bloqueos por proyecto/sesión y cancelación funcionan en ambos proveedores; no quedan procesos huérfanos.
5. Reintentar start con requestId no duplica trabajo, incluso tras pérdida de respuesta/reinicio.
6. Desde Windows se inicia WSL y el servicio sin terminal manual; rutas con espacios y caracteres especiales funcionan.
7. Historial/eventos/respuestas y memoria tienen límites comprobados; pruebas con miles de trabajos simulados y un ensayo prolongado con backends controlados.
8. Pruebas reales acotadas de ambos proveedores y una tarea SDK que sobrevive a la desconexión; diferenciar estos resultados de un ensayo real de varias horas que todavía no se haya ejecutado.
9. Diagnóstico, reinstalación y rollback no exponen credenciales ni sobrescriben configuración ajena.

## Libertad del implementador
Distribución de módulos, nombres de comandos de operación, esquema SQL preciso, framing interno, estrategia de batching de eventos y fixtures de prueba. Mantener los invariantes anteriores. No aumentar alcance a UI, permisos interactivos o contenedores sin una nueva decisión.

## Referencias
https://code.claude.com/docs/en/agent-sdk/hosting
https://code.claude.com/docs/en/agent-sdk/sessions

## Revisión del diseño
Revisión independiente completada: no quedaron preguntas importantes que impidieran preparar el plan de implementación. Aprobado por el usuario con «procede».
