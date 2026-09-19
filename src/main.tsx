import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, ErrorBoundary } from './App'
import './styles.css'
if ('serviceWorker' in navigator) window.addEventListener('load',()=>{
 if(import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js')
 else void navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).then(()=>caches.keys()).then(keys=>Promise.all(keys.filter(key=>key.startsWith('shine-jewels-')).map(key=>caches.delete(key))))
})
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

