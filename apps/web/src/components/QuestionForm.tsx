// Batched input-request form (PLNR-131, typed kinds PLNR-185) — AskUserQuestion-style:
// up to 4 questions, each select (pick one), multi (pick several), text (freeform),
// number, or confirm (yes/no); optioned questions also get an "other" free-text escape.
// Submits BOTH forms: the structured per-question answers (stored in response_json for
// agents) and the derived "Q → answer" text (what resume frames and old readers see).
import { useEffect, useState } from 'react';
import { api, type ApiSignalAnswer, type ApiSignalQuestion } from '../api';

interface Draft {
  picked: Set<string>;
  other: string;
}

/** Effective answer form: explicit kind wins; legacy multi → 'multi'; options → select; else text. */
const kindOf = (q: ApiSignalQuestion): NonNullable<ApiSignalQuestion['kind']> =>
  q.kind ?? (q.multi ? 'multi' : q.options?.length ? 'select' : 'text');

export function QuestionForm({ questions, onSubmit }: {
  questions: ApiSignalQuestion[];
  onSubmit: (response: string, answers: ApiSignalAnswer[]) => void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picked: new Set(), other: '' })));
  const patch = (i: number, fn: (d: Draft) => Draft) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? fn({ picked: new Set(d.picked), other: d.other }) : d)));

  const answerOf = (q: ApiSignalQuestion, d: Draft): ApiSignalAnswer['answer'] | null => {
    const kind = kindOf(q);
    if (kind === 'confirm') return d.picked.has('Yes') ? true : d.picked.has('No') ? false : null;
    if (kind === 'number') {
      if (!d.other.trim()) return null;
      const n = Number(d.other.trim());
      return Number.isFinite(n) ? n : null;
    }
    const parts = [...d.picked];
    if (d.other.trim()) parts.push(q.options?.length ? `other: ${d.other.trim()}` : d.other.trim());
    if (!parts.length) return null;
    return kind === 'multi' ? parts : parts.join(', ');
  };
  const complete = questions.every((q, i) => answerOf(q, drafts[i]!) !== null);

  const submit = () => {
    if (!complete) return;
    const answers: ApiSignalAnswer[] = questions.map((q, i) => ({ question: q.question, answer: answerOf(q, drafts[i]!)! }));
    const fmt = (a: ApiSignalAnswer['answer']) => Array.isArray(a) ? a.join(', ') : typeof a === 'boolean' ? (a ? 'yes' : 'no') : String(a);
    void onSubmit(answers.map((a) => `${a.question} → ${fmt(a.answer)}`).join('\n'), answers);
  };

  const optionButton = (i: number, q: ApiSignalQuestion, opt: string, exclusive: boolean) => {
    const d = drafts[i]!;
    const on = d.picked.has(opt);
    return (
      <button
        key={opt}
        onClick={() => patch(i, (dd) => {
          if (exclusive) dd.picked = new Set(on ? [] : [opt]);
          else if (on) dd.picked.delete(opt);
          else dd.picked.add(opt);
          return dd;
        })}
        style={{
          cursor: 'pointer', fontSize: 11.5, fontWeight: 500, borderRadius: 7, padding: '4px 10px',
          color: on ? '#0a0b0d' : 'var(--accent-ink)',
          background: on ? 'var(--accent)' : 'rgba(198,242,78,.08)',
          border: `1px solid ${on ? 'var(--accent)' : 'rgba(198,242,78,.35)'}`,
        }}
      >
        {!exclusive ? (on ? '☑ ' : '☐ ') : ''}{opt}
      </button>
    );
  };

  const KIND_HINT: Record<NonNullable<ApiSignalQuestion['kind']>, string | null> = {
    select: null, multi: 'pick any', text: null, number: 'number', confirm: null,
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {questions.map((q, i) => {
        const d = drafts[i]!;
        const kind = kindOf(q);
        const hasOptions = (kind === 'select' || kind === 'multi') && !!q.options?.length;
        return (
          <div key={i} style={{ border: '1px solid var(--w-07)', borderRadius: 8, padding: '8px 10px', background: 'var(--w-02)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6 }}>
              {q.header && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-faint)', border: '1px solid var(--w-1)', padding: '1px 5px', borderRadius: 4 }}>
                  {q.header}
                </span>
              )}
              <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{q.question}</span>
              {KIND_HINT[kind] && <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{KIND_HINT[kind]}</span>}
            </div>
            {hasOptions && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {q.options!.map((opt) => optionButton(i, q, opt, kind === 'select'))}
              </div>
            )}
            {kind === 'confirm' && (
              <div style={{ display: 'flex', gap: 5 }}>
                {['Yes', 'No'].map((opt) => optionButton(i, q, opt, true))}
              </div>
            )}
            {kind === 'number' ? (
              <input
                type="number"
                value={d.other}
                onChange={(e) => patch(i, (dd) => { dd.other = e.target.value; return dd; })}
                placeholder="0"
                style={{
                  width: 140, boxSizing: 'border-box', marginTop: 6,
                  background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 7,
                  padding: '5px 9px', color: 'var(--text)', fontSize: 12, outline: 'none', fontFamily: 'var(--mono)',
                }}
              />
            ) : kind !== 'confirm' && (
              <textarea
                value={d.other}
                onChange={(e) => patch(i, (dd) => { dd.other = e.target.value; return dd; })}
                placeholder={hasOptions ? 'other — type your own answer…' : 'your answer…'}
                rows={hasOptions ? 1 : 2}
                style={{
                  width: '100%', boxSizing: 'border-box', marginTop: 6, resize: 'vertical',
                  background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 7,
                  padding: '5px 9px', color: 'var(--text)', fontSize: 12, outline: 'none', fontFamily: 'inherit',
                }}
              />
            )}
          </div>
        );
      })}
      <button
        disabled={!complete}
        onClick={submit}
        style={{
          alignSelf: 'flex-end', cursor: complete ? 'pointer' : 'default', fontSize: 12, fontWeight: 600,
          color: '#0a0b0d', background: 'var(--accent)', border: 'none', borderRadius: 7,
          padding: '6px 14px', opacity: complete ? 1 : 0.4,
        }}
      >
        Answer {questions.length > 1 ? `all ${questions.length}` : ''}
      </button>
    </div>
  );
}

/** Prior rounds of a threaded gate (PLNR-185): compact Q&A history above the open form. */
export function SignalThreadHistory({ pid, signalId }: { pid: string; signalId: string }) {
  const [rounds, setRounds] = useState<Array<{ id: string; title: string; response: string | null }> | null>(null);
  useEffect(() => {
    api.signalThread(pid, signalId)
      .then((r) => setRounds(r.thread.filter((s) => s.id !== signalId && s.status === 'answered')
        .map((s) => ({ id: s.id, title: s.title, response: s.response }))))
      .catch(() => setRounds([]));
  }, [pid, signalId]);
  if (!rounds?.length) return null;
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rounds.map((r) => (
        <div key={r.id} style={{ fontSize: 11, color: 'var(--text-dim)', borderLeft: '2px solid var(--w-1)', paddingLeft: 8, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 600 }}>{r.title}</span>
          {r.response && <span> → {r.response.length > 160 ? `${r.response.slice(0, 160)}…` : r.response}</span>}
        </div>
      ))}
    </div>
  );
}
