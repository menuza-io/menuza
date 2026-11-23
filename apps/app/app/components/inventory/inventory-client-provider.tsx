import {
	createContext,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
} from 'react'
import { z } from 'zod'
import {
	type OperatorCredentials,
	OperatorRequestError,
	type OperatorRequestInit,
	operatorTokenUrl,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'

export type InventoryBlobResult = {
	blob: Blob
	filename: string | null
}

export type InventoryClient = {
	orgSlug: string
	/**
	 * Calls `/operator/inventory<path>` on the organization's regional
	 * tenant-api with a short-lived `inv+jwt` (read for GET, write otherwise).
	 * Throws `OperatorRequestError` on a non-2xx answer. `readOnly: true` marks
	 * a POST that only reads (recipe costs) so it uses the read token.
	 */
	request: (path: string, init?: OperatorRequestInit) => Promise<unknown>
	/**
	 * Fetches a binary file (CSV / PDF) straight from the organization's
	 * regional tenant-api using the short-lived `inv+jwt`.
	 */
	requestBlob?: (
		path: string,
		init?: OperatorRequestInit,
	) => Promise<InventoryBlobResult>
}

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string().url(),
})

function parseFilename(disposition: string | null): string | null {
	if (!disposition) return null
	const utf8 = /filename\*=UTF-8''([^;\r\n]+)/i.exec(disposition)
	if (utf8?.[1]) {
		try {
			return decodeURIComponent(utf8[1].trim())
		} catch {
			return utf8[1].trim()
		}
	}
	const basic = /filename="([^"]+)"|filename=([^;\r\n]+)/i.exec(disposition)
	return (basic?.[1] ?? basic?.[2])?.trim() || null
}

export const InventoryClientContext = createContext<InventoryClient | null>(
	null,
)

/**
 * One inventory client per Inventory layout mount, so cached tokens never
 * outlive a sign-out or an organization switch. Stock and staff data go
 * browser-direct to the region; they never transit App SSR.
 */
export function InventoryClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const { request } = useOperatorClient(
		orgSlug,
		'/operator/inventory',
		'inventory-token',
	)
	const blobCreds = useRef<{
		expires: number
		credentials: Promise<OperatorCredentials>
	} | null>(null)

	const requestBlob = useCallback(
		async (
			path: string,
			init: OperatorRequestInit = {},
		): Promise<InventoryBlobResult> => {
			const write =
				!init.readOnly && init.method !== undefined && init.method !== 'GET'
			const getCreds = (forceRefresh = false) => {
				if (
					forceRefresh ||
					!blobCreds.current ||
					blobCreds.current.expires <= Date.now()
				) {
					const credentials = fetch(
						operatorTokenUrl(
							orgSlug,
							'inventory-token',
							write,
							init.tokenQuery,
						),
						{ headers: { Accept: 'application/json' } },
					).then(async (response) => {
						if (!response.ok) {
							throw new Error('Unable to authorize this request.')
						}
						return credentialsSchema.parse(await response.json())
					})
					blobCreds.current = {
						credentials,
						expires: Date.now() + 10 * 60000,
					}
					void credentials.catch(() => {
						blobCreds.current = null
					})
				}
				return blobCreds.current.credentials
			}
			const send = async (forceRefresh = false) => {
				const { jwt, tenantApiUrl } = await getCreds(forceRefresh)
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				const {
					readOnly: ignoredReadOnly,
					tokenQuery: ignoredTokenQuery,
					...rest
				} = init
				return fetch(`${tenantApiUrl}/operator/inventory${path}`, {
					...rest,
					headers,
				})
			}
			let response = await send(false)
			if (response.status === 401) {
				response = await send(true)
			}
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => null)
				const error = z
					.object({ error: z.string(), message: z.string().optional() })
					.safeParse(body)
				throw new OperatorRequestError(
					error.success
						? (error.data.message ?? error.data.error)
						: 'The request failed.',
					error.success ? error.data.error : 'request_failed',
					response.status,
					error.success ? (body as Record<string, unknown>) : null,
				)
			}
			return {
				blob: await response.blob(),
				filename: parseFilename(response.headers.get('Content-Disposition')),
			}
		},
		[orgSlug],
	)

	const value = useMemo<InventoryClient>(
		() => ({ orgSlug, request, requestBlob }),
		[orgSlug, request, requestBlob],
	)
	return (
		<InventoryClientContext.Provider value={value}>
			{children}
		</InventoryClientContext.Provider>
	)
}
