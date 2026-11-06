"use client";

import { useEffect, useState } from "react";
import { Eye, Download } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { useFileBusStore } from "@/shared/stores/fileBusStore";

// Mirrors FILE_LIMIT_BOUNDS_MB on the host, which is the one that actually enforces it.
const MIN_MB = 1;
const MAX_MB = 102400;

const FIELDS = [
  { key: "maxPreviewMB", icon: Eye, labelKey: "menu.fileLimitsPreview", hintKey: "menu.fileLimitsPreviewHint" },
  { key: "maxDownloadMB", icon: Download, labelKey: "menu.fileLimitsDownload", hintKey: "menu.fileLimitsDownloadHint" }
];

// Size caps for file preview and download. Stored on the host (settings.json), so
// they follow the machine, not this browser.
export default function FileLimitsSettings({ connected }) {
  const { t } = useI18n();
  const fileBus = useFileBusStore();
  const [saved, setSaved] = useState(null); // last values the host confirmed
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState(null); // { key, ok, message }

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    fileBus.getFileLimits().then((res) => {
      if (!alive) return;
      if (!res?.success) { setStatus({ ok: false, message: res?.error || "Failed to load" }); return; }
      setSaved(res.limits);
      setDraft(Object.fromEntries(Object.entries(res.limits).map(([k, v]) => [k, String(v)])));
    });
    return () => { alive = false; };
  }, [connected, fileBus]);

  const commit = async (key) => {
    const n = Number(draft[key]);
    if (!Number.isInteger(n) || n < MIN_MB || n > MAX_MB) {
      setDraft((d) => ({ ...d, [key]: String(saved[key]) }));
      setStatus({ key, ok: false, message: `${MIN_MB}–${MAX_MB} MB` });
      return;
    }
    if (n === saved[key]) return;
    const res = await fileBus.setFileLimits({ [key]: n });
    if (!res?.success) {
      setDraft((d) => ({ ...d, [key]: String(saved[key]) }));
      setStatus({ key, ok: false, message: res?.error || "Failed to save" });
      return;
    }
    setSaved(res.limits);
    setStatus({ key, ok: true, message: t("menu.fileLimitsSaved") });
  };

  const ready = connected && saved;

  return (
    <div className="space-y-1">
      {FIELDS.map(({ key, icon: FieldIcon, labelKey, hintKey }) => (
        <div key={key} className="w-full px-3 py-2 rounded-brand flex items-center gap-2.5 text-sm text-text">
          <FieldIcon size={16} className="text-brand-500 dark:text-white flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="block truncate">{t(labelKey)}</span>
            <span className="block text-xs text-text-muted">{t(hintKey)}</span>
            {status?.key === key && (
              <span className={`block text-xs ${status.ok ? "text-text-muted" : "text-danger"}`}>{status.message}</span>
            )}
          </div>
          <input
            type="number"
            min={MIN_MB}
            max={MAX_MB}
            step={1}
            disabled={!ready}
            value={draft[key] ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            onBlur={() => commit(key)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="w-24 bg-surface-2 text-text text-sm rounded-brand px-2 py-1 text-right focus:outline-none disabled:opacity-60"
          />
          <span className="text-xs text-text-muted w-6">MB</span>
        </div>
      ))}
    </div>
  );
}
