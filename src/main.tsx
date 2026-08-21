import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { startMigrationPreflightSmokeBootstrap } from './lib/manuscriptMigrationPreflightSmokeBootstrap'

async function startApp() {
  if (await startMigrationPreflightSmokeBootstrap()) return
  const root = document.getElementById('root')
  if (!root) throw new Error('APP_ROOT_MISSING')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void startApp()
