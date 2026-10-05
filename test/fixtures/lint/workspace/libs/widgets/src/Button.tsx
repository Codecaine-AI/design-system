export function Button({ label }: { label: string }) {
  return <button style={{ background: "var(--ds-color-surface-panel)" }}>{label}</button>;
}
