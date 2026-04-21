import { PageLayout } from "~/components/client/page-layout";
import { getActiveTrainingJob } from "~/actions/voice-lab";
import { TrainWizard } from "~/components/client/voice-lab/train-wizard";

export default async function TrainPage() {
  const job = await getActiveTrainingJob();

  return (
    <PageLayout title="Train Voice" service="styletts2" showSidebar={false}>
      <TrainWizard
        initialJob={
          job
            ? {
                id: job.id,
                voiceModelId: job.voiceModelId,
                jobWorkDir: job.jobWorkDir,
                status: job.status,
                trainingEpochs: job.trainingEpochs,
              }
            : null
        }
      />
    </PageLayout>
  );
}
