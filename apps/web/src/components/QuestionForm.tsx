// Batched input-request form (PLNR-131) — AskUserQuestion-style: up to 4 questions,
// each radio (pick one), multi (pick several), or freeform (no options), and every
// optioned question also gets an "other" free-text escape. The whole batch submits as
// ONE formatted string ("Q → answer" per line): that is what the agent (and the
// Runner's resume frame) reads, so structure lives in the form, not the wire.
import { useState } from 'react';
import type { ApiSignalQuestion } from '../api';

interface Draft {
  picked: Set<string>;
  other: string;
}

export function QuestionForm({ questions, onSubmit }: {
  questions: ApiSignalQuestion[];
  onSubmit: (response: string) => void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picked: new Set(), other: '' })));
  const patch = (i: number, fn: (d: Draft) => Draft) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? fn({ picked: new Set(d.picked), other: d.other }) : d)));

  const answerOf = (q: ApiSignalQuestion, d: Draft): string | null => {
    const parts = [...d.picked];
    if (d.other.trim()) parts.push(q.options?.length ? `other: ${d.other.trim()}` : d.other.trim());
    return parts.length ? parts.join(', ') : null;
  };
  const complete = questions.every((q, i) => answerOf(q, drafts[i]!) !== null);

  const submit = () => {
    if (!complete) return;
    void onSubmit(questions.map((q, i) => `${q.question} → ${answerOf(q, drafts[i]!)}`).join('\n'));
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {questions.map((q, i) => {
        const d = drafts[i]!;
        const hasOptions = !!q.options?.length;
        return (
          <div key={i} style={{ border: '1px solid var(--w-07)', borderRadius: 8, padding: '8px 10px', background: 'var(--w-02)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6 }}>
              {q.header && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-faint)', border: '1px solid var(--w-1)', padding: '1px 5px', borderRadius: 4 }}>
                  {q.header}
                </span>
              )}
              <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{q.question}</span>
              {q.multi && <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>pick any</span>}
            </div>
            {hasOptions && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {q.options!.map((opt) => {
                  const on = d.picked.has(opt);
                  return (
                    <button
                      key={opt}
                      onClick={() => patch(i, (dd) => {
                        if (q.multi) { on ? dd.picked.delete(opt) : dd.picked.add(opt); }
                        else { dd.picked = new Set(on ? [] : [opt]); }
                        return dd;
                      })}
                      style={{
                        cursor: 'pointer', fontSize: 11.5, fontWeight: 500, borderRadius: 7, padding: '4px 10px',
                        color: on ? '#0a0b0d' : 'var(--accent-ink)',
                        background: on ? 'var(--accent)' : 'rgba(198,242,78,.08)',
                        border: `1px solid ${on ? 'var(--accent)' : 'rgba(198,242,78,.35)'}`,
                      }}
                    >
                      {q.multi ? (on ? '☑ ' : '☐ ') : ''}{opt}
                    </button>
                  );
                })}
              </div>
            )}
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
