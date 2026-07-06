const port = process.env.PORT || "3456";
const minimal = process.env.USAGE_MINIMAL === "1";
const url = `http://127.0.0.1:${port}/usage${minimal ? "?minimal=1" : ""}`;

const res = await fetch(url);
if (!res.ok) {
  console.error(`GET /usage failed: ${res.status}. Is the server running?`);
  process.exit(1);
}
const data = (await res.json()) as {
  resumo?: { linhas?: string[] };
};

if (Array.isArray(data.resumo?.linhas)) {
  console.log("── Resumo ──");
  for (const line of data.resumo!.linhas!) {
    console.log(line);
  }
  console.log("");
}

console.log(JSON.stringify(data, null, 2));
