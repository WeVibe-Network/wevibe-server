// Shared contract for the :4451 dashboard-server service-control feature.
// Consumed by the /api/backend/* routes (server) and the DashboardServerControls
// component (client). Defined once so the two sides never drift. The :4451 host
// service is wevibe-mcp/dist/dashboard-server.js (leader encrypt-at-Verify /
// moderation / decrypt); this feature starts/stops/monitors it from :3001.

/** Current state of the :4451 dashboard-server host process. */
export interface BackendStatus {
  /** True if a process is LISTENING on tcp:4451 (via lsof). */
  running: boolean;
  /** PID of the :4451 listener, or null when down. */
  pid: number | null;
  /** True if GET http://127.0.0.1:4451/health responded ok. */
  healthy: boolean;
  /** Human-readable detail (health body summary, or why it's down). */
  detail: string;
}

/** Result of a start/stop/restart action. */
export interface BackendActionResult {
  /** True if the action reached its intended end-state. */
  ok: boolean;
  /** The resulting status after the action (post-poll for start/restart). */
  status: BackendStatus;
  /** Human-readable detail of what happened (or the failure). */
  detail: string;
  /** The logfile the spawned :4451 stdio was routed to (start/restart). */
  logPath?: string;
}
