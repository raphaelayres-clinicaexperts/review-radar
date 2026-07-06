export const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

export const REDIRECT_PORT = 1455;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

export const TOKEN_FILE = "./tokens.json";

export const OAUTH_SCOPE = "openid profile email";
export const OAUTH_AUDIENCE = "https://api.openai.com/v1";
