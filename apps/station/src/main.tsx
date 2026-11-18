import { I18nProvider } from '@lingui/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App.tsx'
import { applyLocale, i18n } from './i18n.ts'
import { guestDisplayChannel } from './lib/guest-display.ts'
import { requestPersistentStorage } from './lib/storage.ts'
import { setUpdater } from './lib/update.ts'
import { GuestDisplay } from './screens/GuestDisplay.tsx'
import { TrainingShell } from './screens/TrainingBanner.tsx'
import './styles/app.css'
import './styles/kitchen-ticket.css'

// Precache the app shell so the till opens with no network at all. A new version
// is fetched in the background and applied only when the till is idle.
const updateSW = registerSW({
	immediate: true,
	onNeedRefresh: () => setUpdater(() => void updateSW(true)),
})

// Ask the browser not to evict the order queue under storage pressure. A
// refusal is shown as a banner (see App) until it is granted.
void requestPersistentStorage()

// The guest's second screen is this same app opened on another display with
// `?guest-display=<channel>`: it shows the till's order and holds none of its own.
const guestChannel = guestDisplayChannel(window.location.search)

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<I18nProvider i18n={i18n}>
			{guestChannel ? (
				<GuestDisplay channelName={guestChannel} onLocale={applyLocale} />
			) : (
				<TrainingShell>
					<App />
				</TrainingShell>
			)}
		</I18nProvider>
	</StrictMode>,
)
