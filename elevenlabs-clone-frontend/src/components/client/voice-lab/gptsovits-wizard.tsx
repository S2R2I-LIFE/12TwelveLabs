"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IoAddOutline,
  IoCheckmarkCircle,
  IoChevronForward,
  IoCloudUploadOutline,
  IoEllipseOutline,
  IoMicOutline,
  IoRefreshOutline,
  IoStopCircleOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { getVoiceModels } from "~/actions/voice-lab";
import { useVoiceStore } from "~/stores/voice-store";

// ── WAV encoding helpers (identical to train-wizard.tsx) ──────────────────────

function audioBufferToWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length;
  const ab = new ArrayBuffer(44 + len * numCh * 2);
  const v = new DataView(ab);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF"); v.setUint32(4, 36 + len * numCh * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true); v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, len * numCh * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]!));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function blobToWavFile(blob: Blob, name: string): Promise<File> {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();
  return new File([audioBufferToWav(audioBuf)], name, { type: "audio/wav" });
}

// ── Status → wizard step mapping ──────────────────────────────────────────────

function statusToStep(status: string): number {
  if (status === "ready" || status === "training_done") return 6;
  if (status.startsWith("train")) return 5;
  if (status === "extracting_done") return 5;
  if (status.startsWith("extract")) return 4;
  if (status === "transcribing_done") return 4;
  if (status.startsWith("transcrib")) return 3;
  return 2;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEP_LABELS = [
  "Name Your Voice",
  "Upload Audio",
  "Transcribe",
  "Extract Features",
  "Train",
  "Deploy",
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
];

const ACCEPTED_AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".webm", ".aac"];

interface JobState { jobId: string; voiceModelId: string; }

// ── Main component ────────────────────────────────────────────────────────────

export function GptSoVitsWizard({
  initialJob,
}: {
  initialJob: {
    id: string;
    voiceModelId: string;
    jobWorkDir: string | null;
    status: string;
    trainingEpochs: number;
    sovitsEpochs: number;
    language: string;
  } | null;
}) {
  const setVoices = useVoiceStore((s) => s.setVoices);

  const [step, setStep] = useState(initialJob ? statusToStep(initialJob.status) : 1);
  const maxStepReached = useRef(initialJob ? statusToStep(initialJob.status) : 1);
  const [serverFiles, setServerFiles] = useState<{ name: string; size: number }[]>([]);
  const [job, setJob] = useState<JobState | null>(
    initialJob ? { jobId: initialJob.id, voiceModelId: initialJob.voiceModelId } : null,
  );

  // Step 1
  const [voiceName, setVoiceName] = useState("");
  const [language, setLanguage] = useState(initialJob?.language ?? "en");
  const [gptEpochs, setGptEpochs] = useState(initialJob?.trainingEpochs ?? 15);
  const [sovitsEpochs, setSovitsEpochs] = useState(initialJob?.sovitsEpochs ?? 8);
  const [creating, setCreating] = useState(false);

  // Step 2
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Steps 3-5 — log console
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [stepDone, setStepDone] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Step 6
  const [deployed, setDeployed] = useState(initialJob?.status === "ready");
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  useEffect(() => {
    setLogs([]);
    setRunning(false);
    setStepDone(false);
    setStepError(null);
  }, [step]);

  useEffect(() => {
    if (step === 2 && job) {
      fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/audio`)
        .then((r) => r.json())
        .then((d: { files?: { name: string; size: number }[] }) =>
          setServerFiles(d.files ?? []),
        )
        .catch(console.error);
    }
  }, [step, job]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const goToStep = useCallback((n: number) => {
    maxStepReached.current = Math.max(maxStepReached.current, n);
    setStep(n);
  }, []);

  const goBack = useCallback(() => {
    if (running) setStepError("A step is still running. Results may be incomplete.");
    esRef.current?.close();
    setRunning(false);
    setStep((s) => s - 1);
  }, [running]);

  const startSSE = useCallback((jobId: string) => {
    esRef.current?.close();
    setLogs((prev) => [...prev, ...(prev.length > 0 ? [""] : [])]);
    setStepDone(false);
    setStepError(null);
    setRunning(true);

    const es = new EventSource(`/api/voice-lab/gptsovits/jobs/${jobId}/logs`);
    esRef.current = es;

    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data) as { type: string; message?: string; status?: string };
      if (data.type === "log" && data.message) {
        setLogs((prev) => [...prev, data.message!]);
      }
      if (data.type === "complete") {
        setRunning(false);
        es.close();
        if (data.status === "failed") {
          setStepError("Step failed — see log output for details.");
        } else {
          setStepDone(true);
        }
      }
    };

    es.onerror = () => { setRunning(false); es.close(); };
  }, []);

  const runStep = useCallback(async (stepName: string) => {
    if (!job) return;
    const resp = await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/run-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: stepName }),
    });
    if (!resp.ok) {
      const err = await resp.json() as { detail?: string };
      setLogs((prev) => [...prev, `Error: ${err.detail ?? JSON.stringify(err)}`]);
      return;
    }
    startSSE(job.jobId);
  }, [job, startSSE]);

  // ── Step handlers ─────────────────────────────────────────────────────────────

  const handleCreateJob = async () => {
    if (!voiceName.trim()) return;
    setCreating(true);
    try {
      if (job) {
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gptEpochs, sovitsEpochs }),
        });
      } else {
        const resp = await fetch("/api/voice-lab/gptsovits/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceName, language, gptEpochs, sovitsEpochs }),
        });
        const data = await resp.json() as { jobId: string; voiceModelId: string };
        setJob({ jobId: data.jobId, voiceModelId: data.voiceModelId });
      }
      goToStep(2);
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const audioFiles = Array.from(files).filter((f) =>
      ACCEPTED_AUDIO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    setUploadedFiles((prev) => [...prev, ...audioFiles]);
  };

  const handleUploadFiles = async () => {
    if (!job || uploadedFiles.length === 0) {
      goToStep(3);
      return;
    }
    setUploading(true);
    try {
      for (const file of uploadedFiles) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/upload`, {
          method: "POST",
          body: fd,
        });
      }
      goToStep(3);
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteServerFile = useCallback(
    async (name: string) => {
      setServerFiles((prev) => prev.filter((f) => f.name !== name));
    },
    [],
  );

  const handleDeploy = async () => {
    if (!job) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const resp = await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/run-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "deploy" }),
      });
      if (resp.ok) {
        startSSE(job.jobId);
      } else {
        const data = await resp.json() as { detail?: string };
        setDeployError(data.detail ?? "Deploy failed");
      }
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleNewVoice = async () => {
    setResetting(true);
    esRef.current?.close();
    try {
      if (job && !deployed) {
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}`, { method: "DELETE" });
      }
    } catch (e) {
      console.error(e);
    }
    setJob(null);
    setStep(1);
    setVoiceName("");
    setLanguage("en");
    setGptEpochs(15);
    setSovitsEpochs(8);
    setUploadedFiles([]);
    setServerFiles([]);
    setLogs([]);
    setRunning(false);
    setStepDone(false);
    setStepError(null);
    setDeployed(false);
    setDeployError(null);
    setResetting(false);
  };

  useEffect(() => {
    if (step === 6 && stepDone && !deployed) {
      setDeployed(true);
      getVoiceModels().then((v) => { if (v.length > 0) setVoices(v); }).catch(console.error);
    }
  }, [step, stepDone, deployed, setVoices]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col gap-4 md:flex-row md:gap-6">
      {/* Left stepper */}
      <div className="md:w-52 md:flex-shrink-0">
        <h2 className="mb-3 font-semibold text-gray-900 dark:text-white md:mb-4">GPT-SoVITS</h2>

        {/* Mobile: compact dots */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 md:hidden">
          {STEP_LABELS.map((label, idx) => {
            const n = idx + 1;
            const done = n < step;
            const active = n === step;
            const clickable = !active && n <= maxStepReached.current;
            return (
              <div
                key={n}
                onClick={() => { if (clickable) setStep(n); }}
                className={`flex flex-shrink-0 flex-col items-center gap-1 ${clickable ? "cursor-pointer" : "cursor-default"}`}
              >
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${active ? "bg-gray-900 text-white" : done ? "bg-green-500 text-white" : "bg-gray-200 text-gray-400"}`}>
                  {done ? <IoCheckmarkCircle className="h-4 w-4" /> : n}
                </div>
                {active && (
                  <span className="max-w-[56px] text-center text-[10px] leading-tight text-gray-700">{label}</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Desktop: vertical list */}
        <ol className="hidden space-y-1 md:block">
          {STEP_LABELS.map((label, idx) => {
            const n = idx + 1;
            const done = n < step;
            const active = n === step;
            const clickable = !active && n <= maxStepReached.current;
            return (
              <li
                key={n}
                onClick={() => { if (clickable) setStep(n); }}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-700 dark:text-white" : done && clickable ? "cursor-pointer text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800" : "cursor-default text-gray-400 dark:text-gray-600"}`}
              >
                {done ? (
                  <IoCheckmarkCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <IoEllipseOutline className={`h-4 w-4 ${active ? "text-gray-700" : "text-gray-300"}`} />
                )}
                {n}. {label}
              </li>
            );
          })}
        </ol>

        {job && (
          <button
            onClick={handleNewVoice}
            disabled={resetting}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 md:mt-5"
          >
            <IoAddOutline className="h-3.5 w-3.5" />
            {resetting ? "Resetting…" : "New voice"}
          </button>
        )}
      </div>

      {/* Right panel */}
      <div className="min-h-0 flex-1 overflow-auto">
        {step === 1 && (
          <StepName
            voiceName={voiceName}
            setVoiceName={setVoiceName}
            language={language}
            setLanguage={setLanguage}
            gptEpochs={gptEpochs}
            setGptEpochs={setGptEpochs}
            sovitsEpochs={sovitsEpochs}
            setSovitsEpochs={setSovitsEpochs}
            onCreate={handleCreateJob}
            creating={creating}
            hasJob={job !== null}
          />
        )}

        {step === 2 && (
          <StepUpload
            files={uploadedFiles}
            onSelect={handleFileSelect}
            onRemove={(name) => setUploadedFiles((prev) => prev.filter((f) => f.name !== name))}
            onNext={handleUploadFiles}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onAddRecording={(file) => setUploadedFiles((prev) => [...prev, file])}
            onBack={goBack}
            serverFiles={serverFiles}
            onDeleteServerFile={handleDeleteServerFile}
          />
        )}

        {step === 3 && job && (
          <StepLog
            title="Transcribe"
            description="Whisper transcribes your audio and writes inp_text.list in GPT-SoVITS format."
            runLabel="Transcribe"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("transcribe")}
            onNext={() => goToStep(4)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 3}
          />
        )}

        {step === 4 && job && (
          <StepLog
            title="Extract Features"
            description="Runs BERT text processing, HuBERT feature extraction, and semantic token generation (3 scripts)."
            runLabel="Extract Features"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("features")}
            onNext={() => goToStep(5)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 4}
          />
        )}

        {step === 5 && job && (
          <StepLog
            title="Train"
            description={`GPT training then SoVITS training run sequentially. GPT epochs: ${gptEpochs}  SoVITS epochs: ${sovitsEpochs}`}
            runLabel="Start Training"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("train")}
            onNext={() => goToStep(6)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 5}
          />
        )}

        {step === 6 && job && (
          <StepDeploy
            deployed={deployed}
            deploying={deploying}
            running={running}
            stepDone={stepDone}
            logs={logs}
            logsEndRef={logsEndRef}
            stepError={stepError ?? deployError}
            onDeploy={handleDeploy}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepName({
  voiceName, setVoiceName, language, setLanguage,
  gptEpochs, setGptEpochs, sovitsEpochs, setSovitsEpochs,
  onCreate, creating, hasJob,
}: {
  voiceName: string; setVoiceName: (v: string) => void;
  language: string; setLanguage: (v: string) => void;
  gptEpochs: number; setGptEpochs: (v: number) => void;
  sovitsEpochs: number; setSovitsEpochs: (v: number) => void;
  onCreate: () => void; creating: boolean; hasJob: boolean;
}) {
  return (
    <div className="max-w-md space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Voice name</label>
        <input
          type="text"
          value={voiceName}
          onChange={(e) => setVoiceName(e.target.value)}
          placeholder="My Voice"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Language</label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          GPT epochs: {gptEpochs}
        </label>
        <input type="range" min={5} max={50} step={5} value={gptEpochs}
          onChange={(e) => setGptEpochs(Number(e.target.value))} className="w-full" />
        <div className="mt-1 flex justify-between text-xs text-gray-400"><span>5</span><span>50</span></div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          SoVITS epochs: {sovitsEpochs}
        </label>
        <input type="range" min={4} max={20} step={2} value={sovitsEpochs}
          onChange={(e) => setSovitsEpochs(Number(e.target.value))} className="w-full" />
        <div className="mt-1 flex justify-between text-xs text-gray-400"><span>4</span><span>20</span></div>
      </div>

      <button
        onClick={onCreate}
        disabled={!voiceName.trim() || creating}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        {creating ? "Saving…" : hasJob ? "Save & continue" : "Create job"}
        {!creating && <IoChevronForward />}
      </button>
    </div>
  );
}

function MicRecorder({ onRecorded }: { onRecorded: (f: File) => void }) {
  const [recState, setRecState] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecState("processing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        try {
          const file = await blobToWavFile(blob, `recording-${Date.now()}.wav`);
          onRecorded(file);
        } catch (err) { console.error(err); }
        finally { setRecState("idle"); setElapsed(0); }
      };
      mr.start();
      setRecState("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) { console.error("Microphone access denied:", err); }
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
  };

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }, []);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="flex items-center gap-3">
      {recState === "idle" && (
        <button onClick={startRecording}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
          <IoMicOutline className="h-4 w-4" /> Record from microphone
        </button>
      )}
      {recState === "recording" && (
        <>
          <span className="flex items-center gap-2 text-sm text-red-600">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />{mm}:{ss}
          </span>
          <button onClick={stopRecording}
            className="flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400">
            <IoStopCircleOutline className="h-4 w-4" /> Stop
          </button>
        </>
      )}
      {recState === "processing" && (
        <span className="flex items-center gap-2 text-sm text-gray-500">
          <IoRefreshOutline className="h-4 w-4 animate-spin" /> Encoding WAV…
        </span>
      )}
    </div>
  );
}

function StepUpload({
  files, onSelect, onRemove, onNext, uploading, fileInputRef, onAddRecording,
  onBack, serverFiles, onDeleteServerFile,
}: {
  files: File[];
  onSelect: (f: FileList | null) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddRecording: (f: File) => void;
  onBack: () => void;
  serverFiles: { name: string; size: number }[];
  onDeleteServerFile: (name: string) => Promise<void>;
}) {
  const totalMB = files.reduce((s, f) => s + f.size / 1024 / 1024, 0);
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Upload audio files for training. At least 5 minutes of clean speech is recommended.
      </p>

      {serverFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Already uploaded</p>
          <ul className="space-y-1 text-sm">
            {serverFiles.map((f) => (
              <li key={f.name} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
                <div className="ml-2 flex items-center gap-3">
                  <span className="text-xs text-gray-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button onClick={() => onDeleteServerFile(f.name)} className="text-gray-400 hover:text-red-500">
                    <IoTrashOutline />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 px-6 py-10 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onSelect(e.dataTransfer.files); }}
      >
        <IoCloudUploadOutline className="mb-2 h-8 w-8 text-gray-400" />
        <p className="text-sm text-gray-500">Click or drag audio files here</p>
        <p className="mt-1 text-xs text-gray-400">WAV, MP3, M4A, FLAC, OGG and more — converted automatically</p>
        <input ref={fileInputRef} type="file" accept=".wav,.mp3,.m4a,.mp4,.flac,.ogg,.webm,.aac"
          multiple className="hidden" onChange={(e) => onSelect(e.target.files)} />
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        <span className="text-xs text-gray-400">or</span>
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>

      <MicRecorder onRecorded={onAddRecording} />

      {files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {files.map((f) => (
            <li key={f.name} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700">
              <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
              <div className="ml-2 flex items-center gap-3">
                <span className="text-xs text-gray-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                <button onClick={() => onRemove(f.name)} className="text-gray-400 hover:text-red-500">
                  <IoTrashOutline />
                </button>
              </div>
            </li>
          ))}
          <li className="px-3 py-1 text-xs text-gray-400">Total: {totalMB.toFixed(1)} MB</li>
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
        <button onClick={onNext} disabled={(files.length === 0 && serverFiles.length === 0) || uploading}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
          {uploading ? "Uploading…" : "Upload & continue"}
          {!uploading && <IoChevronForward />}
        </button>
      </div>
    </div>
  );
}

function LogConsole({ logs, logsEndRef }: { logs: string[]; logsEndRef: React.RefObject<HTMLDivElement> }) {
  return (
    <pre className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-gray-900 p-3 text-xs text-green-400 dark:bg-gray-950">
      {logs.length === 0 ? "Waiting for output…" : logs.join("\n")}
      <div ref={logsEndRef} />
    </pre>
  );
}

function StepLog({
  title, description, runLabel, logs, running, stepDone, stepError,
  onRun, onNext, onBack, logsEndRef, wasCompleted,
}: {
  title: string; description: string; runLabel: string;
  logs: string[]; running: boolean; stepDone: boolean; stepError: string | null;
  onRun: () => void; onNext: () => void; onBack: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>; wasCompleted?: boolean;
}) {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">{title}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      </div>

      <button
        onClick={onRun}
        disabled={running}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900"
      >
        {running ? (
          <><IoRefreshOutline className="h-4 w-4 animate-spin" /> Running…</>
        ) : wasCompleted ? (
          <>Re-run {runLabel}</>
        ) : (
          <>{runLabel}</>
        )}
      </button>

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
        <button onClick={onNext} disabled={!stepDone && !wasCompleted}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
          Continue <IoChevronForward />
        </button>
      </div>
    </div>
  );
}

function StepDeploy({
  deployed, deploying, running, stepDone, logs, logsEndRef, stepError, onDeploy, onBack,
}: {
  deployed: boolean; deploying: boolean; running: boolean; stepDone: boolean;
  logs: string[]; logsEndRef: React.RefObject<HTMLDivElement>;
  stepError: string | null; onDeploy: () => void; onBack: () => void;
}) {
  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">Deploy</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Copies the trained GPT and SoVITS weights to the voices directory and marks your voice active.
        </p>
      </div>

      {deployed ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Voice deployed successfully.
        </div>
      ) : (
        <button
          onClick={onDeploy}
          disabled={deploying || running}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900"
        >
          {deploying || running ? (
            <><IoRefreshOutline className="h-4 w-4 animate-spin" /> Deploying…</>
          ) : "Deploy Voice"}
        </button>
      )}

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
      </div>
    </div>
  );
}
