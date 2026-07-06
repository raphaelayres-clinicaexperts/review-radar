// Baixa e extrai o tarball de um repo GitHub sem depender de `git` (a Lambda Node22 não tem
// git no runtime). Usado por refresh-artifacts.ts pra reconstruir o code-graph a partir de
// `origin/main` do repo clinicaexperts_app.

import { gunzipSync } from "node:zlib";

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "radar-mvp-refresh-artifacts",
  };
}

// GET /repos/:owner/:repo/tarball/:ref redireciona (302) pra codeload.github.com. O Fetch
// Standard remove o header Authorization em redirects cross-origin, então seguimos o
// redirect manualmente e reanexamos o header — necessário pra repos privados.
export async function fetchRepoTarball(owner: string, repo: string, ref: string, token: string): Promise<Buffer> {
  const headers = authHeaders(token);
  const initial = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`, {
    headers,
    redirect: "manual",
  });
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    if (!location) throw new Error("GitHub tarball: redirect sem header Location");
    const res = await fetch(location, { headers });
    if (!res.ok) throw new Error(`GitHub tarball: download falhou (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!initial.ok) throw new Error(`GitHub tarball: request falhou (HTTP ${initial.status})`);
  return Buffer.from(await initial.arrayBuffer());
}

export async function getCommitSha(owner: string, repo: string, ref: string, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, {
    headers: { ...authHeaders(token), accept: "application/vnd.github.sha" },
  });
  if (!res.ok) throw new Error(`GitHub commits/${ref}: falhou (HTTP ${res.status})`);
  return (await res.text()).trim();
}

const BLOCK = 512;

function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.toString("ascii", offset, offset + length).replace(/\0/g, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf-8");
}

// Parser tar (ustar/POSIX) mínimo: só o necessário pra ler entradas regulares e nomes longos
// (extensão GNU `L` e header estendido PAX `x`, usados quando o path passa de ~255 chars).
// Ignora diretórios, symlinks e o `pax_global_header` que o `git archive` do GitHub injeta.
export function extractTarGz(gzBuf: Buffer, keep: (relPath: string) => boolean): Map<string, Buffer> {
  const tar = gunzipSync(gzBuf);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // fim do arquivo (2 blocos zerados)

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const shortName = readString(header, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = null;

    const dataStart = offset + BLOCK;
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "L") {
      longName = tar.toString("utf-8", dataStart, dataStart + size).replace(/\0+$/, "");
    } else if (typeflag === "x") {
      const raw = tar.toString("utf-8", dataStart, dataStart + size);
      longName = raw.match(/\d+ path=([^\n]+)\n/)?.[1] ?? null;
    } else if (typeflag === "0" || typeflag === "\0") {
      const relPath = name.replace(/^[^/]+\//, ""); // remove "<repo>-<sha>/" do topo
      if (keep(relPath)) files.set(relPath, Buffer.from(tar.subarray(dataStart, dataStart + size)));
    }

    offset = dataStart + paddedSize;
  }
  return files;
}
