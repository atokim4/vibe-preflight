import type { Rule } from "../types.ts";
import { rlsDisabled, rlsPermissivePolicy } from "./database.ts";
import { envFileCommitted, publicEnvSecret, serverSecretInClient } from "./secrets.ts";
import { webhookUnverified } from "./stripe.ts";

export const allRules: Rule[] = [rlsDisabled, rlsPermissivePolicy, serverSecretInClient, publicEnvSecret, webhookUnverified, envFileCommitted];
