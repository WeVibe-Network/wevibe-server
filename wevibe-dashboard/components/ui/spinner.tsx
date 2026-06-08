'use client'

import { useEffect, useState } from 'react'

export const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

type SpinnerProps = {
  text?: string
  className?: string
}

export default function Spinner({ text, className }: SpinnerProps) {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % DOTS_FRAMES.length)
    }, 80)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  return (
    <span className={['inline-flex items-center gap-2 font-mono', className].filter(Boolean).join(' ')}>
      <span className="text-wv-violet">{DOTS_FRAMES[frameIndex]}</span>
      {text ? <span className="text-wv-text">{text}</span> : null}
    </span>
  )
}
