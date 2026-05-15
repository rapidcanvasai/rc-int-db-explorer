import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ConfirmDangerModalProps {
  open: boolean;
  title: string;
  /** Plain-text summary shown above the SQL preview. */
  description: string;
  /** SQL the backend will execute. Rendered inside a code block. */
  sqlPreview?: string;
  /** Phrase the user must type verbatim to enable the confirm button. */
  confirmPhrase?: string;
  confirmLabel?: string;
  isBusy?: boolean;
  errorText?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDangerModal({
  open,
  title,
  description,
  sqlPreview,
  confirmPhrase,
  confirmLabel = 'Run destructive query',
  isBusy = false,
  errorText = null,
  onConfirm,
  onCancel,
}: ConfirmDangerModalProps) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isBusy, onCancel]);

  if (!open) return null;

  const phraseRequired = !!confirmPhrase;
  const phraseOk = !phraseRequired || typed.trim() === confirmPhrase;
  const canConfirm = phraseOk && !isBusy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-danger-title"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !isBusy) onCancel();
      }}
    >
      <div className="bg-background text-foreground border border-destructive/40 rounded-md shadow-xl w-full max-w-lg overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3 border-b border-destructive/30 bg-destructive/10">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <h2 id="confirm-danger-title" className="text-sm font-semibold text-destructive">
              {title}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              This action is destructive and cannot be undone.
            </p>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p className="text-xs leading-relaxed">{description}</p>

          {sqlPreview && (
            <pre className="text-[11px] font-mono bg-muted/60 border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words">
              {sqlPreview}
            </pre>
          )}

          {phraseRequired && (
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground block">
                Type <span className="font-mono font-semibold text-destructive">{confirmPhrase}</span> to confirm:
              </label>
              <Input
                ref={inputRef}
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={confirmPhrase}
                className="h-8 text-xs font-mono"
                disabled={isBusy}
                autoComplete="off"
              />
            </div>
          )}

          {errorText && (
            <div className="text-xs text-destructive font-mono break-words">
              {errorText}
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t bg-muted/30 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isBusy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
