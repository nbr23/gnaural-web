import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { lookaheadOverride } from './app/debug'
import { setLookaheadOverride } from './engine/engine'
import './index.css'
import App from './App.tsx'

// `?lookahead=<ms>`, diagnostic only — see src/app/debug.ts.
setLookaheadOverride(lookaheadOverride())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
