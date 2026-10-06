export function Button({ label }: { label: string }) {
  return <button className="shadow-md" style={{ background: "var(--ds-color-surface-panel)" }}>{label}</button>;
}
