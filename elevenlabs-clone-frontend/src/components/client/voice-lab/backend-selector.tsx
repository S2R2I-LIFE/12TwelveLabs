"use client";

import { useState } from "react";
import { TrainWizard } from "./train-wizard";
import { GptSoVitsWizard } from "./gptsovits-wizard";

type StyleTTS2Job = {
  id: string; voiceModelId: string; jobWorkDir: string | null;
  status: string; trainingEpochs: number;
} | null;

type GptSoVitsJob = {
  id: string; voiceModelId: string; jobWorkDir: string | null;
  status: string; trainingEpochs: number; sovitsEpochs: number; language: string;
} | null;

export function BackendSelector({
  styletts2Job,
  gptsovitsJob,
}: {
  styletts2Job: StyleTTS2Job;
  gptsovitsJob: GptSoVitsJob;
}) {
  const [selected, setSelected] = useState<"styletts2" | "gptsovits" | null>(
    styletts2Job ? "styletts2" : gptsovitsJob ? "gptsovits" : null,
  );

  if (!selected) {
    return (
      <div className="flex flex-col items-start gap-6 p-4 sm:flex-row sm:items-stretch">
        <button
          onClick={() => setSelected("styletts2")}
          className="flex w-full flex-col gap-2 rounded-xl border-2 border-gray-200 p-6 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:bg-gray-800 sm:w-64"
        >
          <span className="text-base font-semibold text-gray-900 dark:text-white">StyleTTS2</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Fast fine-tuning · English focused · Established pipeline
          </span>
        </button>

        <button
          onClick={() => setSelected("gptsovits")}
          className="flex w-full flex-col gap-2 rounded-xl border-2 border-gray-200 p-6 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:bg-gray-800 sm:w-64"
        >
          <span className="text-base font-semibold text-gray-900 dark:text-white">GPT-SoVITS v2</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            High-quality · Multilingual · GPT semantic tokens + VITS vocoder
          </span>
        </button>
      </div>
    );
  }

  if (selected === "gptsovits") {
    return <GptSoVitsWizard initialJob={gptsovitsJob} />;
  }

  return <TrainWizard initialJob={styletts2Job} />;
}
