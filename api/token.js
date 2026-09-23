module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const { code, code_verifier, client_id, redirect_uri } = req.body || {};
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
    res.status(response.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (error) {
    return res.status(500).json({ error: 'token_exchange_failed' });
  }
};
