import { useState } from "react";

export function useThing(): string {
  const [value] = useState<string>("thing");
  return value.length < 3 ? value : `${value}s`;
}
