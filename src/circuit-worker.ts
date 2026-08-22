import { RaceHub } from "../../mario/worker/src/hub.ts";

export { RaceHub };

const OAUTH_HTML = `<!DOCTYPE html>
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

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RACE_HUB: DurableObjectNamespace;
  DISCORD_CLIENT_ID?: string;
  VITE_DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/discord-oauth" || path === "/discord-oauth.html") {
      return html(OAUTH_HTML);
    }

    if (path === "/ws" && request.headers.get("Upgrade") === "websocket") {
      const id = env.RACE_HUB.idFromName("hub");
      return env.RACE_HUB.get(id).fetch(request);
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

    if (host === "circuit.whatispugdoing.com") {
      const assetPath = path === "/" ? "/circuit-game/index.html" : `/circuit-game${url.pathname}`;
      const assetUrl = new URL(assetPath, url.origin);
      assetUrl.search = url.search;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    return env.ASSETS.fetch(request);
  },
};

function html(body: string) {
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

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders() });
}

async function exchangeDiscordToken(request: Request, env: Env) {
  const clientId = env.DISCORD_CLIENT_ID || env.VITE_DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "Discord client secrets are not configured on the worker" }, 500);
  }

  let code = "";
  try {
    const parsed = (await request.json()) as { code?: string };
    code = typeof parsed?.code === "string" ? parsed.code : "";
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!code) return json({ error: "Missing OAuth code" }, 400);

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
  const data = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !data.access_token) {
    return json({ error: data.error ?? "Token exchange failed" }, 500);
  }
  return json({ access_token: data.access_token });
}
