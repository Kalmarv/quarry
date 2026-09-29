import { useEffect, useState } from "react";
import { api, type Ev } from "./api";
import { clock, dayLabel } from "./format";

export function Activity() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [problemsOnly, setProblemsOnly] = useState(false);

  useEffect(() => {
    const load = () => api.events().then(setEvents);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const shown = problemsOnly ? events.filter((e) => e.level !== "info") : events;
  const days: [string, Ev[]][] = [];
  for (const e of shown) {
    const label = dayLabel(e.ts);
    if (days.at(-1)?.[0] === label) days.at(-1)![1].push(e);
    else days.push([label, [e]]);
  }

  return (
    <main className="activity">
      <label className="filter">
        <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
        Only warnings and errors
      </label>
      {days.map(([label, evs]) => (
        <section key={label} className="day">
          <h2>{label}</h2>
          <ol className="history">
            {evs.map((e) => (
              <li key={e.id} className={`ev ev-${e.level}`}>
                <time dateTime={e.ts} title={e.ts + " UTC"}>
                  {clock(e.ts)}
                </time>
                <span>
                  {e.request_title && !e.message.includes(e.request_title) && (
                    <span className="ev-subject">{e.request_title}: </span>
                  )}
                  {e.message}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {shown.length === 0 && <p className="all-clear">No {problemsOnly ? "problems" : "activity"} logged.</p>}
    </main>
  );
}
