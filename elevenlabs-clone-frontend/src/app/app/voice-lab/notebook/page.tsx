import { PageLayout } from "~/components/client/page-layout";
import { env } from "~/env";
import { getActiveTrainingJob } from "~/actions/voice-lab";
import { NotebookViewer } from "~/components/client/voice-lab/notebook-viewer";

export default async function NotebookPage() {
  const job = await getActiveTrainingJob();

  return (
    <PageLayout title="JupyterLab" service="styletts2" showSidebar={false}>
      <NotebookViewer
        token={env.JUPYTER_TOKEN}
        workDir={job?.jobWorkDir ?? null}
      />
    </PageLayout>
  );
}
