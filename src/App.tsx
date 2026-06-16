import { useState, useEffect, useRef } from 'react'
import Navbar from './components/Navbar'
import Hero from './components/Hero'

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [targetTime, setTargetTime] = useState(0)
  const prevXRef = useRef(0)

  const SENSITIVITY = 0.8

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const currentX = e.clientX
      const delta = currentX - prevXRef.current
      prevXRef.current = currentX

      if (videoRef.current) {
        const timeOffset = (delta / window.innerWidth) * SENSITIVITY * videoRef.current.duration
        let newTime = videoRef.current.currentTime + timeOffset
        newTime = Math.max(0, Math.min(videoRef.current.duration, newTime))
        setTargetTime(newTime)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  useEffect(() => {
    if (videoRef.current && Math.abs(videoRef.current.currentTime - targetTime) > 0.1) {
      videoRef.current.currentTime = targetTime
    }
  }, [targetTime])

  return (
    <>
      <video
        ref={videoRef}
        src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260530_042513_df96a13b-6155-4f6e-8b93-c9dee66fba08.mp4"
        muted
        playsInline
        preload="auto"
        className="fixed inset-0 w-full h-full object-cover"
        style={{ objectPosition: '70% center', zIndex: 0 }}
      />
      <Navbar />
      <Hero />
    </>
  )
}

export default App
