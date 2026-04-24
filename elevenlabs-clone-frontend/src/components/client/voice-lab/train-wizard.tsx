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

// ── WAV encoding helpers ───────────────────────────────────────────────────────

function audioBufferToWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length;
  const ab = new ArrayBuffer(44 + len * numCh * 2);
  const v = new DataView(ab);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + len * numCh * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len * numCh * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]!));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
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

// ── Status → step mapping ──────────────────────────────────────────────────────

function statusToStep(status: string): number {
  if (status === "ready") return 7;
  if (status === "training_done") return 7;
  if (status.startsWith("train")) return 6;
  if (status === "phonemizing_done") return 6;
  if (status.startsWith("phonemiz")) return 5;
  if (status === "segmenting_done") return 4;
  if (status.startsWith("segment") || status === "curating") return 4;
  if (status.startsWith("transcrib") || status === "preprocessing") return 3;
  return 2; // uploading, or anything else
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Clip {
  filename: string;
  transcription: string;
  duration: number;
}

interface JobState {
  jobId: string;
  voiceModelId: string;
}

const STEP_LABELS = [
  "Name Your Voice",
  "Upload Audio",
  "Preprocess",
  "Curate Dataset",
  "Phonemize",
  "Train",
  "Deploy",
];

const LANGUAGES = [
  { value: "en-us", label: "English (US)" },
  { value: "en-gb", label: "English (GB)" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
];

// ── Main component ─────────────────────────────────────────────────────────────

export function TrainWizard({
  initialJob,
}: {
  initialJob: {
    id: string;
    voiceModelId: string;
    jobWorkDir: string | null;
    status: string;
    trainingEpochs?: number;
  } | null;
}) {
  const setVoices = useVoiceStore((s) => s.setVoices);

  const [step, setStep] = useState(
    initialJob ? statusToStep(initialJob.status) : 1,
  );
  const maxStepReached = useRef(
    initialJob ? statusToStep(initialJob.status) : 1,
  );
  const [serverFiles, setServerFiles] = useState<{ name: string; size: number }[]>([]);
  const [job, setJob] = useState<JobState | null>(
    initialJob
      ? { jobId: initialJob.id, voiceModelId: initialJob.voiceModelId }
      : null,
  );

  // Step 1
  const [voiceName, setVoiceName] = useState("");
  const [language, setLanguage] = useState("en-us");
  const [epochs, setEpochs] = useState(initialJob?.trainingEpochs ?? 75);
  const [batchSize, setBatchSize] = useState(2);
  const [creating, setCreating] = useState(false);

  // Step 2
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3 / 5 / 6 — log console
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [stepDone, setStepDone] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Step 4
  const [clips, setClips] = useState<Clip[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loadingClips, setLoadingClips] = useState(false);

  // Step 6 — epoch progress
  const [epochProgress, setEpochProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Step 7
  // deployed = voice is live in styletts2-api (status "ready" or after clicking Activate)
  const [deployed, setDeployed] = useState(initialJob?.status === "ready");
  const [deployedVoiceId, setDeployedVoiceId] = useState<string | null>(
    initialJob?.status === "ready" ? initialJob.voiceModelId : null,
  );
  // trainingFinished = training ran to completion (safe to not delete even if not yet activated)
  const [trainingFinished, setTrainingFinished] = useState(
    initialJob?.status === "ready" || initialJob?.status === "training_done",
  );
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  // Reset / new voice
  const [resetting, setResetting] = useState(false);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Auto-reconnect to live log stream if training was already running when the page loaded
  useEffect(() => {
    if (initialJob?.status === "training" && job) {
      startSSE(job.jobId, epochs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs only on mount

  // Reset log-console state whenever the active step changes so stale stepDone/stepError
  // from a previous step doesn't bleed into the next one (e.g. phonemize done → train shows "complete")
  useEffect(() => {
    setStepDone(false);
    setStepError(null);
    setRunning(false);
  }, [step]);

  // Fetch already-uploaded audio files when returning to step 2
  useEffect(() => {
    if (step === 2 && job) {
      fetch(`/api/voice-lab/jobs/${job.jobId}/audio`)
        .then((r) => r.json())
        .then((d: { files?: { name: string; size: number }[] }) =>
          setServerFiles(d.files ?? []),
        )
        .catch(console.error);
    }
  }, [step, job]);

  // Load clips when entering step 4
  useEffect(() => {
    if (step === 4 && job) {
      setLoadingClips(true);
      fetch(`/api/voice-lab/jobs/${job.jobId}/dataset`)
        .then((r) => r.json())
        .then((d) => {
          // Deduplicate by filename — output.txt can have repeated lines
          const seen = new Set<string>();
          const unique = (d.clips ?? []).filter((c: Clip) => {
            if (seen.has(c.filename)) return false;
            seen.add(c.filename);
            return true;
          });
          setClips(unique);
        })
        .catch(console.error)
        .finally(() => setLoadingClips(false));
    }
  }, [step, job]);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const startSSE = useCallback(
    (jobId: string, totalEpochs?: number, stepLabel?: string) => {
      esRef.current?.close();
      // Append a separator rather than clearing, so the full history stays scrollable
      setLogs((prev) => [
        ...prev,
        ...(prev.length > 0 ? [""] : []),
        ...(stepLabel ? [`── ${stepLabel} ─────────────────────────────`] : []),
      ]);
      setStepDone(false);
      setStepError(null);
      setRunning(true);

      const es = new EventSource(`/api/voice-lab/jobs/${jobId}/logs`);
      esRef.current = es;

      es.onmessage = (evt) => {
        const data = JSON.parse(evt.data) as {
          type: string;
          message?: string;
          status?: string;
        };

        if (data.type === "log" && data.message) {
          setLogs((prev) => [...prev, data.message!]);

          // Parse epoch progress from training logs: "Epoch X/Y"
          if (totalEpochs) {
            const match = data.message.match(/Epoch\s+(\d+)\/(\d+)/i);
            if (match) {
              setEpochProgress({
                current: parseInt(match[1]!),
                total: parseInt(match[2]!),
              });
            }
          }
        }

        if (data.type === "complete") {
          setRunning(false);
          es.close();
          if (data.status === "failed") {
            setStepError("Step failed — see log output above for details.");
          } else {
            setStepDone(true);
          }
        }
      };

      es.onerror = () => {
        setRunning(false);
        es.close();
      };
    },
    [],
  );

  const goToStep = useCallback((n: number) => {
    maxStepReached.current = Math.max(maxStepReached.current, n);
    setStep(n);
  }, []);

  const goBack = useCallback(() => {
    if (running) {
      setStepError("A step is still running. Results may be incomplete.");
    }
    esRef.current?.close();
    setRunning(false);
    setStep((s) => s - 1);
  }, [running]);

  const STEP_LABELS_MAP: Record<string, string> = {
    "silence-buffer": "Silence Buffer",
    "transcribe": "Transcribe",
    "segment": "Segment",
    "add-padding": "Add Padding",
    "phonemize": "Phonemize",
    "train": "Train",
  };

  const runStep = useCallback(
    async (stepName: string, totalEpochs?: number) => {
      if (!job) return;
      const resp = await fetch(`/api/voice-lab/jobs/${job.jobId}/run-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: stepName }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        setLogs((prev) => [...prev, `Error: ${err.detail ?? err.error ?? JSON.stringify(err)}`]);
        return;
      }
      startSSE(job.jobId, totalEpochs, STEP_LABELS_MAP[stepName] ?? stepName);
    },
    [job, startSSE],
  );

  // ── Step handlers ─────────────────────────────────────────────────────────────

  const handleCreateJob = async () => {
    if (!voiceName.trim()) return;
    setCreating(true);
    try {
      const resp = await fetch("/api/voice-lab/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceName, language, trainingEpochs: epochs, batchSize }),
      });
      const data = await resp.json();
      setJob({ jobId: data.jobId, voiceModelId: data.voiceModelId });
      goToStep(2);
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
    }
  };

  const ACCEPTED_AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".webm", ".aac"];

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const audioFiles = Array.from(files).filter((f) =>
      ACCEPTED_AUDIO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    setUploadedFiles((prev) => [...prev, ...audioFiles]);
  };

  const handleUploadFiles = async () => {
    if (!job || uploadedFiles.length === 0) return;
    setUploading(true);
    try {
      for (const file of uploadedFiles) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/voice-lab/jobs/${job.jobId}/upload`, {
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

  const handleCurate = async () => {
    if (!job) return;
    await fetch(`/api/voice-lab/jobs/${job.jobId}/dataset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excludeFiles: Array.from(excluded) }),
    });
    goToStep(5);
  };

  const handleDeploy = async () => {
    if (!job) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const resp = await fetch(`/api/voice-lab/jobs/${job.jobId}/deploy`, {
        method: "POST",
      });
      const data = await resp.json();
      if (resp.ok) {
        setDeployed(true);
        setDeployedVoiceId(data.voiceId);
        // Refresh the voice store so the new voice appears immediately in selectors
        const updatedVoices = await getVoiceModels();
        if (updatedVoices.length > 0) setVoices(updatedVoices);
      } else {
        setDeployError(data.detail ?? data.error ?? "Deploy failed");
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
      // Delete in-progress jobs to free workspace; leave trained/deployed jobs intact
      if (job && !deployed && !trainingFinished) {
        await fetch(`/api/voice-lab/jobs/${job.jobId}`, { method: "DELETE" });
      }
    } catch (e) {
      console.error(e);
    }
    setJob(null);
    setStep(1);
    setVoiceName("");
    setLanguage("en-us");
    setEpochs(75);
    setBatchSize(2);
    setUploadedFiles([]);
    setServerFiles([]);
    setLogs([]);          // full history cleared on new voice
    setRunning(false);
    setStepDone(false);
    setStepError(null);
    setClips([]);
    setExcluded(new Set());
    setEpochProgress(null);
    setDeployed(false);
    setDeployedVoiceId(null);
    setDeployError(null);
    setTrainingFinished(false);
    setResetting(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col gap-4 md:flex-row md:gap-6">
      {/* Left stepper */}
      <div className="md:w-52 md:flex-shrink-0">
        <h2 className="mb-3 font-semibold text-gray-900 dark:text-white md:mb-4">Train Voice</h2>

        {/* Mobile: compact horizontal step dots */}
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
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${active ? "bg-gray-900 text-white" : done ? "bg-green-500 text-white" : "bg-gray-200 text-gray-400"}`}
                >
                  {done ? <IoCheckmarkCircle className="h-4 w-4" /> : n}
                </div>
                {active && (
                  <span className="max-w-[56px] text-center text-[10px] leading-tight text-gray-700">
                    {label}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Desktop: vertical step list */}
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
                  <IoEllipseOutline
                    className={`h-4 w-4 ${active ? "text-gray-700" : "text-gray-300"}`}
                  />
                )}
                {n}. {label}
              </li>
            );
          })}
        </ol>

        {(job ?? deployed) && (
          <button
            onClick={handleNewVoice}
            disabled={resetting}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 md:mt-5"
          >
            <IoAddOutline className="h-3.5 w-3.5" />
            {resetting ? "Resetting…" : "New voice"}
          </button>
        )}

        {/* Live system stats — desktop only */}
        <div className="hidden md:block">
          <SystemStats />
        </div>
      </div>

      {/* Right content */}
      <div className="min-h-0 flex-1 overflow-auto">
        {step === 1 && (
          <StepNameVoice
            voiceName={voiceName}
            setVoiceName={setVoiceName}
            language={language}
            setLanguage={setLanguage}
            epochs={epochs}
            setEpochs={setEpochs}
            batchSize={batchSize}
            setBatchSize={setBatchSize}
            onCreate={handleCreateJob}
            creating={creating}
          />
        )}

        {step === 2 && (
          <StepUpload
            files={uploadedFiles}
            onSelect={handleFileSelect}
            onRemove={(name) =>
              setUploadedFiles((prev) => prev.filter((f) => f.name !== name))
            }
            onNext={handleUploadFiles}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onAddRecording={(file) =>
              setUploadedFiles((prev) => [...prev, file])
            }
          />
        )}

        {step === 3 && job && (
          <StepPreprocess
            jobId={job.jobId}
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRunStep={runStep}
            onNext={() => setStep(4)}
            logsEndRef={logsEndRef}
          />
        )}

        {step === 4 && (
          <StepCurate
            clips={clips}
            loading={loadingClips}
            excluded={excluded}
            setExcluded={setExcluded}
            onNext={handleCurate}
          />
        )}

        {step === 5 && job && (
          <StepPhOnemize
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("phonemize")}
            onNext={() => setStep(6)}
            logsEndRef={logsEndRef}
          />
        )}

        {step === 6 && job && (
          <StepTrain
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            epochProgress={epochProgress}
            onRun={() => runStep("train", epochs)}
            onNext={() => { setTrainingFinished(true); setStep(7); }}
            logsEndRef={logsEndRef}
          />
        )}

        {step === 7 && job && (
          <StepDeploy
            voiceModelId={job.voiceModelId}
            deployed={deployed}
            deployedVoiceId={deployedVoiceId}
            deploying={deploying}
            onDeploy={handleDeploy}
            error={deployError}
          />
        )}
      </div>
    </div>
  );
}

// ── Step sub-components ────────────────────────────────────────────────────────

function StepNameVoice({
  voiceName,
  setVoiceName,
  language,
  setLanguage,
  epochs,
  setEpochs,
  batchSize,
  setBatchSize,
  onCreate,
  creating,
}: {
  voiceName: string;
  setVoiceName: (v: string) => void;
  language: string;
  setLanguage: (v: string) => void;
  epochs: number;
  setEpochs: (v: number) => void;
  batchSize: number;
  setBatchSize: (v: number) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="max-w-md space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Voice name
        </label>
        <input
          type="text"
          value={voiceName}
          onChange={(e) => setVoiceName(e.target.value)}
          placeholder="My Voice"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:focus:border-gray-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Language
        </label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:focus:border-gray-500"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Training epochs: {epochs}
        </label>
        <input
          type="range"
          min={50}
          max={350}
          step={25}
          value={epochs}
          onChange={(e) => setEpochs(Number(e.target.value))}
          className="w-full"
        />
        <div className="mt-1 flex justify-between text-xs text-gray-400 dark:text-gray-500">
          <span>50</span>
          <span>350</span>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Batch size
        </label>
        <div className="flex gap-3">
          {[1, 2].map((n) => (
            <button
              key={n}
              onClick={() => setBatchSize(n)}
              className={`rounded-lg border px-4 py-2 text-sm ${batchSize === n ? "border-gray-800 bg-gray-800 text-white dark:border-white dark:bg-white dark:text-gray-900" : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"}`}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Use 1 if you run out of GPU memory.
        </p>
      </div>

      <button
        onClick={onCreate}
        disabled={!voiceName.trim() || creating}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        {creating ? "Creating…" : "Create job"}
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

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecState("processing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const name = `recording-${Date.now()}.wav`;
        try {
          const file = await blobToWavFile(blob, name);
          onRecorded(file);
        } catch (err) {
          console.error("Failed to encode WAV:", err);
        } finally {
          setRecState("idle");
          setElapsed(0);
        }
      };

      mr.start();
      setRecState("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) {
      console.error("Microphone access denied:", err);
    }
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    };
  }, []);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="flex items-center gap-3">
      {recState === "idle" && (
        <button
          onClick={startRecording}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <IoMicOutline className="h-4 w-4" />
          Record from microphone
        </button>
      )}
      {recState === "recording" && (
        <>
          <span className="flex items-center gap-2 text-sm text-red-600">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            {mm}:{ss}
          </span>
          <button
            onClick={stopRecording}
            className="flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <IoStopCircleOutline className="h-4 w-4" />
            Stop
          </button>
        </>
      )}
      {recState === "processing" && (
        <span className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <IoRefreshOutline className="h-4 w-4 animate-spin" />
          Encoding WAV…
        </span>
      )}
    </div>
  );
}

function StepUpload({
  files,
  onSelect,
  onRemove,
  onNext,
  uploading,
  fileInputRef,
  onAddRecording,
}: {
  files: File[];
  onSelect: (f: FileList | null) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddRecording: (f: File) => void;
}) {
  const totalMB = files.reduce((s, f) => s + f.size / 1024 / 1024, 0);

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Upload audio files for training. At least 5 minutes of clean speech is
        recommended.
      </p>

      {/* Drop zone */}
      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 px-6 py-10 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onSelect(e.dataTransfer.files);
        }}
      >
        <IoCloudUploadOutline className="mb-2 h-8 w-8 text-gray-400 dark:text-gray-500" />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Click or drag audio files here
        </p>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          WAV, MP3, M4A, FLAC, OGG and more — all converted to WAV automatically
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.mp4,.flac,.ogg,.webm,.aac"
          multiple
          className="hidden"
          onChange={(e) => onSelect(e.target.files)}
        />
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        <span className="text-xs text-gray-400 dark:text-gray-500">or</span>
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>

      <MicRecorder onRecorded={onAddRecording} />

      {files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {files.map((f) => (
            <li
              key={f.name}
              className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700"
            >
              <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
              <div className="ml-2 flex items-center gap-3">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {(f.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  onClick={() => onRemove(f.name)}
                  className="text-gray-400 hover:text-red-500 dark:text-gray-500"
                >
                  <IoTrashOutline />
                </button>
              </div>
            </li>
          ))}
          <li className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500">
            Total: {totalMB.toFixed(1)} MB
          </li>
        </ul>
      )}

      <button
        onClick={onNext}
        disabled={files.length === 0 || uploading}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        {uploading ? "Uploading…" : "Upload & continue"}
        {!uploading && <IoChevronForward />}
      </button>
    </div>
  );
}

function LogConsole({
  logs,
  logsEndRef,
}: {
  logs: string[];
  logsEndRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <pre className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-gray-900 p-3 text-xs text-green-400 dark:bg-gray-950">
      {logs.length === 0
        ? "Waiting for output…"
        : logs.join("\n")}
      <div ref={logsEndRef} />
    </pre>
  );
}

function StepPreprocess({
  jobId,
  logs,
  running,
  stepDone,
  stepError,
  onRunStep,
  onNext,
  logsEndRef,
}: {
  jobId: string;
  logs: string[];
  running: boolean;
  stepDone: boolean;
  stepError: string | null;
  onRunStep: (step: string) => void;
  onNext: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>;
}) {
  const [ranTranscribe, setRanTranscribe] = useState(false);
  const [ranSegment, setRanSegment] = useState(false);

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Run preprocessing steps in order. Silence buffer is optional.
      </p>

      <div className="space-y-2">
        <StepButton
          label="Add silence buffer (optional)"
          onClick={() => onRunStep("silence-buffer")}
          disabled={running}
        />
        <StepButton
          label="Transcribe audio (WhisperX)"
          onClick={() => {
            setRanTranscribe(true);
            onRunStep("transcribe");
          }}
          disabled={running}
        />
        <StepButton
          label="Segment audio"
          onClick={() => {
            setRanSegment(true);
            onRunStep("segment");
          }}
          disabled={running || !ranTranscribe}
        />
        <StepButton
          label="Add padding"
          onClick={() => onRunStep("add-padding")}
          disabled={running || !ranSegment}
        />
      </div>

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!ranSegment}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        Continue to curate <IoChevronForward />
      </button>
    </div>
  );
}

function StepCurate({
  clips,
  loading,
  excluded,
  setExcluded,
  onNext,
}: {
  clips: Clip[];
  loading: boolean;
  excluded: Set<string>;
  setExcluded: React.Dispatch<React.SetStateAction<Set<string>>>;
  onNext: () => void;
}) {
  const toggle = (name: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Review segmented clips. Check the ones you want to exclude, then
        continue.
      </p>

      {loading ? (
        <p className="text-sm text-gray-400">Loading clips…</p>
      ) : clips.length === 0 ? (
        <p className="text-sm text-gray-400">No clips found yet.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-400">
                  Exclude
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-400">
                  File
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-400">
                  Duration
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-400">
                  Transcription
                </th>
              </tr>
            </thead>
            <tbody>
              {clips.map((c) => (
                <tr
                  key={c.filename}
                  className={`border-t border-gray-100 dark:border-gray-700 ${excluded.has(c.filename) ? "bg-red-50 dark:bg-red-900/20" : ""}`}
                >
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={excluded.has(c.filename)}
                      onChange={() => toggle(c.filename)}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {c.filename}
                  </td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                    {c.duration.toFixed(1)}s
                  </td>
                  <td className="max-w-xs truncate px-3 py-2 text-gray-700 dark:text-gray-300">
                    {c.transcription}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 dark:text-gray-500">
        {clips.length - excluded.size} / {clips.length} clips kept
      </p>

      <button
        onClick={onNext}
        disabled={loading}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        Save & continue <IoChevronForward />
      </button>
    </div>
  );
}

function StepPhOnemize({
  logs,
  running,
  stepDone,
  stepError,
  onRun,
  onNext,
  logsEndRef,
}: {
  logs: string[];
  running: boolean;
  stepDone: boolean;
  stepError: string | null;
  onRun: () => void;
  onNext: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Generate IPA phonemizations and build train/val splits.
      </p>

      <button
        onClick={onRun}
        disabled={running || stepDone}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        {running ? (
          <>
            <IoRefreshOutline className="animate-spin" /> Running…
          </>
        ) : stepDone ? (
          <>
            <IoCheckmarkCircle className="text-green-400" /> Done
          </>
        ) : (
          "Run phonemizer"
        )}
      </button>

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!stepDone}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        Continue to train <IoChevronForward />
      </button>
    </div>
  );
}

function StepTrain({
  logs,
  running,
  stepDone,
  stepError,
  epochProgress,
  onRun,
  onNext,
  logsEndRef,
}: {
  logs: string[];
  running: boolean;
  stepDone: boolean;
  stepError: string | null;
  epochProgress: { current: number; total: number } | null;
  onRun: () => void;
  onNext: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>;
}) {
  const pct = epochProgress
    ? Math.round((epochProgress.current / epochProgress.total) * 100)
    : 0;

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Train the fine-tuned model. You can close this page and return — the job
        continues in the background.
      </p>

      <button
        onClick={onRun}
        disabled={running || stepDone}
        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50 ${stepError ? "bg-red-700 text-white hover:bg-red-600" : "bg-gray-900 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"}`}
      >
        {running ? (
          <>
            <IoRefreshOutline className="animate-spin" /> Training…
          </>
        ) : stepDone ? (
          <>
            <IoCheckmarkCircle className="text-green-400" /> Training complete
          </>
        ) : stepError ? (
          "Retry training"
        ) : (
          "Start training"
        )}
      </button>

      {epochProgress && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>
              Epoch {epochProgress.current} / {epochProgress.total}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full bg-gray-800 transition-all dark:bg-white"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!stepDone}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        Continue to deploy <IoChevronForward />
      </button>
    </div>
  );
}

function StepDeploy({
  voiceModelId,
  deployed,
  deployedVoiceId,
  deploying,
  onDeploy,
  error,
}: {
  voiceModelId: string;
  deployed: boolean;
  deployedVoiceId: string | null;
  deploying: boolean;
  onDeploy: () => void;
  error: string | null;
}) {
  return (
    <div className="max-w-md space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Deploy your trained voice. It will appear in the voice selector without
        any Docker rebuild.
      </p>

      {deployed ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
          <p className="font-medium text-green-800 dark:text-green-400">Voice deployed!</p>
          <p className="mt-1 text-sm text-green-700 dark:text-green-500">
            Voice ID: <code className="font-mono">{deployedVoiceId}</code>
          </p>
          <a
            href="/app/speech-synthesis/text-to-speech"
            className="mt-3 inline-flex items-center gap-1 text-sm text-green-700 underline dark:text-green-500"
          >
            Try in Text to Speech <IoChevronForward className="h-3 w-3" />
          </a>
        </div>
      ) : (
        <>
          <button
            onClick={onDeploy}
            disabled={deploying}
            className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            {deploying ? "Activating…" : "Activate voice"}
          </button>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:disabled:text-gray-600"
    >
      {label}
    </button>
  );
}

// ── System stats widget ────────────────────────────────────────────────────────

interface StatsPayload {
  cpu: number;
  ram: number;
  gpu: number | null;
  vramUsed: number | null;
  vramTotal: number | null;
}

function StatBar({ pct }: { pct: number }) {
  const color =
    pct > 80 ? "bg-red-500" : pct > 60 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      <div
        className={`h-1.5 rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function SystemStats() {
  const [stats, setStats] = useState<StatsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/voice-lab/system-stats");
        if (!res.ok) return;
        const data = (await res.json()) as StatsPayload;
        if (!cancelled) setStats(data);
      } catch {
        // finetune-api not running — silently skip
      }
    }

    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!stats) return null;

  const rows: { label: string; pct: number }[] = [
    { label: "CPU", pct: stats.cpu },
    { label: "RAM", pct: stats.ram },
    ...(stats.gpu !== null ? [{ label: "GPU", pct: stats.gpu }] : []),
  ];

  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        System
      </p>
      <div className="space-y-2">
        {rows.map(({ label, pct }) => (
          <div key={label} className="space-y-1">
            <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400">
              <span>{label}</span>
              <span>{Math.round(pct)}%</span>
            </div>
            <StatBar pct={pct} />
          </div>
        ))}
      </div>
      {stats.vramUsed !== null && stats.vramTotal !== null && (
        <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500">
          VRAM {(stats.vramUsed / 1024).toFixed(1)} /{" "}
          {(stats.vramTotal / 1024).toFixed(1)} GB
        </p>
      )}
    </div>
  );
}
