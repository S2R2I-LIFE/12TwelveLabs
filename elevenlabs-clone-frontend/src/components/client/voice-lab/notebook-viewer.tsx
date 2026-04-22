"use client";

export function NotebookViewer({
  token,
  workDir,
}: {
  token: string;
  workDir: string | null;
}) {
  // JupyterLab root_dir is /workspace, so paths must be relative to that.
  // workDir from DB is an absolute container path like /workspace/jobs/<id>.
  const relativePath = workDir
    ? workDir.replace(/^\/workspace\/?/, "")
    : "notebooks";

  const src = `/jupyter/lab/tree/${relativePath}?token=${token}`;

  return (
    <div className="flex h-full w-full flex-col">
      {!workDir && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
          No active training job — showing the notebooks directory. Start a
          training job to browse its workspace here instead.
        </div>
      )}
      <iframe
        src={src}
        className="h-full w-full flex-1 rounded-lg border border-gray-200 dark:border-gray-700"
        title="JupyterLab"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
