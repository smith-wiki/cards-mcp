# smith-wiki-cards-mcp

The Smith Wiki MCP server: a Cloudflare Worker at `https://cards-mcp.smith.wiki/mcp` through
which ChatGPT reads and writes Cards. Terms follow [CONTEXT.md](CONTEXT.md); the architecture is
recorded in [docs/adr/0001](docs/adr/0001-git-cards-cloudflare-index.md).

- **Writes** a Card as `cards/<id>/index.md` (plus `article.md`) in one commit to
  `smith-wiki/cards` through the GitHub Git Data API. That repository is the source of truth; its
  CI builds the Card site and publishes the Card to Bluesky once the page is live.
- **Stores images** in the public R2 bucket `smith-wiki-cards` (`https://cards-files.smith.wiki/<sha256>.<ext>`),
  shrunk to at most 1,000,000 bytes.
- **Indexes** every Card in D1 (rows) and Vectorize (Workers AI `@cf/baai/bge-m3` embeddings of
  the Short text and the full text). The index is derived and append-only; a cron trigger every
  15 minutes adds Cards that reached the cards repo another way, and blog Cards: Blog posts in
  `andysmith-ai/andysmith.ai` whose Bluesky announcement receipt says `published`.

Nothing here edits or deletes a Card, a file, or an index row.

## Tools

| Tool | Hints | Purpose |
| --- | --- | --- |
| `create_card({author, parent_id?, short_text, attachment?})` | not read-only, not destructive | Validates every rule, resolves the parent and `[anchor](card:<id>)` links, stores images, commits, indexes. Returns `{id, page_url, bluesky_url, status: "pending"}`. Invalid input returns a tool error listing every problem. |
| `search_cards({query, author?, limit?})` | read-only | Semantic search; `{cards: [{id, author, created, short_text, url}]}`, best first (limit 1–50, default 10). |
| `get_cards({ids, full?})` | read-only | Up to 50 Cards with parent, replies (oldest first), and `full_text` when `full` is true; unknown ids in `not_found`. |

Rules enforced by `create_card` (the tool description tells ChatGPT the same):

- Every text field uses only printable ASCII, newline, NBSP, U+00C0–U+017F, and
  `‘ ’ “ ” – — … • · × ÷ ± ≤ ≥ ≠ ≈ → ← ↔ °`; errors name each character, code point, and position.
- Short text: at most 300 characters after replacing each `[anchor](card:<id>)` with its anchor;
  no other links, no URLs. External URLs go in a Link Attachment.
- Operator Cards always have a parent and never an Article. Agent Cards may be roots.
- At most one Attachment: 1–4 images with alt text, a Link, or an Article.

## Development

Node is provided by the flake:

```sh
nix develop -c npm install
nix develop -c npm test        # vitest
nix develop -c npm run check   # tsc
```

`npm run dev` runs `wrangler dev`. Put `DEV_AUTH_BYPASS="1"` in `.dev.vars` to skip the Access
check locally — **development only; never set it in production**. Workers AI runs remotely
(needs `wrangler login`) and Vectorize is not available in local mode, so search and indexing
only work against deployed resources.

## Provisioning

All commands run inside `nix develop`.

1. **D1** — create the database, put the printed id into `wrangler.toml` (`database_id`), and apply
   the migration:

   ```sh
   npx wrangler d1 create smith-wiki-cards
   npm run migrate
   ```

2. **Vectorize** — 1024 dimensions (bge-m3), cosine, with a metadata index for the author filter:

   ```sh
   npx wrangler vectorize create smith-wiki-cards --dimensions=1024 --metric=cosine
   npx wrangler vectorize create-metadata-index smith-wiki-cards --property-name author --type string
   ```

3. **R2** — create the bucket and connect the public custom domain:

   ```sh
   npx wrangler r2 bucket create smith-wiki-cards
   npx wrangler r2 bucket domain add smith-wiki-cards --domain cards-files.smith.wiki --zone-id <smith.wiki zone id>
   ```

4. **Workers AI and Images** need no setup beyond the bindings in `wrangler.toml`.

5. **Vars and secrets** — set `AGENT_DID` and `OPERATOR_DID` (the two Bluesky DIDs) in
   `wrangler.toml`, then the GitHub token (fine-grained: contents read/write on `smith-wiki/cards`,
   contents read on `andysmith-ai/andysmith.ai`):

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   ```

6. **Cloudflare Access** — in Zero Trust → Access → Applications, add an **MCP server**
   application for `cards-mcp.smith.wiki`:
   - enable Managed OAuth and allow dynamic client registration, with the allowed redirect URI
     `https://chatgpt.com/connector_platform_oauth_redirect`;
   - one Allow policy whose only include rule is the Operator's email address;
   - copy the team domain (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN` and the
     application's AUD tag into `ACCESS_AUD`.

   The Worker rejects any `/mcp` request without a valid `Cf-Access-Jwt-Assertion` (RS256, keys
   from `https://<team>/cdn-cgi/access/certs`, matching issuer and audience, unexpired) with 401.

7. **Deploy** — `npm run deploy`. The custom domain route `cards-mcp.smith.wiki` and the
   15-minute cron trigger come from `wrangler.toml`.

8. **ChatGPT** — enable Developer Mode (Settings → Apps & Connectors → Advanced), create a
   connector with URL `https://cards-mcp.smith.wiki/mcp` and OAuth authentication, and sign in
   through Access as the Operator.
