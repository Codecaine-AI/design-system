const colors = require("tailwindcss/colors");

module.exports = {
  presets: [require("@codecaine-ai/design-system/tailwind-v3-preset")],
  content: ["./src/**/*.tsx"],
  theme: {
    colors: { gray: colors.gray },
    screens: { tablet: "40rem" },
    extend: { spacing: { gutter: "var(--ds-space-4)" } },
  },
};
