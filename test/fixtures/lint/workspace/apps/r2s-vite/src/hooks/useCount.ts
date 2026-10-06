import { useMemo } from "react";

export function useCount(items: Array<{ id: string }>, max: number): number {
  return useMemo(() => (items.length > max ? max : items.length), [items, max]);
}
