"use client";

import { useEffect, useRef, useState } from "react";
import {
  IoChevronDown,
  IoChevronUp,
  IoTrashOutline,
  IoFolderOpenOutline,
  IoPlayOutline,
  IoCloseOutline,
  IoDocumentOutline,
  IoMusicalNoteOutline,
} from "react-icons/io5";
import { useVoiceStore } from "~/stores/voice-store";
import { ServiceType } from "~/types/services";

// Custom voices have IDs like "voice-xxxxxxxx" (from finetune-api)
function isCustomVoice(voiceId: string) {
  return voiceId.startsWith("voice-");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Files modal ────────────────────────────────────────────────────────────────

type VoiceFile = { name: string; size: number; category: "deployed" | "training" };

function FilesModal({
  voiceId,
  voiceName,
  onClose,
}: {
  voiceId: string;
  voiceName: string;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<VoiceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/voice-lab/voices/${voiceId}/files`)
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [voiceId]);

  const handleDeleteFile = async (filename: string) => {
    setDeleting(filename);
    try {
      await fetch(`/api/voice-lab/voices/${voiceId}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      setFiles((prev) => prev.filter((f) => f.name !== filename));
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(null);
    }
  };

  const deployed = files.filter((f) => f.category === "deployed");
  const training = files.filter((f) => f.category === "training");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-xl dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
          <div>
            <p className="font-semibold text-gray-900 dark:text-white">{voiceName}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Voice files</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <IoCloseOutline className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-6 text-center text-sm text-gray-400">Loading…</p>
          ) : files.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">No files found</p>
          ) : (
            <div className="space-y-4">
              {deployed.length > 0 && (
                <section>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                    Deployed
                  </p>
                  <div className="space-y-1">
                    {deployed.map((f) => (
                      <FileRow
                        key={f.name}
                        file={f}
                        deleting={deleting === f.name}
                        onDelete={() => handleDeleteFile(f.name)}
                      />
                    ))}
                  </div>
                </section>
              )}
              {training.length > 0 && (
                <section>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                    Training audio ({training.length} files)
                  </p>
                  <div className="space-y-1">
                    {training.map((f) => (
                      <FileRow
                        key={f.name}
                        file={f}
                        deleting={deleting === f.name}
                        onDelete={() => handleDeleteFile(f.name)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  deleting,
  onDelete,
}: {
  file: VoiceFile;
  deleting: boolean;
  onDelete: () => void;
}) {
  const isWav = file.name.toLowerCase().endsWith(".wav");
  const Icon = isWav ? IoMusicalNoteOutline : IoDocumentOutline;

  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700">
      <Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
      <span className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{file.name}</span>
      <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{formatBytes(file.size)}</span>
      <button
        onClick={onDelete}
        disabled={deleting}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
      >
        {deleting ? (
          <span className="text-xs">…</span>
        ) : (
          <IoTrashOutline className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

// ── Voice selector ─────────────────────────────────────────────────────────────

export function VoiceSelector({ service }: { service: ServiceType }) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filesVoiceId, setFilesVoiceId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const getVoices = useVoiceStore((s) => s.getVoices);
  const getSelectedVoice = useVoiceStore((s) => s.getSelectedVoice);
  const selectVoice = useVoiceStore((s) => s.selectVoice);
  const removeVoice = useVoiceStore((s) => s.removeVoice);

  const voices = getVoices(service);
  const selectedVoice = getSelectedVoice(service);
  const filesVoice = voices.find((v) => v.id === filesVoiceId);

  useEffect(() => {
    if (!isOpen) setConfirmDelete(null);
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleDeleteVoice = async (voiceId: string) => {
    setDeleting(voiceId);
    try {
      await fetch(`/api/voice-lab/voices/${voiceId}`, { method: "DELETE" });
      removeVoice(service, voiceId);
      setConfirmDelete(null);
      setIsOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        {/* Trigger */}
        <div
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2 hover:cursor-pointer hover:bg-gray-100 hover:bg-opacity-30 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <div className="flex items-center">
            <div
              className="relative mr-2.5 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full"
              style={{ background: selectedVoice?.gradientColors }}
            />
            <span className="text-sm">{selectedVoice?.name ?? "No voice selected"}</span>
          </div>
          {isOpen ? (
            <IoChevronUp className="h-4 w-4 text-gray-400" />
          ) : (
            <IoChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
            {voices.map((voice) => {
              const custom = isCustomVoice(voice.id);
              const confirming = confirmDelete === voice.id;
              const isDeleting = deleting === voice.id;

              if (confirming) {
                return (
                  <div
                    key={voice.id}
                    className="flex items-center justify-between gap-2 bg-red-50 px-3 py-2 dark:bg-red-900/20"
                  >
                    <span className="text-sm text-red-700 dark:text-red-400">Delete "{voice.name}"?</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleDeleteVoice(voice.id)}
                        disabled={isDeleting}
                        className="rounded bg-red-500 px-2 py-0.5 text-xs text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {isDeleting ? "…" : "Delete"}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={voice.id}
                  className={`group flex items-center px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 ${voice.id === selectedVoice?.id ? "bg-gray-50 dark:bg-gray-700/50" : ""}`}
                >
                  {/* Select area */}
                  <div
                    className="flex flex-1 cursor-pointer items-center"
                    onClick={() => {
                      selectVoice(service, voice.id);
                      setIsOpen(false);
                    }}
                  >
                    <div
                      className="relative mr-2 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full"
                      style={{ background: voice.gradientColors }}
                    />
                    <span className="text-sm dark:text-gray-300">{voice.name}</span>
                  </div>

                  {/* Action buttons — only for custom voices */}
                  {custom && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Manage files"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsOpen(false);
                          setFilesVoiceId(voice.id);
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                      >
                        <IoFolderOpenOutline className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Delete voice"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(voice.id);
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <IoTrashOutline className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {voices.length === 0 && (
              <p className="px-3 py-2 text-sm text-gray-400">No voices available</p>
            )}
          </div>
        )}
      </div>

      {/* Files modal */}
      {filesVoiceId && filesVoice && (
        <FilesModal
          voiceId={filesVoiceId}
          voiceName={filesVoice.name}
          onClose={() => setFilesVoiceId(null)}
        />
      )}
    </>
  );
}
