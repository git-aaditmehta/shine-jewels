import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, ErrorBoundary } from './App'
import './styles.css'
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
        reg.update()
      })
      let refreshing = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true
          window.location.reload()
        }
      })
    } else {
      void navigator.serviceWorker.getRegistrations()
        .then(regs => Promise.all(regs.map(r => r.unregister())))
        .then(() => caches.keys())
        .then(keys => Promise.all(keys.filter(k => k.startsWith('shine-jewels-')).map(k => caches.delete(k))))
    }
  })
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

