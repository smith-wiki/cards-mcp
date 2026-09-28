// Minimal GitHub REST client: tree listing, blob reads, and single-commit file additions
// through the Git Data API.

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "smith-wiki-cards-mcp";
const COMMIT_ATTEMPTS = 5;

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export class GitHub {
  constructor(
    private readonly repository: string,
    private readonly branch: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${API}/repos/${this.repository}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
    const text = await response.text();
    if (!response.ok && response.status !== 422 && response.status !== 409) {
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  private async ok<T>(path: string, init?: RequestInit): Promise<T> {
    const { status, body } = await this.request<T>(path, init);
    if (status >= 300) throw new Error(`GitHub ${init?.method ?? "GET"} ${path} failed: HTTP ${status}`);
    return body;
  }

  /** Every entry of the branch's tree. */
  async tree(): Promise<TreeEntry[]> {
    const body = await this.ok<{ tree: TreeEntry[]; truncated: boolean }>(
      `/git/trees/${encodeURIComponent(this.branch)}?recursive=1`,
    );
    if (body.truncated) console.warn(`${this.repository}: tree listing truncated`);
    return body.tree;
  }

  async blobText(sha: string): Promise<string> {
    const body = await this.ok<{ content: string; encoding: string }>(`/git/blobs/${sha}`);
    if (body.encoding !== "base64") throw new Error(`unexpected blob encoding ${body.encoding}`);
    const bytes = Uint8Array.from(atob(body.content.replace(/\n/g, "")), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /**
   * Adds `files` (path → UTF-8 content) on top of the branch head in one commit.
   * Retries from the new head when the ref moved (non-fast-forward).
   */
  async addFiles(files: Record<string, string>, message: string): Promise<string> {
    const blobs = await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const blob = await this.ok<{ sha: string }>("/git/blobs", {
          method: "POST",
          body: JSON.stringify({ content, encoding: "utf-8" }),
        });
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      }),
    );
    const ref = `heads/${this.branch}`;
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
      const head = await this.ok<{ object: { sha: string } }>(`/git/ref/${ref}`);
      const parent = await this.ok<{ tree: { sha: string } }>(`/git/commits/${head.object.sha}`);
      const tree = await this.ok<{ sha: string }>("/git/trees", {
        method: "POST",
        body: JSON.stringify({ base_tree: parent.tree.sha, tree: blobs }),
      });
      const commit = await this.ok<{ sha: string }>("/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: [head.object.sha] }),
      });
      const update = await this.request(`/git/refs/${ref}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      if (update.status < 300) return commit.sha;
    }
    throw new Error(`GitHub: ${this.repository}@${this.branch} kept moving; commit not applied after ${COMMIT_ATTEMPTS} attempts`);
  }
}
