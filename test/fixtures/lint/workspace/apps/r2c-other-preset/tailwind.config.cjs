const base = require("./tailwind.base.cjs");

module.exports = {
  presets: [require("@codecaine-ai/design-system/tailwind-v3-preset"), base],
  content: ["./src/**/*.tsx"],
};
