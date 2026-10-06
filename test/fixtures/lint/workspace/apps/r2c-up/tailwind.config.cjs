module.exports = {
  presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")],
  content: ["./web/src/**/*.tsx"],
  safelist: ["bg-red-500"],
  theme: { extend: { colors: { brand: "#ff0000" } } },
};
