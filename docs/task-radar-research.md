# Task Radar — Pesquisa: predição de módulos/arquivos + estimativa de esforço (v7)

Data: 2026-07-04 · Contexto: pipeline atual (mapa estático 107 módulos + similaridade lexical sobre 476 PRs + 2 chamadas LLM) platô em ~50% precision / ~55% recall; esforço ≤50%.

## 1. Achados principais

### 1.1 Localização de arquivos (literatura SWE-bench / fault localization)

- **Agentless** (padrão-referência de pipeline fixo): localização hierárquica em 3 níveis — arquivo → classe/função → linha — combinando prompting sobre a *estrutura* do repo (skeleton de árvore + assinaturas) com retrieval por embedding. É o pipeline procedural mais eficaz conhecido (~50,8% resolve no SWE-bench). Fonte: [Dissecting the SWE-Bench Leaderboards](https://arxiv.org/html/2506.17208v2), [Agentless-Lite](https://github.com/sorendunn/Agentless-Lite).
- **LocAgent** (ACL 2025): parseia o repo em **grafo heterogêneo dirigido** (arquivos, classes, funções; arestas de import/invocação/herança) e dá ao LLM ferramentas de busca multi-hop sobre esse grafo. Resultado: **até 92,7% de acurácia file-level** com Qwen-Coder-32B fine-tunado, custo ~86% menor que modelos proprietários, e **+12% de resolução downstream**. Fonte: [arXiv 2503.09089](https://arxiv.org/abs/2503.09089), [repo](https://github.com/gersteinlab/LocAgent).
- **SweRank / SweRank+** (Salesforce): **retrieve-and-rerank** — bi-encoder (SweRankEmbed) treinado em pares issue→código minerados de PRs reais (dataset SWELoc) + reranker LLM listwise. **Supera métodos agênticos e todos os retrievers anteriores no SWE-Bench-Lite e LocBench**, com custo muito menor que agentes. Fontes: [arXiv 2505.07849](https://arxiv.org/abs/2505.07849), [SweRank+ 2512.20482](https://arxiv.org/abs/2512.20482).
- **Baselines**: BM25 puro segue competitivo; a maioria dos métodos LLM fica acima do envelope BM25, mas modelos pequenos podem ficar abaixo. Recall file-level de agentes varia 42,5–81,4% conforme modelo. Issues multi-arquivo são o gargalo: **80% dos issues do SWE-Bench PRO tocam múltiplos arquivos** (vs 14% no Verified) — é onde precision/recall despencam. Fontes: [Exploration Structure in LLM Agents](https://arxiv.org/pdf/2606.11976), [BLAgent](https://arxiv.org/pdf/2605.17965).
- **Métrica**: a literatura reporta Acc@k / MAP / MRR, não precision/recall crus — comparar seu platô de 50% com Acc@5 de ~90% dos SOTA exige alinhar a métrica.

### 1.2 RAG sobre código: o que mede melhor

Ranking prático de eficácia por custo: **BM25 híbrido < embeddings de código treinados em issue→diff (SweRank) < grafo de código + navegação agêntica (LocAgent)**. GraphRAG genérico (entidades/comunidades) ajuda pouco em código; o que funciona é **grafo estrutural** (call/import graph) usado como índice navegável ou para expandir vizinhos de candidatos. Fontes: [When to use Graphs in RAG](https://arxiv.org/pdf/2506.05690), [GRACE](https://arxiv.org/html/2509.05980v1), [LARGER](https://arxiv.org/pdf/2605.16352), [Meta-RAG com sumarização de código](https://arxiv.org/pdf/2508.02611).

O **repo map do Aider** é a referência de "mapa comprimido": tree-sitter extrai símbolos, grafo arquivo→arquivo por referências, **PageRank personalizado** com boost 10x para identificadores mencionados no texto da task — exatamente o upgrade natural do seu mapa estático de 107 módulos. Fonte: [aider.chat/docs/repomap](https://aider.chat/docs/repomap.html), [post técnico](https://aider.chat/2023/10/22/repomap.html).

### 1.3 Ferramentas comerciais

- **Copilot Workspace**: pipeline issue → *spec* (estado atual/desejado) → **plano com lista explícita de arquivos a modificar** (editável pelo usuário) → implementação. Ou seja: trata a predição de arquivos como artefato de primeira classe, revisável por humano. Fonte: [githubnext.com/projects/copilot-workspace](https://githubnext.com/projects/copilot-workspace/).
- **Devin / Cursor background agents**: exploração agêntica livre (grep/read iterativo) — alta cobertura, custo alto e latência de minutos; Devin reconhecidamente sofre em monorepos legados. Fonte: [comparativo](https://www.idlen.io/blog/claude-code-vs-copilot-workspace-vs-cursor-composer/).
- **Linear/Jira AI**: fazem triagem, dedupe e sugestão de assignee/labels — **nenhuma prevê arquivos**; sinal de que o produto viável é "candidatos + evidência", não predição fechada.

### 1.4 Estimativa de esforço (story points) por ML

- SOTA: GPT2SP com **MAE mediano ~1,16 SP**; SBERT+GBT e comparative learning melhoram marginalmente. Fontes: [Comparative Learning](https://arxiv.org/abs/2507.14642), [SBERT+GBT](https://www.mdpi.com/2076-3417/14/16/7305).
- LLMs: few-shot otimizado dá ~59% de melhora de MAE vs zero-shot; fine-tune cross-project ajuda. Fontes: [SB LLM Shot Optimisation](https://vtawosi.github.io/files/SB_LLM_Shot_optimisation.pdf), [Story Point Estimation Using LLMs](https://arxiv.org/html/2603.06276v1), [Llama3SP](https://www.sciencedirect.com/science/article/pii/S2949719125000652).
- **Limite conhecido**: story points são calibração local do time; regressão exata tem teto baixo ([lições industriais, IEEE](https://ieeexplore.ieee.org/document/9582288/)). Consenso prático: **classificar em buckets (P/M/G) via k-NN de PRs históricos similares** supera regressão de pontos — seus 50% em regressão são esperados; em 3 buckets, 70%+ é alcançável.

### 1.5 Agentic retrieval vs pipeline fixo

Ganhos reportados: LocAgent +12% resolução downstream vs pipelines; agentic RAG genérico 34%→78% em queries complexas ([Particula](https://particula.tech/blog/agentic-rag-agent-controlled-retrieval), fonte vendor — tratar como direcional); iterativo resolve classe de problemas que single-shot falha ([Fishing for Answers](https://arxiv.org/html/2509.04820v1)). **Porém SweRank mostra que retrieve-and-rerank bem treinado bate agentes gastando fração do custo** — relevante para sua cota ChatGPT limitada. O meio-termo vencedor: **loop agêntico curto e limitado (3–6 tool calls) sobre índice pré-computado**.

## 2. Tabela comparativa

| Abordagem | Custo LLM/task | Complexidade infra | Acc@5 file esperada | Fit Lambda |
|---|---|---|---|---|
| A. Atual (lexical + 2 calls fixas) | 2 calls | baixa | ~50% (medido) | ok |
| B. BM25 híbrido (código+PRs) + co-change mining + 1 call | 1 call | baixa (SQLite FTS5) | 60–70% | ótimo |
| C. Retrieve-and-rerank (embeddings SweRank-style + reranker) | 1–2 calls | média (índice vetorial offline) | 75–85% | bom |
| D. Grafo de código + loop agêntico limitado (LocAgent-lite) | 4–8 calls | média-alta (grafo pré-computado) | 85–92% | ok (timeout!) |
| E. Agente livre (Devin-style, grep/read iterativo) | 15–50 calls | alta | 80–90%, alta variância | ruim |

## 3. Recomendação — arquitetura v7

Para Lambda + cota ChatGPT limitada + monolito Laravel 4k arquivos: **B como base, C como ranking, D como fallback seletivo.**

1. **Offline (build noturno, fora da Lambda):**
   - Grafo de código PHP via tree-sitter/nikic parser: arquivo→classe→método, arestas de use/extends/chamada, rotas→controllers→models→views. Laravel é altamente convencional — explore isso (Route::, FormRequest, Job, Listener).
   - **Repo map estilo Aider**: PageRank do grafo, personalizado por termos da task (boost em identificadores mencionados).
   - **Matriz de co-change dos 476 PRs** (evolutionary coupling): P(arquivo B muda | arquivo A muda). É seu ativo mais subutilizado — expande candidatos multi-arquivo, o gargalo dos seus 55% de recall.
   - Índice híbrido em **SQLite (FTS5 + sqlite-vec)** empacotado no layer da Lambda: BM25 sobre símbolos+docblocks+títulos/diffs de PRs, embeddings pré-computados por arquivo/classe (modelo pequeno, ex. text-embedding-3-small, custo one-off).
2. **Online (por task):**
   - Retrieval híbrido sem LLM: BM25 + vetorial + PageRank personalizado → top-30 candidatos → **expansão por co-change** → top-50.
   - **1 chamada LLM de rerank listwise** (gpt-5.4-mini): recebe candidatos com assinaturas/sumários, devolve top-k arquivos + módulos com justificativa. (padrão SweRank)
   - **Fallback agêntico limitado**: se confiança do rerank < threshold, 1 rodada extra com ferramentas read-only sobre o índice (search_symbol, neighbors, view_skeleton), máx. 4 tool calls. (padrão LocAgent, cabe no timeout da Lambda)
3. **Esforço:** abandonar regressão de pontos. **k-NN sobre PRs históricos**: recuperar 5 PRs mais similares (mesmo índice), apresentar ao LLM os tamanhos reais (arquivos tocados, linhas, lead time) e pedir **classificação em bucket P/M/G + intervalo**, com os vizinhos como evidência exibível ao usuário.
4. **Métrica:** migrar para Acc@5/Acc@10 e MAP por arquivo E por módulo; separar avaliação single-file vs multi-file (é onde o ganho da co-change vai aparecer).

Expectativa realista v7: **Acc@5 de módulo 75–85%, recall multi-arquivo +15–20pp, esforço em buckets ~70%**, com 1–2 chamadas LLM por task (menos que hoje).
