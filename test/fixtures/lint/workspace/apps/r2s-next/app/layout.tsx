import { Shell } from "./_components/Shell";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><Shell>{children}</Shell></body></html>;
}
