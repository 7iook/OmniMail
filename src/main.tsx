import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './styles/auth-landing.css'
import './styles/admin-workspace.css'
import './styles/statistics.css'
import './styles/audit-logs.css'
import './styles/mailbox.css'
import './styles/mailbox-switcher.css'
import './styles/quick-mailbox.css'
import './styles/message.css'
import './styles/responsive.css'
import './styles/user-policy-panel.css'
import './styles/user-management.css'
import './styles/account-settings.css'
import './styles/domain-management.css'
import './styles/temporary-invites.css'
import './styles/temporary-invite-page.css'
import './styles/system-settings.css'
import './styles/deployment-wizard.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
