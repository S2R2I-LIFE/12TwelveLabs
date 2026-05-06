import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  let resp: Response;
  try {
    resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.BACKEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, userId: session.user.id }),
    });
  } catch (e) {
    return Response.json({ error: `finetune-api unreachable: ${String(e)}` }, { status: 502 });
  }

  const text = await resp.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || "finetune-api returned empty response" };
  }
  return Response.json(data, { status: resp.status });
}
