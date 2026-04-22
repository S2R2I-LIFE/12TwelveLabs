import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { voiceId } = await params;

  const model = await db.voiceModel.findFirst({
    where: { voiceId, userId: session.user.id },
  });
  if (!model) return Response.json({ error: "Not found" }, { status: 404 });

  // Delete workspace files via finetune-api
  await fetch(`${env.FINETUNE_API_ROUTE}/voices/${voiceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });

  // Delete from DB (cascades to TrainingJob)
  await db.voiceModel.delete({ where: { id: model.id } });

  return Response.json({ deleted: true });
}
