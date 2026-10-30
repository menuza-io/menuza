import './global.css'

import { Slot } from 'expo-router'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AppRoot } from '../components/shell/app-root'
import { AppProvider } from '../lib/app/app-provider'

/**
 * One store for the app's lifetime. The signed-in tabs (`(tabs)/`) mount only
 * once the gate in `AppRoot` lets the customer through.
 */
export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<AppProvider>
				<AppRoot>
					<Slot />
				</AppRoot>
			</AppProvider>
		</SafeAreaProvider>
	)
}
