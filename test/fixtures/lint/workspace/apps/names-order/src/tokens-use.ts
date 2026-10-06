import { useMemo } from "react";
import { flat, tokens } from "@codecaine-ai/design-system";

export const page = tokens.light.color.surface.nope;
export const base = flat.base["color.surface.page"];
export const memo = useMemo;
export const surface = (name: string) => `var(--ds-color-surface-${name})`;
export const fill = (name: string) => "--ds-color-fill-" + name;
export const cutShort = "var(--ds-color-surface-)";
