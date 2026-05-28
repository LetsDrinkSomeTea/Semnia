import { useState, useRef, createElement } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

export function useConfirm() {
  const [isOpen, setIsOpen] = useState(false)
  const [message, setMessage] = useState('')
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const ask = (msg: string): Promise<boolean> => {
    setMessage(msg)
    setIsOpen(true)
    return new Promise((resolve) => { resolverRef.current = resolve })
  }

  const handleConfirm = () => {
    setIsOpen(false)
    resolverRef.current?.(true)
  }

  const handleCancel = () => {
    setIsOpen(false)
    resolverRef.current?.(false)
  }

  const confirmDialog = createElement(ConfirmDialog, {
    isOpen,
    message,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  })

  return { confirmDialog, ask }
}
