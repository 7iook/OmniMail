import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PanelApp } from './PanelApp'
import './panel.css'
import './panel-inbox.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
)
