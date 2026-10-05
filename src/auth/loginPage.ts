/**
 * The login page shown during claude.ai's OAuth handshake. Plain HTML with no
 * scripts; every interpolated value is escaped.
 */

import type { Response } from "express";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface LoginPageOptions {
  requestId: string;
  clientName: string;
  /** Where the browser is sent after a successful login (shown, and allowed by the CSP). */
  redirectUri: string;
  username?: string;
  error?: string;
}

/** Security headers for every login-related page. */
export function setPageHeaders(res: Response, formTarget?: string): void {
  // form-action also governs the redirect that follows the form submission.
  const formAction = formTarget ? `'self' ${new URL(formTarget).origin}` : "'self'";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #5c5c5c; --line: #c8c8c8; --accent: #1f4e79; --error: #a4262c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ececec; --muted: #a8a8a8; --line: #444; --accent: #8cb8e8; --error: #f1707a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 360px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: var(--muted); font-size: 0.9rem; }
  label { display: block; font-size: 0.875rem; margin: 14px 0 4px; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent;
          border: 1px solid var(--line); border-radius: 6px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { margin-top: 22px; width: 100%; padding: 10px; font: inherit; font-weight: 600; border: 0; border-radius: 6px;
           background: var(--accent); color: var(--bg); cursor: pointer; }
  .error { color: var(--error); font-size: 0.9rem; margin: 16px 0 0; }
`;

export function renderLoginPage(o: LoginPageOptions): string {
  const host = new URL(o.redirectUri).host;
  return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · NZ Legislation MCP</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Sign in to NZ Legislation MCP</h1>
<p><strong>${escapeHtml(o.clientName)}</strong> is asking to use this server. You will be returned to ${escapeHtml(host)}.</p>
<form method="post" action="/login">
<input type="hidden" name="request_id" value="${escapeHtml(o.requestId)}">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(o.username ?? "")}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${o.error ? `<p class="error" role="alert">${escapeHtml(o.error)}</p>` : ""}
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · NZ Legislation MCP</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
}
