import { I18nProvider, useLingui } from '@lingui/react'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import {
	createScopeWordingI18n,
	type ScopeLabel,
	type ScopeWording,
} from '#app/utils/staffing/scope-wording.ts'

const ScopeWordingContext = createContext<ScopeWording>('workplace')

/**
 * Wraps the Staff screens so that organizations with restaurant locations read
 * "location" where the generic messages say "workplace". Other organizations
 * get the same i18n instance back, untouched.
 */
export function ScopeWordingProvider({
	wording,
	children,
}: {
	wording: ScopeWording
	children: ReactNode
}) {
	const { i18n } = useLingui()
	const scoped = useMemo(
		() => (wording === 'location' ? createScopeWordingI18n(i18n) : i18n),
		// The instance changes identity when the locale does.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[wording, i18n, i18n.locale],
	)
	return (
		<ScopeWordingContext.Provider value={wording}>
			{wording === 'location' ? (
				<I18nProvider i18n={scoped}>{children}</I18nProvider>
			) : (
				children
			)}
		</ScopeWordingContext.Provider>
	)
}

/**
 * Which word the Staff UI uses for a scope. Messages already follow it through
 * `ScopeWordingProvider`; this is for code that must branch (for example to
 * show a location-only hint).
 */
export function useScopeLabel(): ScopeLabel {
	const wording = useContext(ScopeWordingContext)
	return { wording, isLocation: wording === 'location' }
}
