// Designs Lucian's printed poem cards as images (PNG) — dark purple, gold glow, elegant serif lettering.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
let fonts = null
function loadFonts() {
  if (fonts) return fonts
  const dir = path.dirname(require.resolve('@expo-google-fonts/cormorant-garamond/package.json'))
  fonts = ['CormorantGaramond_500Medium.ttf', 'CormorantGaramond_500Medium_Italic.ttf', 'CormorantGaramond_600SemiBold.ttf']
    .map((f) => path.join(dir, f))
    .filter((f) => { try { readFileSync(f); return true } catch { return false } })
  return fonts
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rough line wrapping (Cormorant is narrow: ~0.42 × font size per character)
function wrap(text, maxChars) {
  const out = []
  for (const para of String(text || '').split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars && line) { out.push(line); line = word }
      else line = (line + ' ' + word).trim()
    }
    if (line) out.push(line)
  }
  return out
}

// Fit the poem into the card: try sizes until it fits
function layout(poem, w, h) {
  const top = h * 0.3, bottom = h * 0.15
  for (let size = Math.round(h * 0.068); size >= Math.round(h * 0.022); size -= 2) {
    const maxChars = Math.floor((w * 0.78) / (size * 0.36))
    const lines = wrap(poem, maxChars)
    const lineH = size * 1.32
    if (lines.length * lineH <= h - top - bottom) return { size, lines, lineH, top }
  }
  const size = Math.round(h * 0.022)
  return { size, lines: wrap(poem, Math.floor((w * 0.78) / (size * 0.42))), lineH: size * 1.3, top }
}

export function cardSvg({ title, poem, signoff = 'Forever yours, Lucian' }, w = 2175, h = 1575) {
  const { size, lines, lineH, top } = layout(poem, w, h)
  const blockH = lines.length * lineH
  const startY = top + Math.max(0, (h * 0.84 - top - blockH) / 2) + size * 0.8
  const cx = w / 2
  const titleSize = Math.round(h * 0.075)
  const stars = Array.from({ length: 70 }, (_, i) => {
    const x = (i * 9301 + 49297) % 233280 / 233280 * w
    const y = (i * 4703 + 12345) % 233280 / 233280 * h
    const r = 1 + ((i * 7) % 3)
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r}" fill="#f3e6ff" opacity="${(0.15 + (i % 5) * 0.08).toFixed(2)}"/>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#3a1d5c"/>
      <stop offset="55%" stop-color="#1a0d2b"/>
      <stop offset="100%" stop-color="#0b0812"/>
    </radialGradient>
    <radialGradient id="orb" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f6ecff" stop-opacity="0.95"/>
      <stop offset="35%" stop-color="#c4a5ff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${stars}
  <circle cx="${cx}" cy="${h * 0.115}" r="${h * 0.05}" fill="url(#orb)"/>
  <rect x="${w * 0.04}" y="${h * 0.05}" width="${w * 0.92}" height="${h * 0.9}" rx="18" fill="none" stroke="#d9b86a" stroke-opacity="0.55" stroke-width="3"/>
  <text x="${cx}" y="${h * 0.25}" text-anchor="middle" font-family="Cormorant Garamond" font-weight="600" font-size="${titleSize}" fill="#e9cf8f">${esc(title)}</text>
  ${lines.map((l, i) => `<text x="${cx}" y="${(startY + i * lineH).toFixed(1)}" text-anchor="middle" font-family="Cormorant Garamond" font-weight="500" font-style="italic" font-size="${size}" fill="#f1e8ff">${esc(l)}</text>`).join('\n  ')}
  <text x="${cx}" y="${h * 0.9}" text-anchor="middle" font-family="Cormorant Garamond" font-weight="500" font-style="italic" font-size="${Math.round(h * 0.045)}" fill="#d9b86a">${esc(signoff)}</text>
</svg>`
}

export function cardPng(design, w, h) {
  const svg = cardSvg(design, w, h)
  const r = new Resvg(svg, {
    font: { fontFiles: loadFonts(), loadSystemFonts: false, defaultFontFamily: 'Cormorant Garamond' },
    fitTo: { mode: 'original' },
  })
  return r.render().asPng()
}
