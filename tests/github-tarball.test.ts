import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { extractTarGz } from "../lambda/github-tarball.ts";

const BLOCK = 512;

// Monta um tar ustar mínimo em memória (sem depender do binário `tar` do SO), pra testar
// extractTarGz isoladamente e de forma determinística em qualquer ambiente/CI.
function tarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf-8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  const sizeOctal = Buffer.byteLength(content, "utf-8").toString(8).padStart(11, "0");
  header.write(`${sizeOctal}\0`, 124, 12, "ascii"); // size
  header.write("00000000000\0", 136, 12, "ascii"); // mtime
  header.write("        ", 148, 8, "ascii"); // chksum placeholder (8 spaces)
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii"); // magic
  header.write("00", 263, 2, "ascii"); // version

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumOctal = checksum.toString(8).padStart(6, "0");
  header.write(`${checksumOctal}\0 `, 148, 8, "ascii");

  const contentBuf = Buffer.from(content, "utf-8");
  const padded = Math.ceil(contentBuf.length / BLOCK) * BLOCK;
  const contentBlock = Buffer.alloc(padded);
  contentBuf.copy(contentBlock);

  return Buffer.concat([header, contentBlock]);
}

function makeTarGz(entries: Array<[string, string]>): Buffer {
  const blocks = entries.map(([name, content]) => tarEntry(name, content));
  const trailer = Buffer.alloc(BLOCK * 2);
  return gzipSync(Buffer.concat([...blocks, trailer]));
}

describe("extractTarGz", () => {
  it("extracts regular files and strips the top-level repo-sha/ prefix", () => {
    const gz = makeTarGz([
      ["clinicaexperts_app-abc123/composer.json", '{"autoload":{"psr-4":{"App\\\\":"app/"}}}'],
      ["clinicaexperts_app-abc123/app/Models/User.php", "<?php\nclass User {}\n"],
    ]);

    const files = extractTarGz(gz, () => true);

    expect([...files.keys()].sort()).toEqual(["app/Models/User.php", "composer.json"]);
    expect(files.get("app/Models/User.php")!.toString("utf-8")).toBe("<?php\nclass User {}\n");
  });

  it("applies the keep() predicate to skip files outside the roots of interest", () => {
    const gz = makeTarGz([
      ["repo-sha/app/Models/User.php", "<?php\n"],
      ["repo-sha/resources/views/welcome.blade.php", "<html></html>"],
    ]);

    const files = extractTarGz(gz, (relPath) => relPath.startsWith("app/") && relPath.endsWith(".php"));

    expect([...files.keys()]).toEqual(["app/Models/User.php"]);
  });

  it("handles content spanning multiple 512-byte blocks", () => {
    const bigContent = `<?php\n${"x".repeat(1000)}\n`;
    const gz = makeTarGz([["repo-sha/app/Big.php", bigContent]]);

    const files = extractTarGz(gz, () => true);

    expect(files.get("app/Big.php")!.toString("utf-8")).toBe(bigContent);
  });

  it("returns an empty map for an archive with no matching entries", () => {
    const gz = makeTarGz([["repo-sha/README.md", "hello"]]);

    const files = extractTarGz(gz, (relPath) => relPath.endsWith(".php"));

    expect(files.size).toBe(0);
  });
});
