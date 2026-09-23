// NEVER LOSS - Worker: serve o site estático e trata a troca do código OAuth (server-side, como a Deriv exige).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/token" && request.method === "POST") {
      try {
        const body = await request.json();
        const { code, code_verifier, client_id, redirect_uri } = body;
        if (!code || !code_verifier || !client_id || !redirect_uri) {
          return new Response(JSON.stringify({ error: "Parâmetros em falta" }), { status: 400 });
        }
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          code,
          code_verifier,
          redirect_uri,
        });
        const resp = await fetch("https://auth.deriv.com/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
      }
    }

    if (url.pathname === "/callback") {
      return env.ASSETS.fetch(new Request(new URL("/callback.html", url), request));
    }

    return env.ASSETS.fetch(request);
  },
};
