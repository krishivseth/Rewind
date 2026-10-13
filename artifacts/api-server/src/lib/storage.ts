/**
 * Blob storage keyed by relative path. Local disk under DATA_DIR/storage by default; when
 * PRIVATE_OBJECT_DIR is set (Replit App Storage) the same keys go to the bucket instead, so a
 * Replit deployment keeps bundles across restarts.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { settings } from "./config";

// Keys written by the previous version of this app look like /objects/rewind/bundles/...; they map
// to the same bucket location that code used, so old branches stay viewable and deletable.
const LEGACY = "/objects/";
const normalize = (key: string) => (key.startsWith(LEGACY) ? key.slice(LEGACY.length) : key);

function localPath(key: string): string {
  const k = normalize(key);
  if (k.startsWith("/") || k.split("/").includes("..")) throw new Error(`bad storage key: ${key}`);
  return path.join(settings.dataDir, "storage", k);
}

const objectDir = process.env.PRIVATE_OBJECT_DIR;

type Bucket = { file(name: string): { createWriteStream(o: object): NodeJS.WritableStream; createReadStream(): NodeJS.ReadableStream; exists(): Promise<[boolean]>; delete(o: object): Promise<unknown> } };
let bucketPromise: Promise<{ bucket: Bucket; prefix: string }> | null = null;

async function bucket() {
  if (!objectDir) throw new Error("object storage not configured");
  if (!bucketPromise) {
    bucketPromise = (async () => {
      const { Storage } = await import("@google-cloud/storage");
      const sidecar = "http://127.0.0.1:1106";
      const storage = new Storage({
        credentials: {
          audience: "replit", subject_token_type: "access_token", token_url: `${sidecar}/token`, type: "external_account",
          credential_source: { url: `${sidecar}/credential`, format: { type: "json", subject_token_field_name: "access_token" } },
          universe_domain: "googleapis.com",
        } as never,
        projectId: "",
      });
      const parts = objectDir.replace(/^\/+/, "").split("/");
      const name = parts.shift()!;
      return { bucket: storage.bucket(name) as unknown as Bucket, prefix: parts.join("/").replace(/\/+$/, "") };
    })();
  }
  return bucketPromise;
}

const objectName = (prefix: string, key: string) =>
  (key.startsWith(LEGACY) ? [prefix, normalize(key)] : [prefix, "rewind", key]).filter(Boolean).join("/");

export async function putFile(key: string, src: string): Promise<string> {
  if (objectDir) {
    const { bucket: b, prefix } = await bucket();
    await pipeline(createReadStream(src), b.file(objectName(prefix, key)).createWriteStream({ resumable: false, metadata: { contentType: "application/x-git-bundle" } }));
    return key;
  }
  const dest = localPath(key);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, `${dest}.tmp`);
  const { rename } = await import("node:fs/promises");
  await rename(`${dest}.tmp`, dest);
  return key;
}

export async function getToFile(key: string, dest: string): Promise<string> {
  await mkdir(path.dirname(dest), { recursive: true });
  if (objectDir) {
    const { bucket: b, prefix } = await bucket();
    await pipeline(b.file(objectName(prefix, key)).createReadStream(), createWriteStream(dest));
    return dest;
  }
  await copyFile(localPath(key), dest);
  return dest;
}

export async function exists(key: string): Promise<boolean> {
  if (objectDir) {
    const { bucket: b, prefix } = await bucket();
    const [ok] = await b.file(objectName(prefix, key)).exists();
    return ok;
  }
  try { await access(localPath(key)); return true; } catch { return false; }
}

export async function remove(key: string): Promise<void> {
  if (objectDir) {
    const { bucket: b, prefix } = await bucket();
    await b.file(objectName(prefix, key)).delete({ ignoreNotFound: true });
    return;
  }
  await rm(localPath(key), { force: true });
}
