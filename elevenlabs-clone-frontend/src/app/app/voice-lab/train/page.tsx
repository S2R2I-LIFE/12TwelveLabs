import { PageLayout } from "~/components/client/page-layout";
import { getActiveTrainingJob } from "~/actions/voice-lab";
import { BackendSelector } from "~/components/client/voice-lab/backend-selector";

export default async function TrainPage() {
  const job = await getActiveTrainingJob();
  const service = job?.voiceModel?.service;

  const styletts2Job =
    service === "styletts2"
      ? {
          id: job!.id,
          voiceModelId: job!.voiceModelId,
          jobWorkDir: job!.jobWorkDir,
          status: job!.status,
          trainingEpochs: job!.trainingEpochs,
        }
      : null;

  const gptsovitsJob =
    service === "gptsovits"
      ? {
          id: job!.id,
          voiceModelId: job!.voiceModelId,
          jobWorkDir: job!.jobWorkDir,
          status: job!.status,
          trainingEpochs: job!.trainingEpochs,
          sovitsEpochs: job!.sovitsEpochs ?? 8,
          language: job!.language ?? "en",
        }
      : null;

  return (
    <PageLayout title="Train Voice" service="styletts2" showSidebar={false}>
      <BackendSelector styletts2Job={styletts2Job} gptsovitsJob={gptsovitsJob} />
    </PageLayout>
  );
}
