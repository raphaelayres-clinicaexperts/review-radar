import { randomBytes, createHash } from "node:crypto";

export function generatePKCEPair() {
  const codeVerifier = randomBytes(96).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}
