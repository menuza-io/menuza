import { I18nProvider } from '@lingui/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App.tsx'
import { i18n } from './i18n.ts'
import { requestPersistentStorage } from './lib/storage.ts'
import { setUpdater } from './lib/update.ts'
import './styles/app.css'

// Precache the app shell so the till opens with no network at all. A new version
// is fetched in the background and applied only when the till is idle.
const updateSW = registerSW({
	immediate: true,
	onNeedRefresh: () => setUpdater(() => void updateSW(true)),
})

// Ask the browser not to evict the order queue under storage pressure. A
// refusal is shown as a banner (see App) until it is granted.
void requestPersistentStorage()

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<I18nProvider i18n={i18n}>
			<App />
		</I18nProvider>
	</StrictMode>,
)
