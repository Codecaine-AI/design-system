import type { Config } from "tailwindcss";
import ds from "@codecaine-ai/design-system/tailwind-v3-preset";

const config = {
  presets: [ds],
  content: ["./src/**/*.tsx"],
} satisfies Config;

export default config;
