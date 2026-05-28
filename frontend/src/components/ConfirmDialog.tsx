import { useEffect, useRef } from 'react'

interface Props {
  isOpen: boolean
  message: string
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  cancelLabel?: string
}

export default function ConfirmDialog({
  isOpen,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  return (
    <div className="confirm-backdrop" onMouseDown={onCancel}>
      <div className="confirm-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="btn btn--ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className="btn" ref={confirmRef} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
