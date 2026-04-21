import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

async function verifyOwnership(jobId: string, userId: string) {
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId } });
  return job !== null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}/status`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}
