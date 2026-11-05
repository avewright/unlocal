import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { UnlocalError } from "./errors.ts";

/**
 * A permanent AWS connection for unlocal that nobody has to log in to again.
 *
 * The customer runs connectTemplate() once in CloudFormation. It creates `unlocal-deploy`,
 * a role that can do only what unlocal's AWS provider does, on unlocal's own resources,
 * and nothing in IAM. unlocal assumes it for an hour at a time and renews it itself.
 *
 *   hosted: the role trusts unlocal's AWS account, and only with the customer's ExternalId
 *   local:  the template also makes `unlocal-connector`, a user that can only assume
 *           the role; its access key never expires, and leaked it can only do what the
 *           role does. Deleting the stack revokes everything at once.
 */

export const ROLE_NAME = "unlocal-deploy";
export const CONNECTOR_USER = "unlocal-connector";
const SESSION_SECONDS = 3600;
/** Renew this long before the hour is up, so no call starts on credentials about to expire. */
const RENEW_BEFORE_MS = 5 * 60_000;

export interface AwsConnection {
  roleArn: string;
  /** Set for hosted connections; required by the role's trust policy. */
  externalId?: string;
  /** The connector user's key (local mode). Hosted mode uses unlocal's own identity instead. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type AssumeRole = (input: { RoleArn: string; RoleSessionName: string; DurationSeconds: number; ExternalId?: string }) =>
  Promise<{ Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } }>;

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@\/-]+$/;

export function assertRoleArn(arn: string): void {
  if (!ROLE_ARN.test(arn)) {
    throw new UnlocalError("USAGE", `"${arn}" isn't an IAM role ARN`, {
      hint: `it looks like arn:aws:iam::123456789012:role/${ROLE_NAME}; it's the RoleArn output of the unlocal CloudFormation stack`,
    });
  }
}

/**
 * Credentials for the AWS SDK that assume the role on first use and renew it before it
 * expires: a connection that lasts until the customer deletes the stack.
 */
export function assumeRoleCredentials(connection: AwsConnection, options: { assume?: AssumeRole; now?: () => number } = {}) {
  assertRoleArn(connection.roleArn);
  const now = options.now ?? Date.now;
  const assume: AssumeRole = options.assume ?? (() => {
    const sts = new STSClient({
      region: "us-east-1",
      ...(connection.accessKeyId && connection.secretAccessKey
        ? { credentials: { accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey } }
        : {}),
    });
    return (input) => sts.send(new AssumeRoleCommand(input));
  })();
  let current: AwsCredentials | undefined;
  let pending: Promise<AwsCredentials> | undefined;

  const renew = async (): Promise<AwsCredentials> => {
    let out;
    try {
      out = await assume({
        RoleArn: connection.roleArn,
        RoleSessionName: "unlocal",
        DurationSeconds: SESSION_SECONDS,
        ...(connection.externalId ? { ExternalId: connection.externalId } : {}),
      });
    } catch (cause) {
      throw new UnlocalError("CLOUD_AUTH", `unlocal couldn't assume ${connection.roleArn}`, {
        cause,
        hint: "the unlocal CloudFormation stack may have been deleted, or the connector key revoked; a human reconnects with `unlocal connect aws`",
      });
    }
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new UnlocalError("CLOUD_AUTH", "AWS returned no credentials for the unlocal role");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  };

  return async (): Promise<AwsCredentials> => {
    if (current?.expiration && current.expiration.getTime() - RENEW_BEFORE_MS > now()) return current;
    // Concurrent calls share one renewal.
    pending ??= renew().then((c) => (current = c)).finally(() => (pending = undefined));
    return pending;
  };
}

/** Assume the role once and ask AWS who we are: proof the connection works before saving it. */
export async function verifyAwsConnection(connection: AwsConnection): Promise<{ account: string; arn: string }> {
  const sts = new STSClient({ region: "us-east-1", credentials: assumeRoleCredentials(connection) });
  const me = await sts.send(new GetCallerIdentityCommand({}));
  return { account: me.Account ?? "", arn: me.Arn ?? "" };
}

type Json = Record<string, unknown>;

/**
 * The CloudFormation template a customer runs once. Leave TrustedAccountId empty for a
 * local connection (it also creates the connector user); set it, with ExternalId, to let
 * hosted unlocal in.
 */
export function connectTemplate(): Json {
  const roleArnSub = { "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${ROLE_NAME}` };
  const unlocalBuckets = { "Fn::Sub": "arn:${AWS::Partition}:s3:::unlocal-*" };
  const unlocalObjects = { "Fn::Sub": "arn:${AWS::Partition}:s3:::unlocal-*/*" };
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "unlocal: a role that deploys and pauses only unlocal's own resources. Delete this stack to revoke all access.",
    Parameters: {
      TrustedAccountId: { Type: "String", Default: "", AllowedPattern: "^(\\d{12})?$", Description: "unlocal's AWS account (hosted). Empty: a local connection." },
      ExternalId: { Type: "String", Default: "", Description: "Your unlocal ExternalId (hosted only)." },
    },
    Conditions: {
      Local: { "Fn::Equals": [{ Ref: "TrustedAccountId" }, ""] },
    },
    Resources: {
      DeployRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: ROLE_NAME,
          MaxSessionDuration: SESSION_SECONDS,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              "Fn::If": [
                "Local",
                // The connector user, by ARN string: no dependency cycle with the user's policy.
                { Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: { "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:user/${CONNECTOR_USER}` } } },
                {
                  Effect: "Allow",
                  Action: "sts:AssumeRole",
                  Principal: { AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${TrustedAccountId}:root" } },
                  Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
                },
              ],
            }],
          },
          Policies: [
            {
              PolicyName: "unlocal-sites",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "OnlyUnlocalBuckets",
                    Effect: "Allow",
                    Action: ["s3:CreateBucket", "s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketTagging", "s3:PutBucketPublicAccessBlock", "s3:ListBucket"],
                    Resource: unlocalBuckets,
                  },
                  { Sid: "OnlyUnlocalObjects", Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: unlocalObjects },
                  {
                    // TODO: narrow to distributions tagged unlocal:project once tag conditions are verified for each action.
                    Sid: "CloudFront",
                    Effect: "Allow",
                    Action: [
                      "cloudfront:CreateDistribution", "cloudfront:TagResource", "cloudfront:GetDistribution",
                      "cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution",
                      "cloudfront:ListDistributions", "cloudfront:CreateInvalidation", "cloudfront:CreateOriginAccessControl",
                      "cloudfront:GetOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:ListOriginAccessControls",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
            {
              PolicyName: "unlocal-spend-read",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [{
                  Sid: "ReadSpendAndUsage",
                  Effect: "Allow",
                  Action: ["ce:GetCostAndUsage", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "budgets:ViewBudget"],
                  Resource: "*",
                }],
              },
            },
          ],
          Tags: [{ Key: "unlocal:managed", Value: "true" }],
        },
      },
      ConnectorUser: {
        Type: "AWS::IAM::User",
        Condition: "Local",
        Properties: {
          UserName: CONNECTOR_USER,
          Policies: [{
            PolicyName: "assume-unlocal-deploy-only",
            PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: roleArnSub }] },
          }],
          Tags: [{ Key: "unlocal:managed", Value: "true" }],
        },
      },
    },
    Outputs: {
      RoleArn: { Value: { "Fn::GetAtt": ["DeployRole", "Arn"] } },
      CreateConnectorKey: {
        Condition: "Local",
        Description: "Create one access key for this user (Security credentials → Create access key → Other), then run `unlocal connect aws`.",
        Value: { "Fn::Sub": `https://console.aws.amazon.com/iam/home#/users/details/${CONNECTOR_USER}?section=security_credentials` },
      },
    },
  };
}
