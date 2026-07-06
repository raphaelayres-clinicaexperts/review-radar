export type StoreMode = "fs" | "dynamo";

export function storeMode(): StoreMode {
  if (process.env.STORE === "dynamo") return "dynamo";
  if (process.env.STORE === "fs") return "fs";
  const insideLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  return insideLambda && process.env.TABLE_NAME ? "dynamo" : "fs";
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Env var ausente: ${name}`);
  return value;
}

export function tableName(): string {
  return requireEnv("TABLE_NAME");
}

export function githubToken(): string {
  return requireEnv("GITHUB_TOKEN");
}

export function webhookSecret(): string {
  return requireEnv("WEBHOOK_SECRET");
}

export function selfFunctionName(): string | undefined {
  return process.env.SELF_FUNCTION_NAME;
}

export function diffCapBytes(): number {
  const raw = process.env.DIFF_CAP_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000;
}

export function localStoreFile(): string {
  return process.env.LOCAL_STORE_FILE || "./.radar-local-store.json";
}
