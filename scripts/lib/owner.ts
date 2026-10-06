/**
 * What belongs to the owner and must stay out of every rollout run: the owner's workspace tree and the
 * ports the owner's own services use (TOOLING_CONTRACT.md). One list, imported by every check.
 */

/** The owner's workspace. Tools write here only when `--root` is this tree itself. */
export const OWNER_TREE = "/Users/Ford/workspace";

/**
 * The owner's ports. No run binds or contacts them, whatever its profile says.
 * 4800-4805 are docs-system's own dev services (docs-system/Makefile; canvas studio calls :4803).
 */
export const OWNER_PORTS: readonly number[] = [3998, 3999, 4318, 4800, 4801, 4802, 4803, 4804, 4805, 4820, 4830, 4840, 4888, 5173, 5174, 9222];
