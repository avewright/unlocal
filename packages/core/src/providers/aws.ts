import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudFrontClient,
  CreateDistributionWithTagsCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionConfigCommand,
  GetOriginAccessControlCommand,
  ListDistributionsCommand,
  ListOriginAccessControlsCommand,
  UpdateDistributionCommand,
  waitUntilDistributionDeployed,
  type CustomErrorResponses,
  type DistributionConfig,
} from "@aws-sdk/client-cloudfront";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { UnlocalError } from "../errors.ts";
import { contentTypeFor, listSiteFiles } from "../files.ts";
import type { Outputs } from "../state.ts";
import type { ResourceSpec, SiteSpec } from "../types.ts";
import type { Provider, ProviderContext } from "./provider.ts";

/**
 * AWS provider. Sites: private S3 bucket → CloudFront (Origin Access Control, HTTPS).
 * Cautious by default: cheapest CloudFront price class, no WAF, no logging, nothing
 * that bills by the hour. Everything it creates is tagged unlocal:project / unlocal:resource.
 */

const CACHING_OPTIMIZED_POLICY = "658327ea-f89d-4fab-a63d-7e88639e58f6";

/** Pages and text revalidate on every request so deploys show up immediately; assets cache for an hour. */
export const cacheControlFor = (key: string) =>
  /\.(html|txt|md|json|xml|webmanifest)$/i.test(key) ? "public, max-age=0, must-revalidate" : "public, max-age=3600";

/** Globally unique, deterministic per account + project + resource, ≤ 63 chars. */
export function bucketName(accountId: string, project: string, name: string): string {
  const hash = createHash("sha256").update(`${accountId}:${project}:${name}`).digest("hex").slice(0, 8);
  const base = `unlocal-${project}-${name}`.slice(0, 54).replace(/-+$/, "");
  return `${base}-${hash}`;
}

const tagsFor = (ctx: ProviderContext, name: string) => [
  { Key: "unlocal:project", Value: ctx.project },
  { Key: "unlocal:resource", Value: name },
];

const s3Origin = (bucket: string, region: string) => `${bucket}.s3.${region}.amazonaws.com`;

function errorResponses(spa: boolean): CustomErrorResponses {
  // With OAC and no ListBucket permission, S3 answers 403 for missing keys.
  return spa
    ? {
        Quantity: 2,
        Items: [403, 404].map((ErrorCode) => ({
          ErrorCode, ResponseCode: "200", ResponsePagePath: "/index.html", ErrorCachingMinTTL: 10,
        })),
      }
    : { Quantity: 0, Items: [] };
}

export function distributionConfig(opts: {
  bucket: string;
  region: string;
  oacId: string;
  spa: boolean;
  comment: string;
}): DistributionConfig {
  return {
    CallerReference: `unlocal-${opts.bucket}`,
    Comment: opts.comment,
    Enabled: true,
    DefaultRootObject: "index.html",
    PriceClass: "PriceClass_100",
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "site",
        DomainName: s3Origin(opts.bucket, opts.region),
        S3OriginConfig: { OriginAccessIdentity: "" },
        OriginAccessControlId: opts.oacId,
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "site",
      ViewerProtocolPolicy: "redirect-to-https",
      CachePolicyId: CACHING_OPTIMIZED_POLICY,
      Compress: true,
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
    },
    CustomErrorResponses: errorResponses(opts.spa),
  };
}

const AUTH_ERRORS = new Set([
  "CredentialsProviderError", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId",
  "UnrecognizedClientException", "TokenRefreshRequired", "InvalidAccessKeyId", "SignatureDoesNotMatch",
]);
const isAuthError = (err: unknown) =>
  err instanceof Error && (AUTH_ERRORS.has(err.name) || /session has expired|could not load credentials/i.test(err.message));
const isMissing = (err: unknown) =>
  err instanceof Error && /^(NoSuch|NotFound)/.test(err.name);

function authError(cause: unknown): UnlocalError {
  return new UnlocalError("CLOUD_AUTH", "AWS credentials are missing or expired", {
    cause,
    hint: "a human runs `aws login` (or `aws configure`), then re-run",
  });
}

export function createAwsProvider(): Provider {
  const s3Clients = new Map<string, S3Client>();
  const s3For = (region: string) => {
    if (!s3Clients.has(region)) s3Clients.set(region, new S3Client({ region }));
    return s3Clients.get(region)!;
  };
  const cf = new CloudFrontClient({ region: "us-east-1" });
  const sts = new STSClient({ region: "us-east-1" });
  let accountId: string | undefined;

  async function account(): Promise<string> {
    if (accountId) return accountId;
    try {
      accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
      return accountId;
    } catch (err) {
      throw isAuthError(err) ? authError(err) : err;
    }
  }

  /** Upload new/changed files, delete removed ones. Compares MD5 against S3 ETags. */
  async function sync(ctx: ProviderContext, bucket: string, spec: SiteSpec): Promise<number> {
    const s3 = s3For(ctx.region);
    const files = await listSiteFiles(path.resolve(ctx.dir, spec.path));
    const remote = new Map<string, string>();
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const o of page.Contents ?? []) remote.set(o.Key!, (o.ETag ?? "").replaceAll('"', ""));
      token = page.NextContinuationToken;
    } while (token);

    let changed = 0;
    for (const f of files) {
      const body = await readFile(f.absPath);
      const md5 = createHash("md5").update(body).digest("hex");
      if (remote.get(f.key) !== md5) {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: f.key, Body: body, ContentType: contentTypeFor(f.key), CacheControl: cacheControlFor(f.key),
        }));
        changed++;
      }
      remote.delete(f.key);
    }
    const stale = [...remote.keys()];
    for (let i = 0; i < stale.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale.slice(i, i + 1000).map((Key) => ({ Key })) } }));
    }
    ctx.log(`${files.length} files, ${changed} uploaded, ${stale.length} removed`);
    return changed + stale.length;
  }

  async function ensureOac(name: string): Promise<string> {
    let marker: string | undefined;
    do {
      const page = await cf.send(new ListOriginAccessControlsCommand({ Marker: marker }));
      const hit = page.OriginAccessControlList?.Items?.find((i) => i.Name === name);
      if (hit) return hit.Id!;
      marker = page.OriginAccessControlList?.NextMarker;
    } while (marker);
    const created = await cf.send(new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: name, Description: "unlocal", SigningProtocol: "sigv4", SigningBehavior: "always", OriginAccessControlOriginType: "s3",
      },
    }));
    return created.OriginAccessControl!.Id!;
  }

  async function findDistribution(comment: string) {
    let marker: string | undefined;
    do {
      const page = await cf.send(new ListDistributionsCommand({ Marker: marker }));
      const hit = page.DistributionList?.Items?.find((d) => d.Comment === comment);
      if (hit) return { id: hit.Id!, domain: hit.DomainName!, arn: hit.ARN! };
      marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
    } while (marker);
    return undefined;
  }

  async function invalidate(distributionId: string): Promise<void> {
    await cf.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: `unlocal-${Date.now()}`, Paths: { Quantity: 1, Items: ["/*"] } },
    }));
  }

  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      throw isAuthError(err) ? authError(err) : err;
    }
  };

  return {
    name: "aws",

    unsupported(spec: ResourceSpec) {
      if (spec.type !== "site") return `${spec.type} resources aren't supported on AWS yet (sites are)`;
      if (spec.domain) return "custom domains aren't supported on AWS yet; remove domain to get a cloudfront.net URL";
      return undefined;
    },

    async preflight() {
      await account();
    },

    create: guarded(async (ctx: ProviderContext, name: string, raw: ResourceSpec): Promise<Outputs> => {
      const spec = raw as SiteSpec;
      const s3 = s3For(ctx.region);
      const bucket = bucketName(await account(), ctx.project, name);
      const comment = `unlocal ${ctx.project}/${name}`;

      ctx.log(`bucket ${bucket}`);
      try {
        await s3.send(new CreateBucketCommand({
          Bucket: bucket,
          ...(ctx.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: ctx.region as never } }),
        }));
      } catch (err) {
        if (!(err instanceof Error && err.name === "BucketAlreadyOwnedByYou")) throw err;
      }
      await s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      }));
      await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tagsFor(ctx, name) } }));
      await sync(ctx, bucket, spec);

      const oacId = await ensureOac(bucket);
      let dist = await findDistribution(comment);
      if (!dist) {
        ctx.log("creating CloudFront distribution");
        const created = await cf.send(new CreateDistributionWithTagsCommand({
          DistributionConfigWithTags: {
            DistributionConfig: distributionConfig({ bucket, region: ctx.region, oacId, spa: spec.spa, comment }),
            Tags: { Items: tagsFor(ctx, name) },
          },
        }));
        const d = created.Distribution!;
        dist = { id: d.Id!, domain: d.DomainName!, arn: d.ARN! };
      }

      await s3.send(new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "CloudFrontReadOnly",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/*`,
            Condition: { StringEquals: { "AWS:SourceArn": dist.arn } },
          }],
        }),
      }));
      ctx.log("CloudFront takes a few minutes to start serving a new site");
      return { url: `https://${dist.domain}`, bucket, distributionId: dist.id, originAccessControlId: oacId };
    }),

    update: guarded(async (ctx, _name, before, after, outputs) => {
      const prev = before as SiteSpec;
      const spec = after as SiteSpec;
      const changed = await sync(ctx, outputs.bucket!, spec);
      if (prev.spa !== spec.spa) {
        const current = await cf.send(new GetDistributionConfigCommand({ Id: outputs.distributionId }));
        await cf.send(new UpdateDistributionCommand({
          Id: outputs.distributionId,
          IfMatch: current.ETag,
          DistributionConfig: { ...current.DistributionConfig!, CustomErrorResponses: errorResponses(spec.spa) },
        }));
      }
      if (changed > 0) await invalidate(outputs.distributionId!);
      return outputs;
    }),

    delete: guarded(async (ctx, _name, _spec, outputs) => {
      const id = outputs.distributionId;
      if (id) {
        try {
          const current = await cf.send(new GetDistributionConfigCommand({ Id: id }));
          if (current.DistributionConfig!.Enabled) {
            ctx.log("disabling CloudFront distribution");
            await cf.send(new UpdateDistributionCommand({
              Id: id, IfMatch: current.ETag, DistributionConfig: { ...current.DistributionConfig!, Enabled: false },
            }));
          }
          ctx.log("waiting for CloudFront to finish disabling (usually 5–15 minutes)");
          await waitUntilDistributionDeployed({ client: cf, maxWaitTime: 1800 }, { Id: id });
          const disabled = await cf.send(new GetDistributionConfigCommand({ Id: id }));
          await cf.send(new DeleteDistributionCommand({ Id: id, IfMatch: disabled.ETag }));
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
      if (outputs.originAccessControlId) {
        try {
          const oac = await cf.send(new GetOriginAccessControlCommand({ Id: outputs.originAccessControlId }));
          await cf.send(new DeleteOriginAccessControlCommand({ Id: outputs.originAccessControlId, IfMatch: oac.ETag }));
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
      if (outputs.bucket) {
        const s3 = s3For(ctx.region);
        try {
          let token: string | undefined;
          do {
            const page = await s3.send(new ListObjectsV2Command({ Bucket: outputs.bucket, ContinuationToken: token }));
            const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
            if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: outputs.bucket, Delete: { Objects: keys } }));
            token = page.NextContinuationToken;
          } while (token);
          await s3.send(new DeleteBucketCommand({ Bucket: outputs.bucket }));
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
    }),
  };
}
