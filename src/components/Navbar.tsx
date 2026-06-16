import { useState } from 'react'

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-10 px-5 sm:px-8 py-4 sm:py-5 flex justify-between items-center">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <span className="text-[21px] sm:text-[26px] tracking-tight text-black font-medium" style={{ fontFamily: 'var(--font-heading)' }}>
            Mainframe®
          </span>
          <span className="text-[25px] sm:text-[30px] text-black select-none" style={{ letterSpacing: '-0.02em' }}>
            ✳︎
          </span>
        </div>

        {/* Desktop Nav Links */}
        <div className="hidden md:flex text-[23px] text-black gap-0">
          <a href="#" className="hover:opacity-60 transition-opacity">Labs</a>
          <span className="mx-2">,</span>
          <a href="#" className="hover:opacity-60 transition-opacity">Studio</a>
          <span className="mx-2">,</span>
          <a href="#" className="hover:opacity-60 transition-opacity">Openings</a>
          <span className="mx-2">,</span>
          <a href="#" className="hover:opacity-60 transition-opacity">Shop</a>
        </div>

        {/* Desktop CTA */}
        <a href="#" className="hidden md:block text-[23px] text-black underline underline-offset-2 hover:opacity-60 transition-opacity">
          Get in touch
        </a>

        {/* Mobile Hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden flex flex-col gap-[5px]"
          aria-label="Toggle menu"
        >
          <div
            className="w-6 h-[2px] bg-black transition-all duration-300"
            style={{
              transform: menuOpen ? 'rotate(45deg) translateY(7px)' : 'none',
            }}
          />
          <div
            className="w-6 h-[2px] bg-black transition-all duration-300"
            style={{
              opacity: menuOpen ? 0 : 1,
            }}
          />
          <div
            className="w-6 h-[2px] bg-black transition-all duration-300"
            style={{
              transform: menuOpen ? 'rotate(-45deg) translateY(-7px)' : 'none',
            }}
          />
        </button>
      </nav>

      {/* Mobile Overlay Menu */}
      <div
        className="fixed inset-0 bg-white/95 backdrop-blur-sm md:hidden flex flex-col items-start justify-center px-8 gap-8 z-9"
        style={{
          opacity: menuOpen ? 1 : 0,
          pointerEvents: menuOpen ? 'auto' : 'none',
          transition: 'opacity 0.3s',
        }}
      >
        <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">Labs</a>
        <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">Studio</a>
        <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">Openings</a>
        <a href="#" className="text-[32px] font-medium text-black hover:opacity-60 transition-opacity">Shop</a>
        <a href="#" className="text-[32px] font-medium text-black underline underline-offset-2 hover:opacity-60 transition-opacity">Get in touch</a>
      </div>
    </>
  )
}
