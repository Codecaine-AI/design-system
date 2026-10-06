/**
 * What belongs to the owner and must stay out of every rollout run: the owner's workspace tree, the
 * ports the owner's own services use (TOOLING_CONTRACT.md), and the places under the owner's home that
 * hold credentials or app state. One list each, imported by every check.
 */

/** The owner's workspace. Tools write here only when `--root` is this tree itself. */
export const OWNER_TREE = "/Users/Ford/workspace";

/**
 * The owner's ports. No run binds or contacts them, whatever its profile says. The sandbox denies every
 * loopback port outside a run's own block anyway (sandbox.ts); this list is what registry:check, the
 * browser guard and the egress evidence name as owner services.
 *   3998-3999, 4318, 4800-4805, 4820, 4830, 4840, 4888, 5173-5174, 9222  the contract's list
 *     (4802-4805: docs-system's own dev services; canvas studio calls :4803)
 *   4808-4815  owner docs servers serving the owner's workspace
 *   2455 codex-lb proxy, 3773 T3 Code, 4040 ngrok, 5432 Postgres, 6379 Redis, 8317-8318 CLIProxy,
 *   11434 Ollama  (observed live on this machine, round-2 review)
 */
export const OWNER_PORTS: readonly number[] = [
  2455, 3773, 3998, 3999, 4040, 4318, 4800, 4801, 4802, 4803, 4804, 4805, 4808, 4809, 4810, 4811, 4812, 4813, 4814, 4815, 4820, 4830, 4840, 4888,
  5173, 5174, 5432, 6379, 8317, 8318, 9222, 11434,
];

/**
 * Credential stores and app state under the real home (relative to it). The sandbox hides them from run
 * processes even inside a readable dir, and no tool writes or creates temp dirs there.
 */
export const HOME_SECRETS: readonly string[] = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".docker",
  ".kube",
  ".codex",
  ".claude",
  ".claude.json",
  ".config/gh",
  ".config/gcloud",
  ".config/solana",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Electron",
];

/** Dirs under the real home that no tool output or scratch dir may live in (relative to it): secrets and ~/Library. */
export const HOME_FORBIDDEN: readonly string[] = [...HOME_SECRETS, "Library"];
