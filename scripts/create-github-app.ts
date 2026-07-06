import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = 8712;
const ORG = process.env.APP_ORG ?? "clinicaexperts";
const personal = process.argv.includes("--personal");
const webhookSecret = process.env.WEBHOOK_SECRET;
if (!webhookSecret) throw new Error("WEBHOOK_SECRET ausente no .env");

const minimal = process.argv.includes("--minimal");
const manifest = minimal
  ? {
      name: "review-radar-bot",
      url: "https://github.com/clinicaexperts",
      redirect_url: `http://localhost:${PORT}/callback`,
      public: false,
    }
  : {
      name: "review-radar-bot",
      url: "https://github.com/clinicaexperts",
      hook_attributes: { url: "https://u2u67lir55.execute-api.us-east-1.amazonaws.com/" },
      redirect_url: `http://localhost:${PORT}/callback`,
      public: false,
      default_permissions: { pull_requests: "write", issues: "write", contents: "read", metadata: "read" },
      default_events: ["pull_request", "issue_comment"],
    };

const target = personal
  ? "https://github.com/settings/apps/new"
  : `https://github.com/organizations/${ORG}/settings/apps/new`;

const formPage = `<!doctype html><html><body>
<h2>Criar GitHub App: Review Radar Bot</h2>
<p>Destino: ${target}</p>
<form action="${target}" method="post">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
<button type="submit" style="font-size:1.3rem;padding:12px 24px">Criar GitHub App</button>
</form>
<p>Sem permissão na org? Rode de novo com <code>--personal</code>.</p>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(formPage);
    return;
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("code ausente");
      return;
    }
    const conv = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!conv.ok) {
      res.writeHead(500).end(`conversão falhou: ${conv.status}`);
      console.error(`conversão falhou: HTTP ${conv.status}`);
      return;
    }
    const app = (await conv.json()) as {
      id: number;
      slug: string;
      pem: string;
      webhook_secret: string;
      html_url: string;
    };
    writeFileSync("github-app.json", JSON.stringify(app, null, 2), { mode: 0o600 });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<h2>✅ App criado: ${app.slug} (id ${app.id})</h2><p>Credenciais salvas. Pode fechar esta aba.</p><p>Instale no repo: <a href="https://github.com/apps/${app.slug}/installations/new">instalar</a></p>`,
    );
    console.log(`OK app_id=${app.id} slug=${app.slug} → github-app.json`);
    console.log(`Instalação: https://github.com/apps/${app.slug}/installations/new`);
    setTimeout(() => server.close(), 500);
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Abra no browser: http://localhost:${PORT}`);
});
