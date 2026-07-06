export function isGithubWriteEnabled(): boolean {
  const v = (process.env.REVIEW_GITHUB_WRITE ?? "false").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
