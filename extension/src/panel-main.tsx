import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PanelApp } from './PanelApp'
import './panel.css'
import './panel-compose.css'
import './panel-inbox.css'

document.documentElement.classList.toggle('is-embedded', window.top !== window)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
)
