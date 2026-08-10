import { useState } from 'react';
import type { AppStore } from '../store';
import { MIN_INPUT_FONT_SIZE, MIN_TOUCH_TARGET } from '../viewport';
import { Markdown } from './Markdown';
import { MonoTag } from './bits';
import { QuestionForm, SignalThreadHistory } from './QuestionForm';
import { Sheet } from './Sheet';

const SEVERITY_COLOR: Record<string, string> = { critical: 'var(--red-soft)', warning: 'var(--amber)', info: 'var(--blue)' };

export function DecisionsSheet({ store, onClose }: { store: AppStore; onClose: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const signals = store.snapshot?.signals ?? [];
  if (!signals.length) return null;

  return (
    <Sheet title="Needs attention" subtitle={`${signals.length} waiting`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {signals.map((signal) => {
          const decision = signal.type === 'input_request';
          const accent = decision ? 'var(--accent)' : SEVERITY_COLOR[signal.severity] ?? 'var(--blue)';
          const answer = answers[signal.id] ?? '';
          return (
            <article key={signal.id} style={{ border: `1px solid ${accent}44`, borderLeft: `3px solid ${accent}`, borderRadius: 12, background: 'var(--card)', padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <MonoTag color={accent} bg={`${accent}1a`} size={9}>{decision ? 'DECISION' : signal.severity.toUpperCase()}</MonoTag>
                {signal.taskKey && (
                  <button type="button" onClick={() => signal.taskId && store.actions.openTask(signal.taskId)} style={{ minHeight: MIN_TOUCH_TARGET, cursor: 'pointer', color: 'var(--text-mid)', fontFamily: 'var(--mono)', fontSize: 10, padding: 0 }}>
                    {signal.taskKey}
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{signal.agentName}</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 650, lineHeight: 1.45 }}>{signal.title}</div>
              {signal.body && <div style={{ fontSize: 12.5, color: 'var(--text-mid)', marginTop: 5, lineHeight: 1.55 }}><Markdown source={signal.body} compact /></div>}
              {decision && signal.followUpTo && <SignalThreadHistory pid={store.currentPid} signalId={signal.id} />}
              {decision && signal.questions?.length ? (
                <QuestionForm touch questions={signal.questions} onSubmit={(response, structured) => store.actions.answerSignal(signal.id, response, structured)} />
              ) : decision ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {signal.options?.map((option) => (
                    <button
                      type="button"
                      key={option}
                      onClick={() => void store.actions.answerSignal(signal.id, option)}
                      style={{ width: '100%', minHeight: MIN_TOUCH_TARGET, padding: '8px 12px', cursor: 'pointer', textAlign: 'left', borderRadius: 9, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.08)', border: '1px solid rgba(198,242,78,.35)', fontSize: 13, fontWeight: 550 }}
                    >
                      {option}
                    </button>
                  ))}
                  <div style={{ display: 'flex', gap: 7 }}>
                    <input
                      value={answer}
                      onChange={(event) => setAnswers((current) => ({ ...current, [signal.id]: event.target.value }))}
                      onKeyDown={(event) => { if (event.key === 'Enter' && answer.trim()) void store.actions.answerSignal(signal.id, answer); }}
                      placeholder={signal.options?.length ? 'or type a decision…' : 'your decision…'}
                      style={{ minWidth: 0, flex: 1, minHeight: MIN_TOUCH_TARGET, boxSizing: 'border-box', padding: '0 11px', borderRadius: 9, background: 'var(--w-03)', border: '1px solid var(--w-1)', color: 'var(--text)', fontSize: MIN_INPUT_FONT_SIZE }}
                    />
                    <button type="button" disabled={!answer.trim()} onClick={() => void store.actions.answerSignal(signal.id, answer)} style={{ minWidth: 78, minHeight: MIN_TOUCH_TARGET, padding: '0 12px', cursor: answer.trim() ? 'pointer' : 'default', borderRadius: 9, background: 'var(--accent)', color: 'var(--bg)', opacity: answer.trim() ? 1 : .4, fontWeight: 650 }}>
                      Answer
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
                  <button type="button" onClick={() => void store.actions.acknowledgeSignal(signal.id)} style={{ width: '100%', minHeight: MIN_TOUCH_TARGET, cursor: 'pointer', borderRadius: 9, background: 'var(--w-04)', border: '1px solid var(--w-1)', color: 'var(--text-soft)', fontSize: 13 }}>Acknowledge</button>
                  <button type="button" onClick={() => void store.actions.acknowledgeSignal(signal.id, true)} style={{ alignSelf: 'center', minHeight: MIN_TOUCH_TARGET, padding: '0 14px', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 11 }}>dismiss</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </Sheet>
  );
}
