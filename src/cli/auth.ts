import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import {
  CLIENT_ID,
  REDIRECT_PORT,
  REDIRECT_URI,
  AUTHORIZE_URL,
  TOKEN_URL,
  OAUTH_SCOPE,
} from "../config";
import { generatePKCEPair, generateState } from "../services/crypto";
import {
  extractAccountId,
  saveTokens,
  type TokenData,
} from "../services/tokens";

const { codeVerifier, codeChallenge } = generatePKCEPair();
const state = generateState();

console.log("[auth] PKCE verifier gerado ✓");
console.log("[auth] State (CSRF) gerado ✓");

const authUrl = new URL(AUTHORIZE_URL);
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", OAUTH_SCOPE);
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", codeChallenge);
authUrl.searchParams.set("code_challenge_method", "S256");

const SUCCESS_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Auth OK</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9">
  <div style="text-align:center">
    <h1 style="color:#58a6ff">✓ Autenticado com sucesso</h1>
    <p>Pode fechar esta aba. Os tokens foram salvos.</p>
  </div>
</body>
</html>`;

const ERROR_HTML = (msg: string) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Auth Erro</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9">
  <div style="text-align:center">
    <h1 style="color:#f85149">✗ Erro na autenticação</h1>
    <p>${msg}</p>
  </div>
</body>
</html>`;

async function handleCallback(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

  if (url.pathname !== "/auth/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(ERROR_HTML("State mismatch — possível CSRF."));
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(ERROR_HTML(`OpenAI retornou erro: ${error}`));
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(ERROR_HTML("Nenhum code recebido."));
    return;
  }

  console.log("[auth] Code recebido, trocando por tokens...");

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[auth] Token exchange falhou:", tokenRes.status, errText);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(ERROR_HTML(`Token exchange falhou (${tokenRes.status})`));
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      id_token: string;
      expires_in: number;
      token_type: string;
    };

    console.log("[auth] Tokens recebidos ✓");
    console.log("[auth] expires_in:", tokenData.expires_in, "segundos");

    const accountId = extractAccountId(tokenData.id_token);
    console.log("[auth] account_id:", accountId);

    const tokens: TokenData = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      id_token: tokenData.id_token,
      account_id: accountId,
      expires_at: Date.now() + tokenData.expires_in * 1000,
    };

    saveTokens(tokens);
    console.log("[auth] Tokens salvos em tokens.json ✓");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SUCCESS_HTML);
  } catch (err) {
    console.error("[auth] Erro:", err);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(ERROR_HTML(String(err)));
  } finally {
    setTimeout(() => {
      console.log("[auth] Finalizando servidor de callback.");
      server.close();
      process.exit(0);
    }, 1000);
  }
}

const server = createServer(handleCallback);

server.listen(REDIRECT_PORT, () => {
  console.log(
    `[auth] Callback server rodando em http://localhost:${REDIRECT_PORT}`
  );
  console.log("[auth] Abrindo browser para autenticação...\n");

  const openUrl = authUrl.toString();
  const cmd =
    process.platform === "darwin"
      ? `open "${openUrl}"`
      : process.platform === "win32"
        ? `start "${openUrl}"`
        : `xdg-open "${openUrl}"`;

  exec(cmd, (err) => {
    if (err) {
      console.log("[auth] Não foi possível abrir o browser automaticamente.");
      console.log("[auth] Abra manualmente:\n");
      console.log(openUrl);
    }
  });
});

setTimeout(() => {
  console.log("[auth] Timeout — nenhum callback recebido em 5 minutos.");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
