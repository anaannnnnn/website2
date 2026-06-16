import { useState, useEffect } from 'react'
import { useTypewriter } from '../hooks/useTypewriter'

export default function Hero() {
  const { displayed, done } = useTypewriter(
    'Glad you stopped in. Good taste tends to find us. Now, what are we building?',
    { speed: 38, startDelay: 600 }
  )

  const [buttonsVisible, setButtonsVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setButtonsVisible(true)
    }, 400)
    return () => clearTimeout(timer)
  }, [])

  const handleCopyEmail = () => {
    navigator.clipboard.writeText('hello@mainframe.co')
  }

  return (
    <section className="relative z-1 h-screen flex flex-col md:justify-center justify-end px-5 sm:px-8 md:px-10 overflow-hidden pb-12 md:pb-0">
      <div className="max-w-xl relative z-10">
        {/* Blurred intro label */}
        <div className="pointer-events-none select-none mb-5 sm:mb-6" style={{ filter: 'blur(4px)' }}>
          <p
            className="text-black"
            style={{
              fontSize: 'clamp(18px, 4vw, 26px)',
              lineHeight: 1.3,
              fontWeight: 400,
            }}
          >
            Hey there, meet A.R.I.A,
            <br />
            Mainframe's Adaptive Response Interface Agent
          </p>
        </div>

        {/* Typewriter text */}
        <p
          className="text-black mb-5 sm:mb-6 min-h-[54px]"
          style={{
            fontSize: 'clamp(18px, 4vw, 26px)',
            lineHeight: 1.35,
            fontWeight: 400,
          }}
        >
          {displayed}
          {!done && (
            <span className="cursor inline-block w-[2px] h-[1.1em] bg-black align-middle ml-[2px]" />
          )}
        </p>

        {/* Action pill buttons */}
        <div
          className="flex flex-wrap gap-y-1"
          style={{
            opacity: buttonsVisible ? 1 : 0,
            transform: buttonsVisible ? 'translateY(0)' : 'translateY(8px)',
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          {/* White pill buttons */}
          {[
            'Pitch us an idea',
            'Come work here',
            'Send a brief hello',
            'See how we operate',
          ].map((label) => (
            <button
              key={label}
              className="inline-flex items-center justify-center bg-white text-black border border-black/10 rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-black hover:text-white transition-colors duration-200"
            >
              {label}
            </button>
          ))}

          {/* Outline pill button */}
          <button
            onClick={handleCopyEmail}
            className="inline-flex items-center justify-center gap-2 sm:gap-3 text-white bg-transparent border border-white rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap hover:bg-white hover:text-black transition-colors duration-200"
          >
            <span>
              Reach us:{' '}
              <span className="underline underline-offset-1">hello@mainframe.co</span>
            </span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="2" y="5" width="5" height="5" fill="currentColor" />
              <rect x="5" y="2" width="5" height="5" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}
