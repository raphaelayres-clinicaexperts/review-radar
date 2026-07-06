import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CLIENT_ID, TOKEN_URL, TOKEN_FILE } from "../config";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id: string;
  expires_at: number;
}

export function loadTokens(): TokenData | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = readFileSync(TOKEN_FILE, "utf-8");
    return JSON.parse(raw) as TokenData;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: TokenData): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

export function extractAccountId(idToken: string): string {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token JWT inválido");

  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf-8")
  );

  const accountId =
    payload["https://api.openai.com/auth.chatgpt_account_id"] ||
    payload.sub;

  if (!accountId) {
    throw new Error(
      "account_id não encontrado no JWT. Claims: " + JSON.stringify(payload)
    );
  }

  return accountId;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Refresh falhou (${response.status}): ${text}`);
  }

  return response.json();
}

export async function getValidAccessToken(): Promise<{
  access_token: string;
  account_id: string;
} | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  const isExpired = Date.now() >= tokens.expires_at - 60_000;

  if (!isExpired) {
    return {
      access_token: tokens.access_token,
      account_id: tokens.account_id,
    };
  }

  if (!tokens.refresh_token) return null;

  console.log("[tokens] Access token expirado, fazendo refresh...");

  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);

    const updated: TokenData = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
      expires_at: refreshed.expires_in
        ? Date.now() + refreshed.expires_in * 1000
        : tokens.expires_at + 3600_000,
    };

    if (refreshed.id_token) {
      updated.id_token = refreshed.id_token;
      updated.account_id = extractAccountId(refreshed.id_token);
    }

    saveTokens(updated);
    console.log(
      "[tokens] Refresh OK, novo expires_at:",
      new Date(updated.expires_at).toISOString()
    );

    return {
      access_token: updated.access_token,
      account_id: updated.account_id,
    };
  } catch (err) {
    console.error("[tokens] Refresh falhou:", err);
    return null;
  }
}
