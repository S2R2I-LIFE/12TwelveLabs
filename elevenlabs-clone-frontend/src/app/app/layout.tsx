import { VoiceStoreInitializer } from "~/components/client/voice-store-initializer";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <VoiceStoreInitializer />
      {children}
    </>
  );
}
