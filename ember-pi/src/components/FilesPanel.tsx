import { useState, useCallback, useEffect, useRef } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useAppStore, useEphemeralStore } from '../stores/appStore';
import { listDir, readFile, copyFile, writeFileBytes, deleteFile } from '../services/files';
import type { WorkspaceFile } from '../types';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

function formatDate(secs: number): string {
  return new Date(secs * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fileIcon(file: WorkspaceFile): string {
  if (file.isDir) return '📁';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg'].includes(ext)) return '🖼';
  if (['pdf'].includes(ext)) return '📄';
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z'].includes(ext)) return '📦';
  if (['sh', 'bash', 'zsh', 'fish'].includes(ext)) return '⚙';
  if (['py', 'rb', 'js', 'ts', 'go', 'rs', 'c', 'cpp', 'java'].includes(ext)) return '◈';
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'csv'].includes(ext)) return '≡';
  if (['txt', 'md', 'log', 'conf', 'cfg'].includes(ext)) return '◻';
  return '·';
}

export function FilesPanel() {
  const { runtimeHealth } = useAppStore();
  const rootPath = runtimeHealth?.sharedPath ?? '';

  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<{ file: WorkspaceFile; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // file.path pending confirm

  // Keep a ref so the Tauri event handler always sees the latest values
  const currentPathRef = useRef(currentPath);
  const loadRef = useRef<(path: string) => Promise<void>>(async () => {});
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const dest = currentPathRef.current;
    if (!dest) return;

    const errors: string[] = [];
    const names = Array.from(fileList).map((f) => f.name);
    setCopying(names);

    for (const file of Array.from(fileList)) {
      try {
        await writeFileBytes(`${dest}/${file.name}`, file);
      } catch (err) {
        errors.push(`${file.name}: ${err}`);
      }
    }

    // Reset input so the same file can be re-uploaded
    e.target.value = '';
    useEphemeralStore.getState().setSuppressBlurCollapse(false);
    setCopying([]);
    if (errors.length) setError(errors.join('\n'));
    await loadRef.current(dest);
  }, []);

  const load = useCallback(async (path: string) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listDir(path);
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(result);
      setCurrentPath(path);
      currentPathRef.current = path;
    } catch (e) {
      setError(`Cannot read folder: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep loadRef current
  useEffect(() => { loadRef.current = load; }, [load]);

  // Load root when workspace becomes available
  useEffect(() => {
    if (rootPath && currentPath !== rootPath) {
      load(rootPath);
    }
  }, [rootPath, currentPath, load]);

  // ── Tauri drag-and-drop event handler ────────────────────────────────────
  // Tauri intercepts file drops before the browser sees them.
  // onDragDropEvent gives us the host filesystem paths of dropped files.

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;

      if (payload.type === 'enter') {
        setDragging(true);
      } else if (payload.type === 'leave') {
        setDragging(false);
      } else if (payload.type === 'drop') {
        setDragging(false);
        const dest = currentPathRef.current;
        if (!dest || payload.paths.length === 0) return;

        const names = payload.paths.map((p) => p.split('/').pop() ?? p);
        setCopying(names);

        const errors: string[] = [];
        for (const srcPath of payload.paths) {
          const fileName = srcPath.split('/').pop() ?? 'file';
          try {
            await copyFile(srcPath, `${dest}/${fileName}`);
          } catch (e) {
            errors.push(`${fileName}: ${e}`);
          }
        }

        setCopying([]);
        if (errors.length) setError(errors.join('\n'));
        await loadRef.current(dest);
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []); // register once — uses refs for current values

  // ── File viewer ───────────────────────────────────────────────────────────

  if (viewing) {
    const ext = viewing.file.name.split('.').pop()?.toLowerCase() ?? '';
    const isBinary = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'pdf', 'zip', 'tar', 'gz', 'bin', 'exe'].includes(ext);
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
          <button
            onClick={() => setViewing(null)}
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-300 transition"
          >
            ← back
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">{viewing.file.name}</span>
          <span className="shrink-0 text-[10px] text-slate-600">{formatSize(viewing.file.size)}</span>
          <button
            onClick={() => revealItemInDir(viewing.file.path)}
            className="shrink-0 rounded p-1 text-slate-600 hover:text-slate-300 transition"
            title="Show in Finder"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 9V10H10V9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M6 1V7.5M6 7.5L4 5.5M6 7.5L8 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5 scrollbar-thin">
          {isBinary ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-[12px] text-slate-600">Binary file — cannot preview.</p>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.7] text-slate-300">
              {viewing.content || '(empty file)'}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // ── Main file list ─────────────────────────────────────────────────────────

  const isAtRoot = currentPath === rootPath;
  const relPath = currentPath.replace(rootPath, '') || '/';

  const openFile = async (file: WorkspaceFile) => {
    if (file.isDir) { load(file.path); return; }
    try {
      const content = await readFile(file.path);
      setViewing({ file, content });
    } catch (e) {
      setViewing({ file, content: `Could not read file:\n${e}` });
    }
  };

  const navigateUp = () => {
    if (currentPath === rootPath) return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || rootPath;
    load(parent);
  };

  return (
    <div className="flex h-full flex-col">
      {/* File input — must NOT use display:none; WKWebView blocks .click() on hidden inputs */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        onChange={handleUpload}
      />

      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-white/8 px-3 py-2">
        <button
          onClick={navigateUp}
          disabled={isAtRoot}
          className="rounded p-1 text-[12px] text-slate-500 transition hover:text-slate-300 disabled:opacity-25"
          title="Go up"
        >
          ↑
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500" title={currentPath}>
          workspace{relPath}
        </span>
        <button
          onClick={() => {
            useEphemeralStore.getState().setSuppressBlurCollapse(true);
            uploadInputRef.current?.click();
          }}
          className="rounded p-1 text-slate-600 transition hover:text-slate-300"
          title="Upload files"
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
            <path d="M2 9V10H10V9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M6 7.5V1M6 1L4 3M6 1L8 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          onClick={() => load(currentPath)}
          className="rounded p-1 text-[12px] text-slate-600 transition hover:text-slate-300"
          title="Refresh"
        >
          ↺
        </button>
      </div>

      {/* File list area — also acts as drop target (window-level drop handled by Tauri) */}
      <div className={`relative min-h-0 flex-1 overflow-y-auto scrollbar-thin transition-colors ${dragging ? 'bg-[rgba(255,109,43,0.04)]' : ''}`}>

        {/* Drop overlay */}
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-[rgba(255,109,43,0.5)] bg-[rgba(255,109,43,0.05)]">
            <p className="text-[12px] font-medium text-[rgba(255,109,43,0.9)]">Drop to add to workspace</p>
          </div>
        )}

        {/* Copy progress */}
        {copying.length > 0 && (
          <div className="mx-3 mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2">
            <p className="animate-pulse text-[11px] text-amber-400">
              Copying {copying.length === 1 ? copying[0] : `${copying.length} files`}…
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-3 mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
            <p className="whitespace-pre-wrap text-[11px] text-red-400">{error}</p>
            <button onClick={() => setError(null)} className="mt-1 text-[10px] text-red-500 hover:text-red-300">
              dismiss
            </button>
          </div>
        )}

        {/* No workspace */}
        {!rootPath && !loading && (
          <div className="px-4 pt-10 text-center">
            <p className="text-[12px] text-slate-600">Docker workspace not connected.</p>
            <p className="mt-1 text-[11px] text-slate-700">Start the runtime in Settings → Runtime.</p>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-10">
            <span className="animate-pulse text-[11px] text-slate-600">Loading…</span>
          </div>
        )}

        {/* Empty */}
        {!loading && rootPath && files.length === 0 && !error && (
          <div className="px-4 pt-10 text-center">
            <p className="text-[12px] text-slate-600">Empty workspace</p>
            <p className="mt-1 text-[11px] text-slate-700">Drag files here from Finder to add them.</p>
          </div>
        )}

        {/* File list */}
        {!loading && files.length > 0 && (
          <div className="py-1.5">
            {files.map((file) => (
              <div
                key={file.path}
                className="group flex w-full items-center gap-2.5 px-3 py-[5px] transition hover:bg-white/[0.04]"
              >
                {/* Clickable name area */}
                <button
                  onClick={() => openFile(file)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span className="w-4 shrink-0 text-center text-[12px] leading-none">
                    {fileIcon(file)}
                  </span>
                  <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${file.isDir ? 'text-slate-200' : 'text-slate-300'}`}>
                    {file.name}{file.isDir ? '/' : ''}
                  </span>
                </button>

                {/* Meta + actions */}
                {!file.isDir && (
                  <span className="shrink-0 text-[10px] text-slate-700 group-hover:text-slate-500">
                    {formatSize(file.size)}
                  </span>
                )}
                {!file.isDir && file.modified > 0 && (
                  <span className="shrink-0 text-[10px] text-slate-700 group-hover:text-slate-500 hidden sm:inline">
                    {formatDate(file.modified)}
                  </span>
                )}

                {/* Reveal in Finder */}
                {!file.isDir && (
                  <button
                    onClick={() => revealItemInDir(file.path)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 rounded p-0.5 text-slate-500 hover:text-slate-200 transition"
                    title="Show in Finder"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 9V10H10V9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      <path d="M6 1V7.5M6 7.5L4 5.5M6 7.5L8 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}

                {/* Delete — two-click confirm to avoid window.confirm() Tauri issues */}
                {confirmDelete === file.path ? (
                  <button
                    onClick={async () => {
                      setConfirmDelete(null);
                      try {
                        await deleteFile(file.path);
                        await load(currentPath);
                      } catch (err) {
                        setError(`Could not delete ${file.name}: ${err}`);
                      }
                    }}
                    onBlur={() => setConfirmDelete(null)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 border border-red-500/40 hover:bg-red-500/10 transition"
                    title="Confirm delete"
                    autoFocus
                  >
                    confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(file.path)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 rounded p-0.5 text-slate-500 hover:text-red-400 transition"
                    title="Delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 3h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      <path d="M5 3V2h2v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M4.5 3.5v5.5h3V3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-white/8 px-3 py-1.5">
        <span className="text-[10px] text-slate-700">
          {files.length > 0 ? `${files.length} item${files.length !== 1 ? 's' : ''}` : 'empty'}
        </span>
        <span className="text-[10px] text-slate-700">drag from Finder · click to view</span>
      </div>
    </div>
  );
}
