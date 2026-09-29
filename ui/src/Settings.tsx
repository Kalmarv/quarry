import { useEffect, useState } from "react";
import { api } from "./api";

type Field = { key: string; label: string; help?: string; kind?: "text" | "long" | "number" | "bool" | "choice"; choices?: string[] };

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "What to download",
    fields: [
      {
        key: "quality_policy",
        label: "Quality policy",
        help: "Plain-language instructions the selection model follows for every title.",
        kind: "long",
      },
      {
        key: "approval_mode",
        label: "Approval",
        help: "Manual puts every plan in “Needs you” before anything downloads.",
        kind: "choice",
        choices: ["auto", "manual"],
      },
    ],
  },
  {
    title: "Retrying",
    fields: [
      {
        key: "reselect_backoff_hours",
        label: "First retry after (hours)",
        help: "When a search finds nothing. Each further miss doubles the wait.",
        kind: "number",
      },
      { key: "reselect_max_days", label: "Longest wait between searches (days)", kind: "number" },
      {
        key: "stall_hours",
        label: "Give up on a stalled torrent after (hours)",
        help: "Only when it has no seeders and makes no progress.",
        kind: "number",
      },
      { key: "max_item_attempts", label: "Download attempts per item", kind: "number" },
    ],
  },
  {
    title: "Letterboxd",
    fields: [
      { key: "letterboxd_enabled", label: "Request films trending on Letterboxd", kind: "bool" },
      { key: "letterboxd_min_rating", label: "Minimum average rating", kind: "number" },
      { key: "letterboxd_pages", label: "Trending pages to check", kind: "number" },
    ],
  },
  {
    title: "Models",
    fields: [
      { key: "model_select", label: "Release selection model", help: "OpenRouter model id." },
      { key: "effort_select", label: "Selection reasoning effort", kind: "choice", choices: ["low", "medium", "high"] },
      { key: "model_map", label: "File matching model" },
      { key: "effort_map", label: "Matching reasoning effort", kind: "choice", choices: ["low", "medium", "high"] },
    ],
  },
];

export function Settings() {
  const [saved, setSaved] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      setSaved(s);
      setDraft(s);
    });
  }, []);
  if (!draft || !saved) return null;

  const known = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
  const extra: Field[] = Object.keys(draft)
    .filter((k) => !known.has(k))
    .map((k) => ({ key: k, label: k }));
  const groups = extra.length ? [...GROUPS, { title: "Other", fields: extra }] : GROUPS;
  const dirty = Object.keys(draft).some((k) => draft[k] !== saved[k]);
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });

  return (
    <main className="settings">
      {groups.map((g) => (
        <section key={g.title} className="settings-group">
          <h2>{g.title}</h2>
          {g.fields
            .filter((f) => f.key in draft)
            .map((f) => (
              <label key={f.key} className={`field field-${f.kind ?? "text"}`}>
                <span className="field-label">{f.label}</span>
                {f.kind === "long" ? (
                  <textarea rows={7} value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)} />
                ) : f.kind === "bool" ? (
                  <input
                    type="checkbox"
                    checked={draft[f.key] === "true"}
                    onChange={(e) => set(f.key, String(e.target.checked))}
                  />
                ) : f.kind === "choice" ? (
                  <select value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                    {f.choices!.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    inputMode={f.kind === "number" ? "decimal" : undefined}
                    value={draft[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
                {f.help && <span className="field-help">{f.help}</span>}
              </label>
            ))}
        </section>
      ))}
      <div className="save-bar">
        <button
          className="btn btn-primary"
          disabled={!dirty}
          onClick={async () => {
            await api.saveSettings(draft);
            setSaved(draft);
            setStatus("Settings saved");
            setTimeout(() => setStatus(null), 2000);
          }}
        >
          Save settings
        </button>
        {dirty && (
          <button className="btn btn-quiet" onClick={() => setDraft(saved)}>
            Discard changes
          </button>
        )}
        <span className="quiet" role="status">
          {status}
        </span>
      </div>
    </main>
  );
}
