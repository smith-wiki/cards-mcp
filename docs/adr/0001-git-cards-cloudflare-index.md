# Cards live in git; Cloudflare holds only a derived index

Every Card is a directory of files in the append-only `smith-wiki/cards` repository, and that repository is the only source of truth: the Card site is built from it, and its CI publishes each Card to Bluesky only after the Card's page is live, so the link in an immutable post never points at a missing page. The MCP Worker writes Cards there through the GitHub API and keeps D1, Vectorize, and R2 on Cloudflare only as a search index and image store that can be rebuilt from the repositories. We rejected publishing to Bluesky directly from the MCP call (the page would not exist yet) and a database as the record of Cards (it would be a second truth beside the site's sources).

## Consequences

- A Card reaches Bluesky minutes after `create_card`, not instantly.
- Card IDs are Bluesky TIDs generated at creation, so post URIs are known in advance and a retried publication cannot duplicate a post.
- Blog post Cards stay in the blog repository and are only indexed.
