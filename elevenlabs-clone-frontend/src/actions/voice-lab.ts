"use server";

import { revalidatePath } from "next/cache";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import type { Voice } from "~/stores/voice-store";
import type { ServiceType } from "~/types/services";

// ── Helper ─────────────────────────────────────────────────────────────────────
function finetuneHeaders() {
  return { Authorization: `Bearer ${env.BACKEND_API_KEY}` };
}

// ── Voice models ───────────────────────────────────────────────────────────────

export async function getVoiceModels(): Promise<Voice[]> {
  const session = await auth();
  if (!session?.user.id) return [];

  const models = await db.voiceModel.findMany({
    where: { userId: session.user.id, isActive: true },
  });

  return models.map((m) => ({
    id: m.voiceId,
    name: m.name,
    gradientColors: m.gradientColors,
    service: m.service as ServiceType,
  }));
}

export async function deleteVoiceModel(voiceModelId: string) {
  const session = await auth();
  if (!session?.user.id) throw new Error("Not authenticated");

  await db.voiceModel.delete({
    where: { id: voiceModelId, userId: session.user.id },
  });

  revalidatePath("/app/voice-lab/train");
}

// ── Training jobs ──────────────────────────────────────────────────────────────

export async function getActiveTrainingJob() {
  const session = await auth();
  if (!session?.user.id) return null;

  // Return the most recent non-failed job (includes "ready" so deployed voices
  // show on step 7 instead of being invisible and letting an older abandoned
  // job take precedence on resume).
  const job = await db.trainingJob.findFirst({
    where: {
      userId: session.user.id,
      status: { not: "failed" },
    },
    orderBy: { createdAt: "desc" },
    include: { voiceModel: true },
  });

  return job;
}

export async function createTrainingJob(opts: {
  voiceName: string;
  language?: string;
  trainingEpochs?: number;
  batchSize?: number;
}) {
  const session = await auth();
  if (!session?.user.id) throw new Error("Not authenticated");

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs`, {
    method: "POST",
    headers: { ...finetuneHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      voiceName: opts.voiceName,
      language: opts.language ?? "en-us",
      trainingEpochs: opts.trainingEpochs ?? 75,
      batchSize: opts.batchSize ?? 2,
      userId: session.user.id,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Failed to create job: ${err}`);
  }

  return resp.json() as Promise<{ jobId: string; voiceModelId: string; workDir: string }>;
}

export async function cancelTrainingJob(jobId: string) {
  const session = await auth();
  if (!session?.user.id) throw new Error("Not authenticated");

  // Verify ownership
  const job = await db.trainingJob.findFirst({
    where: { id: jobId, userId: session.user.id },
  });
  if (!job) throw new Error("Job not found");

  await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}`, {
    method: "DELETE",
    headers: finetuneHeaders(),
  });

  revalidatePath("/app/voice-lab/train");
}
