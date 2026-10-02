// Fetches Card images, shrinks them to Bluesky's blob limit, and stores them in R2
// under their content hash.
import type { Env } from "./env";
import { SOURCE_TIMEOUT_MS, fetchSource, readBody, storeContent, type FileSource } from "./files";

export const IMAGE_MAX_BYTES = 1_000_000;
/** The Images binding's input limit. */
const SOURCE_MAX_BYTES = 20_000_000;
const MAX_WIDTH = 2000;
const JPEG_QUALITIES = [85, 75, 65, 55, 45, 35];
/** Types Bluesky shows as-is; anything else is transcoded to JPEG. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const TYPES_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
};

export interface StoredImage {
  src: string;
  mime: string;
}

async function toJpeg(env: Env, what: string, bytes: Uint8Array): Promise<Uint8Array> {
  for (const quality of JPEG_QUALITIES) {
    const result = await env.IMAGES.input(new Response(bytes).body!)
      .transform({ width: MAX_WIDTH, fit: "scale-down" })
      .output({ format: "image/jpeg", quality });
    const out = new Uint8Array(await result.response().arrayBuffer());
    if (out.byteLength <= IMAGE_MAX_BYTES) return out;
  }
  throw new Error(`${what} stays above ${IMAGE_MAX_BYTES} bytes even as a low-quality JPEG`);
}

/** Stores the image at `cards/<sha256>.<ext>` in R2 (once) and returns its public URL and type. */
export async function storeImage(env: Env, source: FileSource): Promise<StoredImage> {
  const { what } = source;
  const { response, mime: declared } = await fetchSource(source, SOURCE_TIMEOUT_MS, TYPES_BY_EXTENSION);
  let problem: string | undefined;
  if (!declared.startsWith("image/")) problem = `${what} has content type "${declared || "none"}", not image/*`;
  // Cloudflare Images passes SVG through untouched, so it would never become a raster Bluesky shows.
  else if (declared === "image/svg+xml") problem = `${what} is an SVG; give a raster image (PNG, JPEG, WebP, or GIF)`;
  if (problem) {
    await response.body?.cancel();
    throw new Error(problem);
  }
  let bytes = await readBody(response, SOURCE_MAX_BYTES, what);
  let mime = declared;
  if (bytes.byteLength > IMAGE_MAX_BYTES || !Object.hasOwn(EXTENSIONS, mime)) {
    bytes = await toJpeg(env, what, bytes);
    mime = "image/jpeg";
  }
  return { src: await storeContent(env, bytes, EXTENSIONS[mime], mime), mime };
}
