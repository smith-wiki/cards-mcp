// In-memory stand-ins for the Worker's bindings and GitHub, for tests only.
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env";
import { SCHEMA } from "../src/schema";

/** D1 subset backed by a real SQLite database with the real schema applied. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async all() {
      return { results: db.prepare(sql).all(...(params as never[])), success: true, meta: {} };
    },
    async first() {
      return db.prepare(sql).get(...(params as never[])) ?? null;
    },
    async run() {
      db.prepare(sql).run(...(params as never[]));
      return { results: [], success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}

const DIMENSIONS = 64;

/** Bag-of-words embedding: texts sharing words get similar vectors. */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export interface Fakes {
  env: Env;
  vectors: Map<string, VectorizeVector>;
  files: Map<string, { bytes: Uint8Array; contentType?: string }>;
  transcodes: number[];
}

export function makeEnv(overrides: Partial<Env> = {}): Fakes {
  const vectors = new Map<string, VectorizeVector>();
  const files = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const transcodes: number[] = [];

  const VECTORS = {
    async insert(items: VectorizeVector[]) {
      for (const item of items) if (!vectors.has(item.id)) vectors.set(item.id, item);
      return { mutationId: "m" };
    },
    async query(query: number[], options: VectorizeQueryOptions = {}) {
      const matches = [...vectors.values()]
        // Strictest reading of Vectorize: a query without a namespace sees only vectors without one.
        .filter((item) => item.namespace === options.namespace)
        .map((item) => ({
          id: item.id,
          score: (item.values as number[]).reduce((sum, value, i) => sum + value * query[i], 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK ?? 5);
      return { matches, count: matches.length };
    },
  } as unknown as Vectorize;

  const AI = {
    async run(_model: string, input: { text: string[] }) {
      return { data: input.text.map(fakeEmbedding), shape: [input.text.length, DIMENSIONS] };
    },
  } as unknown as Ai;

  const FILES = {
    async head(key: string) {
      return files.has(key) ? { key } : null;
    },
    async put(key: string, value: Uint8Array, options?: R2PutOptions) {
      const metadata = options?.httpMetadata as R2HTTPMetadata | undefined;
      files.set(key, { bytes: new Uint8Array(value), contentType: metadata?.contentType });
      return { key };
    },
  } as unknown as R2Bucket;

  // Transcoding "shrinks" the image to (quality * 10_000) bytes, so the retry ladder is observable.
  const IMAGES = {
    input() {
      const transformer = {
        transform: () => transformer,
        async output(options: { quality: number }) {
          transcodes.push(options.quality);
          const bytes = new Uint8Array(options.quality * 20_000).fill(options.quality);
          return { response: () => new Response(bytes), contentType: () => "image/jpeg" };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;

  const env: Env = {
    DB: fakeD1(),
    VECTORS,
    AI,
    FILES,
    IMAGES,
    CARDS_REPO: "smith-wiki/cards",
    CARDS_BRANCH: "main",
    CARD_SITE_URL: "https://andy.smith.wiki",
    FILES_BASE_URL: "https://files.smith.wiki",
    BLOG_REPO: "andysmith-ai/andysmith.ai",
    BLOG_BRANCH: "main",
    BLOG_SITE_URL: "https://andysmith.ai",
    BLOG_SINCE: "2000-01-01T00:00:00Z",
    AGENT_DID: "did:plc:agent",
    OPERATOR_DID: "did:plc:operator",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud-tag",
    GITHUB_TOKEN: "token",
    ...overrides,
  };
  return { env, vectors, files, transcodes };
}

/** Request bodies of the Git Data API calls the Worker makes. */
interface GitBody {
  content: string;
  base_tree: string;
  /** Entries when creating a tree; the tree SHA when creating a commit. */
  tree: { path: string; sha: string }[] | string;
  message: string;
  sha: string;
}

/** One GitHub repository: a flat map of path → content on a single branch, plus a commit log. */
export class FakeRepo {
  readonly commits: { message: string; files: Record<string, string> }[] = [];
  private blobs = new Map<string, string>();
  private trees = new Map<string, Record<string, string>>();
  private head = "c0";
  private commitTrees = new Map<string, string>([["c0", "t0"]]);
  private pendingCommits = new Map<string, { tree: string; message: string }>();
  /** Makes the next N ref updates fail as non-fast-forward. */
  rejectUpdates = 0;

  constructor(
    readonly name: string,
    files: Record<string, string> = {},
  ) {
    const tree: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) tree[path] = this.addBlob(content);
    this.trees.set("t0", tree);
  }

  private addBlob(content: string): string {
    const sha = `b${this.blobs.size}`;
    this.blobs.set(sha, content);
    return sha;
  }

  files(): Record<string, string> {
    const tree = this.trees.get(this.commitTrees.get(this.head)!)!;
    return Object.fromEntries(Object.entries(tree).map(([path, sha]) => [path, this.blobs.get(sha)!]));
  }

  async handle(method: string, path: string, body: GitBody): Promise<Response> {
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (method === "GET" && path.startsWith("/git/trees/")) {
      const tree = this.trees.get(this.commitTrees.get(this.head)!)!;
      const entries = Object.entries(tree).map(([p, sha]) => ({ path: p, type: "blob", sha }));
      return json({ tree: entries, truncated: false });
    }
    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const content = this.blobs.get(path.slice("/git/blobs/".length));
      if (content === undefined) return json({ message: "Not Found" }, 404);
      return json({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
    }
    if (method === "POST" && path === "/git/blobs") return json({ sha: this.addBlob(body.content) }, 201);
    if (method === "GET" && path.startsWith("/git/ref/heads/")) return json({ object: { sha: this.head } });
    if (method === "GET" && path.startsWith("/git/commits/")) {
      return json({ tree: { sha: this.commitTrees.get(path.slice("/git/commits/".length)) } });
    }
    if (method === "POST" && path === "/git/trees") {
      const tree = { ...this.trees.get(body.base_tree)! };
      for (const entry of body.tree as { path: string; sha: string }[]) tree[entry.path] = entry.sha;
      const sha = `t${this.trees.size}`;
      this.trees.set(sha, tree);
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = `c${this.commitTrees.size + this.pendingCommits.size}`;
      this.pendingCommits.set(sha, { tree: body.tree as string, message: body.message });
      return json({ sha }, 201);
    }
    if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      if (this.rejectUpdates > 0) {
        this.rejectUpdates--;
        return json({ message: "Update is not a fast forward" }, 422);
      }
      const pending = this.pendingCommits.get(body.sha)!;
      const before = this.files();
      this.commitTrees.set(body.sha, pending.tree);
      this.head = body.sha;
      const after = this.files();
      const added = Object.fromEntries(Object.entries(after).filter(([p]) => !(p in before)));
      this.commits.push({ message: pending.message, files: added });
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `unhandled ${method} ${path}` }, 500);
  }
}

/** A fetch that serves GitHub repositories and fixed external URLs. */
export function fakeFetch(repos: FakeRepo[], external: Record<string, () => Response> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.hostname === "api.github.com") {
      const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(url.pathname)!;
      const repo = repos.find((candidate) => candidate.name === match[1]);
      if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
      return repo.handle(method, match[2], (init?.body ? JSON.parse(String(init.body)) : {}) as GitBody);
    }
    const handler = external[url.href];
    if (!handler) throw new TypeError(`fetch failed: ${url.href}`);
    return handler();
  };
}
