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
import { webhookUnverified } from "./stripe.ts";

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
  envFileCommitted,
];
