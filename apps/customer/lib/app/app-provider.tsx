import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from 'react'
import { type TenantConfiguration } from '../config/configuration'
import { type AppStore } from '../state/app-store'
import { createAppStore } from './create-app-store'
import { type AppFeatures } from './features'

const AppStoreContext = createContext<AppStore<AppFeatures> | null>(null)

/**
 * Owns the one AppStore for the app's lifetime. `store`/`configuration` are
 * read once, on mount (tests pass their own; the app uses the build's).
 */
export function AppProvider(props: {
	store?: AppStore<AppFeatures>
	configuration?: TenantConfiguration
	children: ReactNode
}) {
	const [store] = useState(
		() =>
			props.store ??
			createAppStore(
				props.configuration ? { configuration: props.configuration } : {},
			),
	)
	useEffect(() => {
		void store.start()
		return () => store.dispose()
	}, [store])
	return (
		<AppStoreContext.Provider value={store}>
			{props.children}
		</AppStoreContext.Provider>
	)
}

export function useAppStoreContext(): AppStore<AppFeatures> | null {
	return useContext(AppStoreContext)
}
