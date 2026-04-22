import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

const headers = () => ({ Authorization: `Bearer ${env.BACKEND_API_KEY}` });

async function verifyOwnership(voiceId: string, userId: string) {
  return db.voiceModel.findFirst({ where: { voiceId, userId } });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const session = await auth();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { voiceId } = await params;
  if (!(await verifyOwnership(voiceId, session.user.id)))
    return Response.json({ error: "Not found" }, { status: 404 });

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/voices/${voiceId}/files`, {
    headers: headers(),
  });
  return Response.json(await resp.json(), { status: resp.status });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const session = await auth();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { voiceId } = await params;
  if (!(await verifyOwnership(voiceId, session.user.id)))
    return Response.json({ error: "Not found" }, { status: 404 });

  const { filename } = await req.json() as { filename: string };
  if (!filename)
    return Response.json({ error: "filename required" }, { status: 400 });

  const resp = await fetch(
    `${env.FINETUNE_API_ROUTE}/voices/${voiceId}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE", headers: headers() },
  );
  return Response.json(await resp.json(), { status: resp.status });
}
