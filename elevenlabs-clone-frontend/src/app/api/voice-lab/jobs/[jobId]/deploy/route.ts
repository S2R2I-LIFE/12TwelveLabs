import { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({
    where: { id: jobId, userId: session.user.id },
  });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: session.user.id }),
  });

  if (resp.ok) {
    revalidatePath("/app/speech-synthesis/text-to-speech");
    revalidatePath("/app/voice-lab/train");
  }

  return Response.json(await resp.json(), { status: resp.status });
}
