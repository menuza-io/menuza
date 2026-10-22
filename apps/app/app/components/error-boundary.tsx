import { usePostHog } from '@posthog/react'
import { getErrorMessage } from '@repo/common'
import { NotFoundPage } from '@repo/ui/not-found-page'
import {
	createContext,
	useContext,
	useEffect,
	type ReactElement,
	type ReactNode,
} from 'react'
import {
	type ErrorResponse,
	isRouteErrorResponse,
	useParams,
	useRouteError,
} from 'react-router'

type StatusHandler = (info: {
	error: ErrorResponse
	params: Record<string, string | undefined>
}) => ReactElement | null

const InAppShellContext = createContext(false)

// The App shell (sidebar and header) wraps its Outlet in this, so a route
// error inside it can fill the content area instead of the whole screen.
export function AppShellErrorScope({ children }: { children: ReactNode }) {
	return (
		<InAppShellContext.Provider value={true}>
			{children}
		</InAppShellContext.Provider>
	)
}

export function GeneralErrorBoundary({
	defaultStatusHandler = ({ error }) => (
		<p>
			{error.status} {error.data}
		</p>
	),
	statusHandlers,
	unexpectedErrorHandler = (error) => <p>{getErrorMessage(error)}</p>,
}: {
	defaultStatusHandler?: StatusHandler
	statusHandlers?: Record<number, StatusHandler>
	unexpectedErrorHandler?: (error: unknown) => ReactElement | null
}) {
	const error = useRouteError()
	const posthog = usePostHog()
	const params = useParams()
	const isResponse = isRouteErrorResponse(error)
	const inAppShell = useContext(InAppShellContext)

	if (typeof document !== 'undefined') {
		console.error(error)
	}

	useEffect(() => {
		if (isResponse) return

		posthog?.captureException(error)
		posthog?.logger.error('Unhandled React route error', {
			path: window.location.pathname,
		})
	}, [error, isResponse, posthog])

	// A route without its own 404 handler (for example Staff while the module
	// is off) gets the not-found page. Inside the App shell it fills the
	// content area; elsewhere (the auth pages) it is a standalone page.
	if (isResponse && error.status === 404 && !statusHandlers?.[404]) {
		return <NotFoundPage variant={inAppShell ? 'inline' : 'screen'} />
	}

	return (
		<div className="container flex items-center justify-center p-20 text-2xl">
			{isResponse
				? (statusHandlers?.[error.status] ?? defaultStatusHandler)({
						error,
						params,
					})
				: unexpectedErrorHandler(error)}
		</div>
	)
}

// The App-wide last-resort boundary: a 404 (for example an unknown
// organization slug) gets a page with a way back into the app, and everything
// else keeps the default status text. NotFoundPage is a full-screen layout, so
// it is not wrapped in GeneralErrorBoundary's padded container.
export function NotFoundErrorBoundary() {
	const error = useRouteError()
	if (isRouteErrorResponse(error) && error.status === 404) {
		if (typeof document !== 'undefined') console.error(error)
		return <NotFoundPage />
	}
	return <GeneralErrorBoundary />
}
