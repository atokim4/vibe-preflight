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
import { grantBroad, grantLeak, grantsMissing } from "./grants.ts";
import { envFileCommitted, publicEnvSecret, serverSecretInClient } from "./secrets.ts";
import { webhookParsedBody, webhookUnverified } from "./stripe.ts";
import { serverAdapterRemoved } from "./server-adapters.ts";
import { cronJobDirectWrite } from "./cron.ts";
import { checkThenAct, forUpdateAutocommit } from "./locking.ts";

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
  grantLeak,
  grantsMissing,
  grantBroad,
  serverSecretInClient,
  publicEnvSecret,
  webhookUnverified,
  webhookParsedBody,
  envFileCommitted,
  serverAdapterRemoved,
  cronJobDirectWrite,
  forUpdateAutocommit,
  checkThenAct,
];

/** Named sets of checks for `--only`, so a focused skill can run just its part. */
export const ruleGroups: Record<string, string[]> = {
  database: [rlsDisabled, rlsPermissivePolicy, rlsNoPolicy, rlsUpdatePrivilegedColumn, viewBypassesRls, authUsersExposed, definerSearchPath, definerFunctionAnon, storagePublicBucket, grantLeak, grantsMissing, grantBroad].map((r) => r.id),
  secrets: [serverSecretInClient, publicEnvSecret, envFileCommitted].map((r) => r.id),
  stripe: [webhookUnverified, webhookParsedBody].map((r) => r.id),
  /** Supabase breaking changes that make code or migrations fail after an upgrade or a cutoff date. */
  breaking: [serverAdapterRemoved, cronJobDirectWrite].map((r) => r.id),
  /** Races where two requests both pass a check: row locks that end too early, status checks outside the write. */
  concurrency: [forUpdateAutocommit, checkThenAct].map((r) => r.id),
};
