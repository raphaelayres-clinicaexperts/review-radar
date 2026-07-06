import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadTokens, saveTokens } from "../src/services/tokens.ts";
import { localStoreFile, tableName } from "./env.ts";
import type {
  RunRecord,
  StoredReview,
  TaskAnalysisEntry,
  TaskFeedbackEntry,
  TaskIndexEntry,
  TokenData,
} from "./types.ts";

export interface Store {
  getTokens(): Promise<TokenData | null>;
  saveTokens(tokens: TokenData): Promise<void>;
  getLastReview(owner: string, repo: string, number: number): Promise<StoredReview | null>;
  saveReview(owner: string, repo: string, number: number, review: StoredReview): Promise<void>;
  tryDedup(owner: string, repo: string, number: number, sha: string): Promise<boolean>;
  saveRun(run: RunRecord): Promise<void>;
  listRuns(days: number): Promise<RunRecord[]>;
  saveTaskIndexEntry(entry: TaskIndexEntry): Promise<void>;
  listTaskIndexEntries(): Promise<TaskIndexEntry[]>;
  saveTaskFeedback(entry: TaskFeedbackEntry): Promise<void>;
  listTaskFeedback(): Promise<TaskFeedbackEntry[]>;
  saveTaskAnalysis(entry: TaskAnalysisEntry): Promise<void>;
  listTaskAnalyses(limit: number): Promise<TaskAnalysisEntry[]>;
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function taskAnalysisSk(entry: TaskAnalysisEntry): string {
  return `${entry.analyzedAt}#${entry.key ?? shortHash(entry.title)}`;
}

interface LocalStoreFile {
  tokens: TokenData | null;
  reviews: Record<string, StoredReview>;
  dedup: Record<string, true>;
  runs?: RunRecord[];
  taskIndex?: TaskIndexEntry[];
  taskFeedback?: TaskFeedbackEntry[];
  taskAnalyses?: TaskAnalysisEntry[];
}

function reviewKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

function dedupKey(owner: string, repo: string, number: number, sha: string): string {
  return `${owner}/${repo}#${number}@${sha}`;
}

export class FsStore implements Store {
  private readonly path: string;

  constructor(path: string = localStoreFile()) {
    this.path = path;
  }

  private read(): LocalStoreFile {
    if (!existsSync(this.path)) return { tokens: null, reviews: {}, dedup: {} };
    try {
      return JSON.parse(readFileSync(this.path, "utf-8")) as LocalStoreFile;
    } catch {
      return { tokens: null, reviews: {}, dedup: {} };
    }
  }

  private write(data: LocalStoreFile): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  async getTokens(): Promise<TokenData | null> {
    return loadTokens();
  }

  async saveTokens(tokens: TokenData): Promise<void> {
    saveTokens(tokens);
  }

  async getLastReview(owner: string, repo: string, number: number): Promise<StoredReview | null> {
    const data = this.read();
    return data.reviews[reviewKey(owner, repo, number)] ?? null;
  }

  async saveReview(owner: string, repo: string, number: number, review: StoredReview): Promise<void> {
    const data = this.read();
    data.reviews[reviewKey(owner, repo, number)] = review;
    this.write(data);
  }

  async tryDedup(owner: string, repo: string, number: number, sha: string): Promise<boolean> {
    const data = this.read();
    const key = dedupKey(owner, repo, number, sha);
    if (data.dedup[key]) return false;
    data.dedup[key] = true;
    this.write(data);
    return true;
  }

  async saveRun(run: RunRecord): Promise<void> {
    const data = this.read();
    data.runs = [...(data.runs ?? []), run];
    this.write(data);
  }

  async listRuns(days: number): Promise<RunRecord[]> {
    const data = this.read();
    const cutoff = Date.now() - days * 86_400_000;
    return (data.runs ?? []).filter((r) => Date.parse(r.at) >= cutoff);
  }

  async saveTaskIndexEntry(entry: TaskIndexEntry): Promise<void> {
    const data = this.read();
    data.taskIndex = [...(data.taskIndex ?? []), entry];
    this.write(data);
  }

  async listTaskIndexEntries(): Promise<TaskIndexEntry[]> {
    const data = this.read();
    return data.taskIndex ?? [];
  }

  async saveTaskFeedback(entry: TaskFeedbackEntry): Promise<void> {
    const data = this.read();
    data.taskFeedback = [...(data.taskFeedback ?? []), entry];
    this.write(data);
  }

  async listTaskFeedback(): Promise<TaskFeedbackEntry[]> {
    const data = this.read();
    return data.taskFeedback ?? [];
  }

  async saveTaskAnalysis(entry: TaskAnalysisEntry): Promise<void> {
    const data = this.read();
    data.taskAnalyses = [...(data.taskAnalyses ?? []), entry];
    this.write(data);
  }

  async listTaskAnalyses(limit: number): Promise<TaskAnalysisEntry[]> {
    const data = this.read();
    return [...(data.taskAnalyses ?? [])]
      .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))
      .slice(0, limit);
  }
}

type AttributeValue = { S: string } | { N: string } | { NULL: true };

function toItemTokens(tokens: TokenData): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {
    PK: { S: "TOKENS#codex" },
    SK: { S: "TOKENS#codex" },
    access_token: { S: tokens.access_token },
    account_id: { S: tokens.account_id },
    expires_at: { N: String(tokens.expires_at) },
  };
  if (tokens.refresh_token) item.refresh_token = { S: tokens.refresh_token };
  if (tokens.id_token) item.id_token = { S: tokens.id_token };
  return item;
}

function fromItemTokens(item: Record<string, AttributeValue>): TokenData {
  return {
    access_token: (item.access_token as { S: string }).S,
    refresh_token: item.refresh_token ? (item.refresh_token as { S: string }).S : "",
    account_id: (item.account_id as { S: string }).S,
    expires_at: Number((item.expires_at as { N: string }).N),
    id_token: item.id_token ? (item.id_token as { S: string }).S : undefined,
  };
}

export class DynamoStore implements Store {
  private readonly table: string;
  private clientPromise: Promise<import("@aws-sdk/client-dynamodb").DynamoDBClient> | null = null;

  constructor(table: string = tableName()) {
    this.table = table;
  }

  private async client(): Promise<import("@aws-sdk/client-dynamodb").DynamoDBClient> {
    if (!this.clientPromise) {
      this.clientPromise = import("@aws-sdk/client-dynamodb").then(
        ({ DynamoDBClient }) => new DynamoDBClient({})
      );
    }
    return this.clientPromise;
  }

  async getTokens(): Promise<TokenData | null> {
    const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const res = await client.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { PK: { S: "TOKENS#codex" }, SK: { S: "TOKENS#codex" } },
      })
    );
    if (!res.Item) return null;
    return fromItemTokens(res.Item as Record<string, AttributeValue>);
  }

  async saveTokens(tokens: TokenData): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    await client.send(
      new PutItemCommand({ TableName: this.table, Item: toItemTokens(tokens) })
    );
  }

  async getLastReview(owner: string, repo: string, number: number): Promise<StoredReview | null> {
    const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const key = `REVIEW#${owner}/${repo}#${number}`;
    const res = await client.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { PK: { S: key }, SK: { S: key } },
      })
    );
    if (!res.Item?.data) return null;
    return JSON.parse((res.Item.data as { S: string }).S) as StoredReview;
  }

  async saveReview(owner: string, repo: string, number: number, review: StoredReview): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const key = `REVIEW#${owner}/${repo}#${number}`;
    await client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: { PK: { S: key }, SK: { S: key }, data: { S: JSON.stringify(review) } },
      })
    );
  }

  async tryDedup(owner: string, repo: string, number: number, sha: string): Promise<boolean> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const key = `DEDUP#${owner}/${repo}#${number}#${sha}`;
    try {
      await client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { PK: { S: key }, SK: { S: key }, createdAt: { S: new Date().toISOString() } },
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async saveRun(run: RunRecord): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    await client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          PK: { S: "RUN" },
          SK: { S: `${run.at}#${run.pr}` },
          data: { S: JSON.stringify(run) },
        },
      })
    );
  }

  async listRuns(days: number): Promise<RunRecord[]> {
    const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const runs: RunRecord[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND SK >= :cutoff",
          ExpressionAttributeValues: { ":pk": { S: "RUN" }, ":cutoff": { S: cutoff } },
          ExclusiveStartKey: startKey,
        })
      );
      for (const item of res.Items ?? []) {
        runs.push(JSON.parse((item.data as { S: string }).S) as RunRecord);
      }
      startKey = res.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (startKey);
    return runs;
  }

  async saveTaskIndexEntry(entry: TaskIndexEntry): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    await client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          PK: { S: "TASKIDX" },
          SK: { S: `${entry.mergedAt}#${entry.pr}` },
          data: { S: JSON.stringify(entry) },
        },
      })
    );
  }

  async listTaskIndexEntries(): Promise<TaskIndexEntry[]> {
    const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const items: TaskIndexEntry[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": { S: "TASKIDX" } },
          ExclusiveStartKey: startKey,
        })
      );
      for (const item of res.Items ?? []) {
        items.push(JSON.parse((item.data as { S: string }).S) as TaskIndexEntry);
      }
      startKey = res.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (startKey);
    return items;
  }

  async saveTaskFeedback(entry: TaskFeedbackEntry): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    await client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          PK: { S: "TASKFB" },
          SK: { S: `${entry.at}#${entry.modulePath}` },
          data: { S: JSON.stringify(entry) },
        },
      })
    );
  }

  async listTaskFeedback(): Promise<TaskFeedbackEntry[]> {
    const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const items: TaskFeedbackEntry[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": { S: "TASKFB" } },
          ExclusiveStartKey: startKey,
        })
      );
      for (const item of res.Items ?? []) {
        items.push(JSON.parse((item.data as { S: string }).S) as TaskFeedbackEntry);
      }
      startKey = res.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (startKey);
    return items;
  }

  async saveTaskAnalysis(entry: TaskAnalysisEntry): Promise<void> {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    await client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          PK: { S: "TASKAN" },
          SK: { S: taskAnalysisSk(entry) },
          data: { S: JSON.stringify(entry) },
        },
      })
    );
  }

  async listTaskAnalyses(limit: number): Promise<TaskAnalysisEntry[]> {
    const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
    const client = await this.client();
    const res = await client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": { S: "TASKAN" } },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items ?? []).map((item) => JSON.parse((item.data as { S: string }).S) as TaskAnalysisEntry);
  }
}

export function createStore(mode: "fs" | "dynamo"): Store {
  return mode === "dynamo" ? new DynamoStore() : new FsStore();
}
