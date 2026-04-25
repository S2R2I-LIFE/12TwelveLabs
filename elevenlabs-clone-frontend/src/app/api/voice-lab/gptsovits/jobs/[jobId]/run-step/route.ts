import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/run-step`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Response.json(await resp.json(), { status: resp.status });
}
