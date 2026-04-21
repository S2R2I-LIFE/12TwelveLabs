"use client";

import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { FaUpload } from "react-icons/fa";
import {
  IoMicOutline,
  IoRefreshOutline,
  IoStopCircleOutline,
} from "react-icons/io5";
import {
  generateSpeechToSpeech,
  generateUploadUrl,
  generationStatus,
} from "~/actions/generate-speech";
import { GenerateButton } from "~/components/client/generate-button";
import { useAudioStore } from "~/stores/audio-store";
import { useVoiceStore } from "~/stores/voice-store";
import { ServiceType } from "~/types/services";

const ALLOWED_AUDIO_TYPES = ["audio/mp3", "audio/wav"];

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

// ── Component ──────────────────────────────────────────────────────────────────

export function VoiceChanger({
  credits,
  service,
}: {
  credits: number;
  service: ServiceType;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentAudioId, setCurrentAudioId] = useState<string | null>(null);

  // Mic recorder state
  const [recState, setRecState] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { playAudio } = useAudioStore();
  const getSelectedVoice = useVoiceStore((state) => state.getSelectedVoice);

  const handleFileSelect = (selectedFile: File) => {
    const isAllowedAudio = ALLOWED_AUDIO_TYPES.includes(selectedFile.type);
    const isUnder50MB = selectedFile.size <= 50 * 1024 * 1024;

    if (isAllowedAudio && isUnder50MB) {
      setFile(selectedFile);
    } else {
      alert(
        isAllowedAudio
          ? "File is too large. Max size is 50MB"
          : "Please select an MP3 or WAV file only",
      );
    }
  };

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
        try {
          const wavFile = await blobToWavFile(blob, `recording-${Date.now()}.wav`);
          setFile(wavFile);
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
      if (mediaRecorderRef.current?.state === "recording")
        mediaRecorderRef.current.stop();
    };
  }, []);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const handleGenerateSpeech = async () => {
    const selectedVoice = getSelectedVoice("seedvc");

    if (!file || !selectedVoice) return;

    try {
      setIsLoading(true);

      const { uploadUrl, key } = await generateUploadUrl(file.type);

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file to storage");
      }

      const { audioId, shouldShowThrottleAlert } = await generateSpeechToSpeech(
        key,
        selectedVoice.id,
      );

      if (shouldShowThrottleAlert) {
        toast("Exceeding 3 requests per minute will queue your requests.", {
          icon: "⏳",
        });
      }
      setCurrentAudioId(audioId);
    } catch (error) {
      console.error("Error generating speech: ", error);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!currentAudioId || !isLoading) return;

    const pollInterval = setInterval(async () => {
      try {
        const status = await generationStatus(currentAudioId);

        const selectedVoice = getSelectedVoice("seedvc");

        if (status.success && status.audioUrl && selectedVoice) {
          clearInterval(pollInterval);
          setIsLoading(false);

          const newAudio = {
            id: currentAudioId,
            title: file?.name || "Voice changed audio",
            audioUrl: status.audioUrl,
            voice: selectedVoice.id,
            duration: "0:30",
            progress: 0,
            service: service,
            createdAt: new Date().toLocaleDateString(),
          };

          playAudio(newAudio);
          setCurrentAudioId(null);
          setFile(null);
        } else if (!status.success) {
          clearInterval(pollInterval);
          setIsLoading(false);
          setCurrentAudioId(null);
          console.error("Voice changing failed");
        }
      } catch (error) {
        console.error("Error polling for audio status: " + error);
        clearInterval(pollInterval);
        setIsLoading(false);
        setCurrentAudioId(null);
      }
    }, 500);

    return () => {
      clearInterval(pollInterval);
    };
  }, [currentAudioId, isLoading, getSelectedVoice, playAudio, file]);

  return (
    <>
      <div className="flex flex-1 flex-col justify-between px-4">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8">
          {/* Drop zone */}
          <div
            className={`w-full max-w-xl rounded-2xl border-2 border-dotted p-8 transition-all duration-200 ${isDragging ? "border-blue-400 bg-blue-50" : "border-gray-300"} ${file ? "bg-white" : "bg-gray-50"}`}
            onDragOver={() => setIsDragging(true)}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const f = e.dataTransfer.files[0];
                if (f) handleFileSelect(f);
              }
            }}
            onClick={() => {
              if (isLoading || recState === "recording") return;
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "audio/mp3,audio/wav";
              input.onchange = (e) => {
                const target = e.target as HTMLInputElement;
                if (target.files && target.files.length > 0) {
                  const f = target.files[0];
                  if (f) handleFileSelect(f);
                }
              };
              input.click();
            }}
          >
            {file ? (
              <div className="flex flex-col items-center text-center">
                <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3">
                  <FaUpload className="h-4 w-4 text-blue-400" />
                </div>
                <p className="mb-1 text-sm font-medium">{file.name}</p>
                <p className="mb-1 text-sm font-medium">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isLoading) setFile(null);
                  }}
                  disabled={isLoading}
                  className={`mt-2 text-sm ${isLoading ? "cursor-not-allowed text-gray-400" : "text-blue-600 hover:text-blue-800"}`}
                >
                  Choose a different file
                </button>
              </div>
            ) : (
              <div className="flex cursor-pointer flex-col items-center py-8 text-center">
                <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3">
                  <FaUpload className="h-4 w-4 text-gray-500" />
                </div>
                <p className="mb-1 text-sm font-medium">
                  Click to upload, or drag and drop
                </p>
                <p className="text-xs text-gray-500">
                  MP3 or WAV files only, up to 50MB
                </p>
              </div>
            )}
          </div>

          {/* Mic recorder — only when no file is selected */}
          {!file && (
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-3">
                <div className="h-px w-20 bg-gray-200" />
                <span className="text-xs text-gray-400">or</span>
                <div className="h-px w-20 bg-gray-200" />
              </div>

              {recState === "idle" && (
                <button
                  onClick={startRecording}
                  disabled={isLoading}
                  className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  <IoMicOutline className="h-4 w-4" />
                  Record from microphone
                </button>
              )}

              {recState === "recording" && (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-2 text-sm text-red-600">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                    {mm}:{ss}
                  </span>
                  <button
                    onClick={stopRecording}
                    className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 hover:bg-red-100"
                  >
                    <IoStopCircleOutline className="h-4 w-4" />
                    Stop recording
                  </button>
                </div>
              )}

              {recState === "processing" && (
                <span className="flex items-center gap-2 text-sm text-gray-500">
                  <IoRefreshOutline className="h-4 w-4 animate-spin" />
                  Encoding audio…
                </span>
              )}
            </div>
          )}
        </div>

        <GenerateButton
          onGenerate={handleGenerateSpeech}
          isDisabled={!file || isLoading}
          isLoading={isLoading}
          showDownload={true}
          creditsRemaining={credits}
          buttonText="Convert Voice"
        />
      </div>
    </>
  );
}
