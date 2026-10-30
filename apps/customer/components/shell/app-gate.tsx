import { useLingui } from '@lingui/react/macro'
import { type ReactNode } from 'react'
import { useAppSnapshot } from '../../lib/app/use-app'
import { CompleteNameScreen } from '../auth/complete-name-screen'
import { ConnectSiteScreen } from '../auth/connect-site-screen'
import { LoginScreen } from '../auth/login-screen'
import { SiteUnavailableScreen } from '../auth/site-unavailable-screen'
import { VerifyScreen } from '../auth/verify-screen'
import { InsetView, LoadingView } from '../ui'

/**
 * Decides what the customer sees, in order:
 * the site first, then sign-in, then the name step, then the signed-in
 * screens (`children`, the tab navigator). Signing out unmounts the tabs, so
 * nothing of one customer's navigation reaches the next.
 */
export function AppGate({ children }: { children: ReactNode }) {
	const { t } = useLingui()
	const snapshot = useAppSnapshot()
	let screen: ReactNode
	switch (snapshot.phase.kind) {
		case 'loading':
			screen = <LoadingView label={t`Loading…`} />
			break
		case 'needsSite':
			screen = <ConnectSiteScreen />
			break
		case 'failed':
			screen = <SiteUnavailableScreen error={snapshot.phase.error} />
			break
		case 'ready':
			if (snapshot.isSignedIn && !snapshot.needsName) return <>{children}</>
			screen = snapshot.isSignedIn ? (
				<CompleteNameScreen />
			) : snapshot.pendingPhone !== null ? (
				<VerifyScreen />
			) : (
				<LoginScreen />
			)
			break
	}
	return (
		<InsetView edges={['bottom']} className="flex-1">
			{screen}
		</InsetView>
	)
}
