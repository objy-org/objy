import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export class MemoryObjectStorage {
  constructor() {
    this.objects = new Map();
    this.revision = 0;
  }

  async put(key, body, contentType = "application/json") {
    this.objects.set(key, {
      body: typeof body === "string" ? body : JSON.stringify(body),
      contentType,
      etag: String(++this.revision),
    });
  }

  async getVersioned(key) {
    const object = this.objects.get(key);
    return { body: object?.body ?? null, etag: object?.etag ?? null };
  }

  async putConditional(key, body, etag, contentType = "application/json") {
    validateCondition(etag);
    if ((this.objects.get(key)?.etag ?? null) !== etag) return false;
    this.objects.set(key, { body: typeof body === "string" ? body : JSON.stringify(body), contentType, etag: String(++this.revision) });
    return true;
  }

  async putIfAbsent(key, body, contentType = "application/json") {
    return this.putConditional(key, body, null, contentType);
  }

  async putBlob(key, body, contentType = "application/octet-stream") {
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body || ""),
      contentType,
      etag: String(++this.revision),
    });
  }

  async get(key) {
    return this.objects.get(key)?.body ?? null;
  }

  async getStream(key) {
    const body = this.objects.get(key)?.body;
    return body === undefined ? null : Readable.from([body]);
  }

  async getBlob(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    const body = Buffer.isBuffer(object.body) ? Buffer.from(object.body) : Buffer.from(String(object.body));
    return {
      body,
      contentType: object.contentType || "application/octet-stream",
      contentLength: body.length,
    };
  }

  async list(prefix = "") {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(keys) {
    let count = 0;
    for (const key of keys) {
      if (this.objects.delete(key)) count++;
    }
    return count;
  }

  async deletePrefix(prefix) {
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.objects.delete(key);
      count++;
    }
    return count;
  }
}

export class S3ObjectStorage {
  constructor({
    bucket,
    endpoint,
    region = "us-east-1",
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  } = {}) {
    if (!bucket) throw new Error("S3 bucket is required");
    this.bucket = bucket;
    this.region = region;
    this.ready = false;
    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: forcePathStyle ?? true } : {}),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  async ensureBucket() {
    if (this.ready) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (code !== 404 && err.name !== "NotFound" && err.name !== "NoSuchBucket") throw err;
      await this.client.send(new CreateBucketCommand({
        Bucket: this.bucket,
        ...createBucketLocation(this.region),
      }));
    }
    this.ready = true;
  }

  async put(key, body, contentType = "application/json") {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: typeof body === "string" ? body : JSON.stringify(body),
      ContentType: contentType,
    }));
  }

  async putIfAbsent(key, body, contentType = "application/json") {
    return this.putConditional(key, body, null, contentType);
  }

  async putConditional(key, body, etag, contentType = "application/json") {
    validateCondition(etag);
    await this.ensureBucket();
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === "string" ? body : JSON.stringify(body),
        ContentType: contentType,
        ...(etag === null ? { IfNoneMatch: "*" } : { IfMatch: etag }),
      }));
      return true;
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      if (status === 404 || status === 409 || status === 412 || err.name === "PreconditionFailed") return false;
      throw err;
    }
  }

  async putBlob(key, body, contentType = "application/octet-stream") {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async get(key) {
    return (await this.getVersioned(key)).body;
  }

  async getVersioned(key) {
    await this.ensureBucket();
    try {
      const got = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (!got.ETag) throw new Error(`S3 response missing ETag: ${key}`);
      return { body: await bodyToString(got.Body), etag: got.ETag };
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (code === 404 || err.name === "NoSuchKey" || err.name === "NotFound") return { body: null, etag: null };
      throw err;
    }
  }

  async getStream(key) {
    await this.ensureBucket();
    try {
      const got = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return got.Body || null;
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (code === 404 || err.name === "NoSuchKey" || err.name === "NotFound") return null;
      throw err;
    }
  }

  async getBlob(key) {
    await this.ensureBucket();
    try {
      const got = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        body: got.Body,
        contentType: got.ContentType || "application/octet-stream",
        contentLength: got.ContentLength,
      };
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (code === 404 || err.name === "NoSuchKey" || err.name === "NotFound") return null;
      throw err;
    }
  }

  async list(prefix = "") {
    await this.ensureBucket();
    const keys = [];
    let ContinuationToken;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken,
      }));
      for (const item of res.Contents || []) if (item.Key) keys.push(item.Key);
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return keys.sort();
  }

  async delete(keys) {
    await this.ensureBucket();
    let count = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (!chunk.length) continue;
      const result = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }));
      if (result.Errors?.length) throw new Error(`S3 deletion failed: ${result.Errors.map((error) => `${error.Key}: ${error.Code}`).join(", ")}`);
      count += chunk.length;
    }
    return count;
  }

  async deletePrefix(prefix) {
    const keys = await this.list(prefix);
    return this.delete(keys);
  }
}

export function createObjectStorage({ mode = "off", s3 = {} } = {}) {
  if (mode === "memory") return new MemoryObjectStorage();
  if (mode === "s3") return new S3ObjectStorage(s3);
  if (mode === "off" || mode === false) return null;
  throw new Error(`unsupported object storage mode: ${mode}`);
}

function createBucketLocation(region) {
  if (!region || region === "us-east-1") return {};
  return {
    CreateBucketConfiguration: {
      LocationConstraint: region,
    },
  };
}

function validateCondition(etag) {
  if (etag !== null && (typeof etag !== "string" || !etag)) throw new Error("conditional writes require an ETag or null");
}

async function bodyToString(body) {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
