import { createSign } from "node:crypto";

let cached: { token: string; expiresAt: number } | null = null;

export function appAuthConfigured(): boolean {
  return Boolean(process.env.APP_ID && process.env.APP_PRIVATE_KEY_B64);
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(pem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export async function installationToken(owner: string, repo: string): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 300_000) return cached.token;

  const appId = process.env.APP_ID;
  const pemB64 = process.env.APP_PRIVATE_KEY_B64;
  if (!appId || !pemB64) throw new Error("GitHub App não configurado (APP_ID/APP_PRIVATE_KEY_B64)");

  const pem = Buffer.from(pemB64, "base64").toString("utf8");
  const jwt = appJwt(appId, pem);
  const headers = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" };

  const instRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, { headers });
  if (!instRes.ok) {
    throw new Error(`GitHub App não instalado em ${owner}/${repo} (HTTP ${instRes.status})`);
  }
  const inst = (await instRes.json()) as { id: number };

  const tokenRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers,
  });
  if (!tokenRes.ok) throw new Error(`GitHub App access_token falhou (HTTP ${tokenRes.status})`);
  const data = (await tokenRes.json()) as { token: string; expires_at: string };

  cached = { token: data.token, expiresAt: Date.parse(data.expires_at) };
  return data.token;
}
