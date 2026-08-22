// Superseded by src/circuit-worker.ts — Rainbow Circuit host, OAuth, and race WebSocket rooms.

<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discord OAuth — whatispugdoing</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:system-ui,sans-serif; background:#1a1410; color:#f4efe6; }
    main { max-width:28rem; padding:2rem; text-align:center; }
    p { color:#c9bfb0; line-height:1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Discord authorization</h1>
    <p>This URL is the OAuth2 redirect for the Rainbow Circuit Discord Activity. You can close this tab and launch the game from the #rainbow-circuit text channel. Stay in whatever voice call you already have — the race does not replace it.</p>
  </main>
</body>
</html>`;

const CIRCUIT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rainbow Circuit</title>
  <style>
    html,body { margin:0; height:100%; background:#07080d; color:#f8f9fa; font-family:system-ui,sans-serif; }
    main { min-height:100%; display:grid; place-items:center; text-align:center; padding:2rem; }
    p { color:#adb5bd; max-width:28rem; }
  </style>
</head>
<body>
  <main>
    <h1>Rainbow Circuit</h1>
    <p>Host is up. Launch from the <strong>#rainbow-circuit</strong> text channel — keep your existing voice call. When you are done, use the red hand on this panel to stop the race. That does not disconnect you from voice.</p>
  </main>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/discord-oauth" || path === "/discord-oauth.html") {
      return html(OAUTH_HTML);
    }

    if (host === "circuit.whatispugdoing.com" && (path === "/" || path === "/circuit")) {
      return html(CIRCUIT_HTML);
    }

    if (path === "/circuit") {
      return html(CIRCUIT_HTML);
    }

    if (path === "/api/health") {
      return json({ ok: true, host, path });
    }

    if (path === "/api/token" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/api/token" && request.method === "POST") {
      return exchangeDiscordToken(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

function html(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: corsHeaders() });
}

async function exchangeDiscordToken(request, env) {
  const clientId = env.DISCORD_CLIENT_ID || env.VITE_DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "Discord client secrets are not configured on the worker" }, 500);
  }

  let code = "";
  try {
    const parsed = await request.json();
    code = typeof parsed?.code === "string" ? parsed.code : "";
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!code) {
    return json({ error: "Missing OAuth code" }, 400);
  }

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    return json({ error: data.error ?? "Token exchange failed" }, 500);
  }
  return json({ access_token: data.access_token });
}
