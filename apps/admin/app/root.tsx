import { storeUtmParams } from '@repo/analytics'
import { getImpersonationInfo, getUserId, logout } from '@repo/auth'
import {
	combineHeaders,
	getDomainUrl,
	getImgSrc,
	useNonce,
	makeTimings,
	time,
} from '@repo/common'
import { getCookieConsentState } from '@repo/common/cookie-consent'
import { pipeHeaders } from '@repo/common/headers'
import { getSidebarState } from '@repo/common/sidebar-cookie'
import { getToast } from '@repo/common/toast'
import { brand, getErrorTitle } from '@repo/config/brand'
import { User, db, eq } from '@repo/database'
import { getDirection } from '@repo/i18n'
import { honeypot } from '@repo/security'
import { DirectionProvider } from '@repo/ui'
import { EpicToaster } from '@repo/ui/sonner'
import { TooltipProvider } from '@repo/ui/tooltip'
import { OpenImgContextProvider } from 'openimg/react'
import {
	data,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLoaderData,
} from 'react-router'
import { HoneypotProvider } from 'remix-utils/honeypot/react'
import { ENV } from 'varlock/env'
import { type Route } from './+types/root.ts'
import appleTouchIconAssetUrl from './assets/favicons/apple-touch-icon.png'
import faviconAssetUrl from './assets/favicons/favicon.svg'
import { GeneralErrorBoundary } from './components/error-boundary.tsx'
import { ImpersonationBanner } from './components/impersonation-banner.tsx'
import { CookieConsentBanner } from './components/privacy-banner.tsx'
import { useToast } from './components/toaster.tsx'
import iconsHref from './components/ui/icons/sprite.svg?url'
import { linguiServer, localeCookie } from './modules/lingui/lingui.server.ts'
import { useOptionalTheme } from './routes/resources+/theme-switch.tsx'
import './styles/tailwind.css'
import { ClientHintCheck, getHints } from './utils/client-hints.tsx'
import { type Theme, getTheme } from './utils/theme.server.ts'

export const links: Route.LinksFunction = () => {
	return [
		// Preload svg sprite as a resource to avoid render blocking
		{ rel: 'preload', href: iconsHref, as: 'image' },
		{
			rel: 'icon',
			href: '/favicon.ico',
			sizes: '48x48',
		},
		{ rel: 'icon', type: 'image/svg+xml', href: faviconAssetUrl },
		{ rel: 'apple-touch-icon', href: appleTouchIconAssetUrl },
		{
			rel: 'manifest',
			href: '/site.webmanifest',
			crossOrigin: 'use-credentials',
		} as const, // necessary to make typescript happy
	].filter(Boolean)
}

export const meta: Route.MetaFunction = ({
	loaderData: data,
}: Route.MetaArgs) => {
	return [
		{ title: data ? brand.name : getErrorTitle() },
		{ name: 'description', content: brand.products.admin.description },
	]
}

export async function loader({ request }: Route.LoaderArgs) {
	const timings = makeTimings('root loader')
	const userId = await time(() => getUserId(request), {
		timings,
		type: 'getUserId',
		desc: 'getUserId in root',
	})
	const locale = await linguiServer.getLocale(request)

	const user = userId
		? await time(
				async () => {
					const result = await db.query.User.findFirst({
						where: eq(User.id, userId),
						with: {
							image: true,
							roleToUsers: {
								with: {
									role: {
										with: {
											permissionToRoles: {
												with: { permission: true },
											},
										},
									},
								},
							},
						},
					})
					return result
						? {
								id: result.id,
								name: result.name,
								username: result.username,
								image: result.image
									? { objectKey: result.image.objectKey }
									: null,
								roles: result.roleToUsers.map(({ role }) => ({
									name: role.name,
									permissions: role.permissionToRoles.map(({ permission }) => ({
										entity: permission.entity,
										action: permission.action,
										access: permission.access,
									})),
								})),
							}
						: null
				},
				{ timings, type: 'find user', desc: 'find user in root' },
			)
		: null
	if (userId && !user) {
		// The user is authenticated but we can't find them in the database.
		// Maybe they were deleted? Let's log them out.
		await logout({ request, redirectTo: '/' })
	}
	const honeyProps = await honeypot.getInputProps()
	const requestUrl = new URL(request.url)

	// Get sidebar state for marketing routes
	const isMarketingRoute = requestUrl.pathname.startsWith('/dashboard')
	const sidebarState = isMarketingRoute ? await getSidebarState(request) : null

	const requestInfo = {
		hints: getHints(request),
		origin: getDomainUrl(request),
		path: requestUrl.pathname,
		userPrefs: {
			theme: getTheme(request),
		},
		sidebarState,
	}
	const { toast, headers: toastHeaders } = await getToast(request)

	// Handle UTM parameters if present in the URL
	const utmResponse = await storeUtmParams(request)
	const utmHeaders = utmResponse?.headers || {}

	// Get impersonation info if user is an admin
	const impersonationInfo = await getImpersonationInfo(request)

	const cookieConsent = await getCookieConsentState(request)

	return data(
		{
			user,
			requestInfo,
			toast,
			honeyProps,
			locale,
			impersonationInfo,
			cookieConsent,
			env: {
				NODE_ENV: ENV.NODE_ENV,
				ALLOW_INDEXING: ENV.ALLOW_INDEXING,
			},
		},
		{
			headers: combineHeaders(
				{
					'Server-Timing': timings.toString(),
					'Set-Cookie': await localeCookie.serialize(locale),
				},
				toastHeaders,
				utmHeaders,
			),
		},
	)
}

export const headers: Route.HeadersFunction = pipeHeaders

function Document({
	children,
	nonce,
	theme = 'dark',
	env = {},
}: {
	children: React.ReactNode
	nonce: string
	theme?: Theme
	env: Record<string, any>
}) {
	const allowIndexing = env.ALLOW_INDEXING !== false
	const { locale } = useLoaderData<typeof loader>()
	const direction = getDirection(locale)

	return (
		<html
			lang={locale ?? 'en'}
			dir={direction}
			className={`${theme} h-full overflow-x-hidden`}
		>
			<head>
				<ClientHintCheck nonce={nonce} />
				<Meta />
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width,initial-scale=1" />
				{allowIndexing ? null : (
					<meta name="robots" content="noindex, nofollow" />
				)}
				<Links nonce={nonce} />
			</head>
			<body className="bg-background text-foreground">
				<DirectionProvider direction={direction}>{children}</DirectionProvider>
				<ScrollRestoration nonce={nonce} />
				<Scripts nonce={nonce} />
			</body>
		</html>
	)
}

export function Layout({ children }: { children: React.ReactNode }) {
	// if there was an error running the loader, data could be missing
	const data = useLoaderData<typeof loader>()
	const nonce = useNonce()
	const theme = useOptionalTheme() || 'dark'

	// For non-marketing routes, use the regular Document with App component
	return (
		<Document nonce={nonce} theme={theme} env={data.env}>
			{children}
		</Document>
	)
}

function AppWithProviders() {
	const data = useLoaderData<typeof loader>()
	useToast(data.toast)

	return (
		<HoneypotProvider {...data.honeyProps}>
			<OpenImgContextProvider
				optimizerEndpoint="/resources/images"
				getSrc={getImgSrc}
			>
				{data.impersonationInfo && (
					<ImpersonationBanner impersonationInfo={data.impersonationInfo} />
				)}
				<TooltipProvider>
					<Outlet />
				</TooltipProvider>
				<EpicToaster />
				<CookieConsentBanner consent={data.cookieConsent} />
			</OpenImgContextProvider>
		</HoneypotProvider>
	)
}

export default AppWithProviders

// this is a last resort error boundary. There's not much useful information we
// can offer at this level.
export const ErrorBoundary = GeneralErrorBoundary
