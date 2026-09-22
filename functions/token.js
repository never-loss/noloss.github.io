// Cloudflare Pages Function: troca o código OAuth por um token, no servidor (a Deriv exige isto).
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
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
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
