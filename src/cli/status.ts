import { loadTokens, getValidAccessToken } from "../services/tokens";

const tokens = loadTokens();

if (!tokens) {
  console.log("❌ Nenhum token salvo. Rode: bun run auth");
  process.exit(1);
}

console.log("📋 Token Info:");
console.log("   account_id:", tokens.account_id);
console.log("   expires_at:", new Date(tokens.expires_at).toISOString());
console.log(
  "   expirado?  ",
  Date.now() >= tokens.expires_at ? "SIM" : "NÃO"
);
console.log(
  "   refresh?   ",
  tokens.refresh_token ? "disponível" : "indisponível"
);

console.log("\n🔄 Tentando obter token válido (com auto-refresh)...");

const valid = await getValidAccessToken();

if (valid) {
  console.log("✅ Token válido. account_id:", valid.account_id);
  console.log("   access_token:", valid.access_token.slice(0, 20) + "...");
} else {
  console.log("❌ Não foi possível obter token válido. Rode: bun run auth");
}
