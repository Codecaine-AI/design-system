// Codemod fixture: CSS rules inside a JS template literal, with an interpolated declaration.
export const styles = (border: string) => `
  .dark .panel {
    background: #151b23;
    border: ${border};
    border-radius: 6px;
  }
`;
