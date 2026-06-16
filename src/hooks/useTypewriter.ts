import { useState, useEffect } from 'react'

interface UseTypewriterOptions {
  speed?: number
  startDelay?: number
}

export function useTypewriter(text: string, options: UseTypewriterOptions = {}) {
  const { speed = 38, startDelay = 600 } = options
  const [displayed, setDisplayed] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    const delayTimer = setTimeout(() => {
      let charIndex = 0

      const interval = setInterval(() => {
        if (charIndex < text.length) {
          setDisplayed(text.substring(0, charIndex + 1))
          charIndex++
        } else {
          clearInterval(interval)
          setDone(true)
        }
      }, speed)

      return () => clearInterval(interval)
    }, startDelay)

    return () => clearTimeout(delayTimer)
  }, [text, speed, startDelay])

  return { displayed, done }
}
