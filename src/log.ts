/**
 * One-line JSON event log on stderr (stdout is the MCP stream under stdio).
 * Under Docker, read it with `docker compose logs`. Callers must never pass
 * keys, tokens, passwords or legislation text.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
