export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/discord-oauth") {
    const oauth = new URL("/discord-oauth/index.html", url.origin);
    return env.ASSETS.fetch(new Request(oauth, request));
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

    if (host === "circuit.whatispugdoing.com" || path === "/circuit" || path.startsWith("/circuit/")) {
      if (path === "/circuit" || path === "/") {
        return env.ASSETS.fetch(new Request(new URL("/circuit/index.html", url.origin), request));
      }
    }

    return env.ASSETS.fetch(request);
  },
};

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
    const body = await request.json();
    code = typeof body?.code === "string" ? body.code : "";
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
