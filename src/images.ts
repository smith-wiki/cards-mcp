// Fetches Card images, shrinks them to Bluesky's blob limit, and stores them in R2
// under their content hash.
import { trimSlash, type Env } from "./env";

export const IMAGE_MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_WIDTH = 2000;
const JPEG_QUALITIES = [85, 75, 65, 55, 45, 35];
/** Types Bluesky shows as-is; anything else is transcoded to JPEG. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface StoredImage {
  src: string;
  mime: string;
}

async function download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be fetched";
    throw new Error(`image ${url} ${reason}`);
  }
  if (!response.ok) throw new Error(`image ${url} returned HTTP ${response.status}`);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) throw new Error(`image ${url} has content type "${mime || "none"}", not image/*`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime };
}

async function toJpeg(env: Env, url: string, bytes: Uint8Array): Promise<Uint8Array> {
  for (const quality of JPEG_QUALITIES) {
    const result = await env.IMAGES.input(new Response(bytes).body!)
      .transform({ width: MAX_WIDTH, fit: "scale-down" })
      .output({ format: "image/jpeg", quality });
    const out = new Uint8Array(await result.response().arrayBuffer());
    if (out.byteLength <= IMAGE_MAX_BYTES) return out;
  }
  throw new Error(`image ${url} stays above ${IMAGE_MAX_BYTES} bytes even as a low-quality JPEG`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stores the image at `<sha256>.<ext>` in R2 (once) and returns its public URL and type. */
export async function storeImage(env: Env, url: string): Promise<StoredImage> {
  let { bytes, mime } = await download(url);
  if (bytes.byteLength > IMAGE_MAX_BYTES || !(mime in EXTENSIONS)) {
    bytes = await toJpeg(env, url, bytes);
    mime = "image/jpeg";
  }
  const key = `${await sha256Hex(bytes)}.${EXTENSIONS[mime]}`;
  if (!(await env.FILES.head(key))) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  }
  return { src: `${trimSlash(env.FILES_BASE_URL)}/${key}`, mime };
}
