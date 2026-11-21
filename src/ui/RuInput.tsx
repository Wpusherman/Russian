import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { applyAccentKey } from '../core/accent';
import { translit, translitLive } from '../core/translit';

export type InputMode = 'translit' | 'os';

const ROWS = ['йцукенгшщзхъ', 'фывапролджэё', 'ячсмитьбю'];

export function ScreenKeyboard({ onKey, onBackspace }: { onKey: (ch: string) => void; onBackspace: () => void }): ReactNode {
  const [shift, setShift] = useState(false);
  const press = (ch: string) => {
    onKey(shift ? ch.toUpperCase() : ch);
    setShift(false);
  };
  return (
    <div className="kbd" onMouseDown={(e) => e.preventDefault()}>
      {ROWS.map((row, i) => (
        <div className="kbd-row" key={row}>
          {i === 2 && <button type="button" tabIndex={-1} className={shift ? 'key wide on' : 'key wide'} onClick={() => setShift((s) => !s)}>⇧</button>}
          {[...row].map((ch) => (
            <button type="button" tabIndex={-1} className="key" key={ch} onClick={() => press(ch)}>{shift ? ch.toUpperCase() : ch}</button>
          ))}
          {i === 2 && <button type="button" tabIndex={-1} className="key wide" onClick={onBackspace}>⌫</button>}
        </div>
      ))}
      <div className="kbd-row">
        <button type="button" tabIndex={-1} className="key" onClick={() => press('-')}>-</button>
        <button type="button" tabIndex={-1} className="key space" onClick={() => press(' ')}>space</button>
        <button type="button" tabIndex={-1} className="key" onClick={() => press(',')}>,</button>
      </div>
    </div>
  );
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** Called with the finalized (fully converted) text. */
  onEnter?: (finalValue: string) => void;
  defaultMode: InputMode;
  showKeyboardDefault?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** B3: character ranges of `value` to underline (live spelling warnings). */
  violations?: (text: string) => { start: number; end: number }[];
};

/** Split a (partly converted) value into its Cyrillic part and the pending Latin tail. */
function splitPending(value: string, mode: InputMode): { done: string; pending: string } {
  if (mode === 'os') return { done: value, pending: '' };
  const m = /[A-Za-z'#]+$/.exec(value);
  return m ? { done: value.slice(0, m.index), pending: m[0] } : { done: value, pending: '' };
}

/**
 * Russian text input. Translit mode converts Latin letters as they are typed; the trailing token
 * that may still grow (e.g. "s" -> "sh") stays Latin and is underlined. Alt+T toggles the mode.
 */
export function RuInput(props: Props): ReactNode {
  const { value, onChange, onEnter, disabled } = props;
  const [mode, setMode] = useState<InputMode>(props.defaultMode);
  const [showKbd, setShowKbd] = useState(props.showKeyboardDefault ?? false);
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  useEffect(() => {
    if (props.autoFocus && !disabled) ref.current?.focus();
  }, [props.autoFocus, disabled]);

  useEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const apply = (raw: string, pos: number) => {
    if (mode === 'os') {
      onChange(applyAccentKey(raw));
      return;
    }
    const live = translitLive(raw.slice(0, pos));
    const before = live.done + live.pending;
    caret.current = before.length;
    onChange(applyAccentKey(before + raw.slice(pos)));
  };

  const insert = (ch: string) => {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const next = value.slice(0, s) + ch + value.slice(e);
    caret.current = s + ch.length;
    onChange(next);
    el?.focus();
  };
  const backspace = () => {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    if (s === e && s === 0) return;
    const from = s === e ? s - 1 : s;
    caret.current = from;
    onChange(value.slice(0, from) + value.slice(e));
    el?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      setMode((m) => (m === 'translit' ? 'os' : 'translit'));
      return;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      const final = mode === 'translit' ? translit(value) : value;
      if (final !== value) onChange(final);
      onEnter?.(final);
    }
  };

  const { done, pending } = splitPending(value, mode);
  const marks = props.violations?.(done) ?? [];
  const mirror: ReactNode[] = [];
  let markPos = 0;
  marks.forEach((m, i) => {
    if (m.start > markPos) mirror.push(<span key={`t${i}`}>{done.slice(markPos, m.start)}</span>);
    mirror.push(<span key={`m${i}`} className="spell-bad">{done.slice(m.start, m.end)}</span>);
    markPos = Math.max(markPos, m.end);
  });
  if (markPos < done.length) mirror.push(<span key="tail">{done.slice(markPos)}</span>);
  return (
    <div className="ru-input">
      <div className="ru-input-field">
        <div className="ru-input-mirror" aria-hidden="true">
          {marks.length > 0 ? <>{mirror}</> : <span>{done}</span>}
          <span className="pending">{pending}</span>
        </div>
        <input
          ref={ref}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={props.placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          lang="ru"
          onChange={(e) => apply(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="ru-input-tools">
        <button type="button" tabIndex={-1} className="ghost small" onClick={() => setMode((m) => (m === 'translit' ? 'os' : 'translit'))}
          title="Alt+T で切り替え">
          入力：{mode === 'translit' ? 'Translit（ローマ字→キリル）' : 'OSキーボード'} <kbd>Alt+T</kbd>
        </button>
        <button type="button" tabIndex={-1} className="ghost small" onClick={() => setShowKbd((s) => !s)}>
          画面キーボード {showKbd ? '▲' : '▼'}
        </button>
      </div>
      {showKbd && !disabled && <ScreenKeyboard onKey={insert} onBackspace={backspace} />}
    </div>
  );
}
