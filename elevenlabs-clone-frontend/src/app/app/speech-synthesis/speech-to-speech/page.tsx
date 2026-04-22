import { PageLayout } from "~/components/client/page-layout";
import { VoiceChanger } from "~/components/client/speech-synthesis/voice-changer";
import { getHistoryItems } from "~/lib/history";

export default async function SpeechToSpeechPage() {
  const service = "seedvc";

  const historyItems = await getHistoryItems(service);

  return (
    <PageLayout
      title={"Voice Changer"}
      service={service}
      showSidebar={true}
      historyItems={historyItems}
    >
      <VoiceChanger service={service} />
    </PageLayout>
  );
}
