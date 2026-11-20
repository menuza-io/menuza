import './global.css'

import { Slot, useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { useCallback } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AppRoot } from '../components/shell/app-root'
import { PushLifecycle } from '../components/shell/push-lifecycle'
import { AppProvider } from '../lib/app/app-provider'

function PushTaps() {
	const router = useRouter()
	const navigate = useCallback(
		(target: { pathname: string; params: Record<string, string> }) =>
			router.push(target as never),
		[router],
	)
	const openUrl = useCallback((url: string) => {
		void WebBrowser.openBrowserAsync(url)
	}, [])
	return <PushLifecycle navigate={navigate} openUrl={openUrl} />
}

/**
 * One store for the app's lifetime. The signed-in tabs (`(tabs)/`) mount only
 * once the gate in `AppRoot` lets the customer through.
 */
export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<AppProvider>
				<AppRoot>
					<PushTaps />
					<Slot />
				</AppRoot>
			</AppProvider>
		</SafeAreaProvider>
	)
}
