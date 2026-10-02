// Copies Attachment files from their sources — URLs or files ChatGPT passes, both
// temporary — into R2: a Card links only to files.smith.wiki, never to a source.
import { trimSlash, type Env } from "./env";

export const SOURCE_TIMEOUT_MS = 30_000;
export const VIDEO_TIMEOUT_MS = 120_000;
export const HTML_MAX_BYTES = 10_000_000;
/** Bluesky's limit for a video blob (`app.bsky.embed.video`). */
export const VIDEO_MAX_BYTES = 100_000_000;

/** Types a server sends when it does not know; the sender's hints or an extension decide instead. */
const UNKNOWN_TYPES: Record<string, true> = { "": true, "application/octet-stream": true, "binary/octet-stream": true, "text/plain": true };

const VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
const VIDEO_TYPES_BY_EXTENSION: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

/** Where an Attachment file comes from. */
export interface FileSource {
  url: string;
  /** Names the file in errors, e.g. `image https://…` or `file "chart.png"`. */
  what: string;
  /** The sender's media type and file name (ChatGPT file params), used when the server's type says nothing. */
  mime?: string;
  name?: string;
}

export interface Source {
  response: Response;
  /** Lower-case media type without parameters. */
  mime: string;
}

/**
 * GETs a file. `typesByExtension` maps a lower-case extension (of the file name,
 * else of the URL path) to the media type it implies when neither the server
 * nor the sender gives a useful type.
 */
export async function fetchSource(source: FileSource, timeoutMs: number, typesByExtension: Record<string, string>): Promise<Source> {
  const { url, what } = source;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be fetched";
    throw new Error(`${what} ${reason}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${what} returned HTTP ${response.status}`);
  }
  const declared = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!Object.hasOwn(UNKNOWN_TYPES, declared)) return { response, mime: declared };
  const hinted = (source.mime ?? "").split(";")[0].trim().toLowerCase();
  if (!Object.hasOwn(UNKNOWN_TYPES, hinted)) return { response, mime: hinted };
  for (const path of [source.name ?? "", new URL(url).pathname]) {
    const extension = /\.([a-z0-9]+)$/.exec(path.toLowerCase())?.[1];
    if (extension && Object.hasOwn(typesByExtension, extension)) return { response, mime: typesByExtension[extension] };
  }
  return { response, mime: declared };
}

/** The whole body, refused as soon as it passes `max` bytes. */
export async function readBody(response: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) {
    await response.body?.cancel();
    throw new Error(`${what} is ${declared} bytes; the limit is ${max}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      // Leaving the loop cancels the download.
      if (size > max) throw new Error(`${what} is over ${max} bytes, the limit`);
      chunks.push(chunk);
    }
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stores `bytes` at `cards/<sha256>.<extension>` (once) and returns the public URL. */
export async function storeContent(env: Env, bytes: Uint8Array, extension: string, contentType: string): Promise<string> {
  // Keys live under `cards/`: the bucket is shared by future wiki iterations.
  const key = `cards/${await sha256Hex(bytes)}.${extension}`;
  if (!(await env.FILES.head(key))) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  }
  return `${trimSlash(env.FILES_BASE_URL)}/${key}`;
}

export interface StoredVideo {
  src: string;
  mime: string;
}

/** R2 multipart part size; every part but the last must be at least 5 MiB. */
const PART_BYTES = 10 * 1024 * 1024;

/** Uploads a stream of unknown length in parts, refusing it once it passes VIDEO_MAX_BYTES. */
async function putInParts(env: Env, key: string, body: ReadableStream<Uint8Array>, contentType: string, what: string): Promise<void> {
  const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType } });
  const parts: R2UploadedPart[] = [];
  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let total = 0;
  const flush = async () => {
    parts.push(await upload.uploadPart(parts.length + 1, await new Blob(chunks).arrayBuffer()));
    chunks = [];
    buffered = 0;
  };
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > VIDEO_MAX_BYTES) throw new Error(`${what} is over ${VIDEO_MAX_BYTES} bytes, the limit`);
      chunks.push(chunk);
      buffered += chunk.byteLength;
      if (buffered >= PART_BYTES) await flush();
    }
    if (buffered > 0 || parts.length === 0) await flush();
    await upload.complete(parts);
  } catch (error) {
    await upload.abort();
    throw error;
  }
}

/**
 * Streams the video into R2 without holding it in memory, so it cannot be
 * hashed first: its key is random.
 */
export async function storeVideo(env: Env, source: FileSource): Promise<StoredVideo> {
  const { what } = source;
  const { response, mime } = await fetchSource(source, VIDEO_TIMEOUT_MS, VIDEO_TYPES_BY_EXTENSION);
  const extension = Object.hasOwn(VIDEO_EXTENSIONS, mime) ? VIDEO_EXTENSIONS[mime] : undefined;
  const length = Number(response.headers.get("content-length"));
  let problem: string | undefined;
  if (!extension) problem = `${what} has content type "${mime || "none"}", not MP4, WebM, or QuickTime video`;
  else if (length > VIDEO_MAX_BYTES) problem = `${what} is ${length} bytes; the limit is ${VIDEO_MAX_BYTES}`;
  if (problem) {
    await response.body?.cancel();
    throw new Error(problem);
  }
  const key = `cards/${crypto.randomUUID()}.${extension}`;
  try {
    if (length > 0) {
      // R2 needs the length up front; the stream fails if the body does not match it.
      await env.FILES.put(key, response.body!.pipeThrough(new FixedLengthStream(length)), { httpMetadata: { contentType: mime } });
    } else {
      await putInParts(env, key, response.body!, mime, what);
    }
  } catch (error) {
    throw new Error(`${what} could not be stored: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { src: `${trimSlash(env.FILES_BASE_URL)}/${key}`, mime };
}

/** Stores a self-contained HTML page by content hash and returns its public URL. */
export async function storeHtml(env: Env, source: FileSource): Promise<string> {
  const { what } = source;
  const { response, mime } = await fetchSource(source, SOURCE_TIMEOUT_MS, { html: "text/html", htm: "text/html" });
  if (mime !== "text/html") {
    await response.body?.cancel();
    throw new Error(`${what} has content type "${mime || "none"}", not text/html`);
  }
  // Keep the declared charset; without one the browser reads the page's <meta charset>.
  const charset = /;\s*charset=([^;\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  const bytes = await readBody(response, HTML_MAX_BYTES, what);
  return storeContent(env, bytes, "html", charset ? `text/html; charset=${charset}` : "text/html");
}
