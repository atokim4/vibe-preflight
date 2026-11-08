import type { Rule } from "../types.ts";
import {
  authUsersExposed,
  definerFunctionAnon,
  definerSearchPath,
  rlsDisabled,
  rlsNoPolicy,
  rlsPermissivePolicy,
  rlsUpdatePrivilegedColumn,
  storagePublicBucket,
  viewBypassesRls,
} from "./database.ts";
import { envFileCommitted, publicEnvSecret, serverSecretInClient } from "./secrets.ts";
import { webhookParsedBody, webhookUnverified } from "./stripe.ts";

export const allRules: Rule[] = [
  rlsDisabled,
  rlsPermissivePolicy,
  rlsNoPolicy,
  rlsUpdatePrivilegedColumn,
  viewBypassesRls,
  authUsersExposed,
  definerSearchPath,
  definerFunctionAnon,
  storagePublicBucket,
  serverSecretInClient,
  publicEnvSecret,
  webhookUnverified,
  webhookParsedBody,
  envFileCommitted,
];

/** Named sets of checks for `--only`, so a focused skill can run just its part. */
export const ruleGroups: Record<string, string[]> = {
  database: [rlsDisabled, rlsPermissivePolicy, rlsNoPolicy, rlsUpdatePrivilegedColumn, viewBypassesRls, authUsersExposed, definerSearchPath, definerFunctionAnon, storagePublicBucket].map((r) => r.id),
  secrets: [serverSecretInClient, publicEnvSecret, envFileCommitted].map((r) => r.id),
  stripe: [webhookUnverified, webhookParsedBody].map((r) => r.id),
};
