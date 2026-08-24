import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipLayer } from './components/TooltipLayer'
import './styles.css'
import './styles/splash.css'
import './styles/language.css'
import './styles/tooltip.css'
import './styles/auth-landing.css'
import './styles/mailbox.css'
import './styles/mailbox-header.css'
import './styles/message-list-motion.css'
import './styles/bulk-actions.css'
import './styles/mailbox-switcher.css'
import './styles/managed-mailbox-actions.css'
import './styles/mailbox-switcher-feedback.css'
import './styles/mailbox-address-option.css'
import './styles/quick-mailbox.css'
import './styles/message.css'
import './styles/reply-attachments.css'
import './styles/email-frame-transition.css'
import './styles/message-scrollbar.css'
import './styles/message-scroll-top.css'
import './styles/message-translation.css'
import './styles/message-retry.css'
import './styles/external-link-dialog.css'
import './styles/attachment-preview.css'
import './styles/mail-delete-dialog.css'
import './styles/compose-dialog.css'
import './styles/draft-inline-editor.css'
import './styles/draft-list.css'
import './styles/responsive.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <TooltipLayer />
  </StrictMode>,
)
