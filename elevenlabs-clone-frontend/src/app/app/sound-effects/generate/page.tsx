import { PageLayout } from "~/components/client/page-layout";
import { SoundEffectsGenerator } from "~/components/client/sound-effects/sound-effects-generator";

export default async function SoundEffectsGeneratePage() {
  const soundEffectsTabs = [
    {
      name: "Generate",
      path: "/app/sound-effects/generate",
    },
    {
      name: "History",
      path: "/app/sound-effects/history",
    },
  ];

  return (
    <PageLayout
      title={"Sound Effects"}
      showSidebar={false}
      tabs={soundEffectsTabs}
      service="make-an-audio"
    >
      <SoundEffectsGenerator />
    </PageLayout>
  );
}
