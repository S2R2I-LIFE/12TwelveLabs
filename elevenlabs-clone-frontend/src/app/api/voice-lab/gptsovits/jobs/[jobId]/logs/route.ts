import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const upstream = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
