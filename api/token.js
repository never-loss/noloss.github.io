// Vercel serverless: PKCE code → Deriv access_token.
// Must be ESM because root package.json has "type": "module".
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch {
        return res.status(400).json({ error: 'invalid_json_body' });
      }
    }
    body = body && typeof body === 'object' ? body : {};

    const { code, code_verifier, client_id, redirect_uri } = body;
    if (!code || !code_verifier || !client_id || !redirect_uri) {
      return res.status(400).json({ error: 'missing_parameters' });
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id,
      code,
      code_verifier,
      redirect_uri,
    });

    const response = await fetch('https://auth.deriv.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      return res.status(502).json({
        error: 'upstream_non_json',
        error_description: text.slice(0, 200) || 'Resposta inválida do servidor de autenticação',
      });
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(response.status).json(payload);
  } catch (error) {
    return res.status(500).json({
      error: 'token_exchange_failed',
      error_description: error && error.message ? String(error.message) : 'Erro interno',
    });
  }
}
