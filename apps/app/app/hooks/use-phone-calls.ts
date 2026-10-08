import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string(),
})
type Credentials = z.infer<typeof credentialsSchema>

// Operator tokens live for 15 minutes; refresh a little early.
const CREDENTIALS_TTL_MS = 10 * 60_000

/** A failed call-history request, with a message ready to show. */
export class PhoneCallsError extends Error {
	readonly status: number | null

	constructor(message: string, status: number | null) {
		super(message)
		this.name = 'PhoneCallsError'
		this.status = status
	}
}

/** The error's own message when it came from the calls client, else `fallback`. */
export function phoneCallsErrorMessage(cause: unknown, fallback: string) {
	return cause instanceof PhoneCallsError ? cause.message : fallback
}

// tenant-api error bodies are English-only, so the message is chosen by status.
function statusMessage(status: number): MessageDescriptor {
	if (status === 401) {
		return msg`Your session for call history expired. Refresh the page and try again.`
	}
	if (status === 403) return msg`You don't have permission to do that.`
	if (status === 404) return msg`This call or request no longer exists.`
	if (status === 429)
		return msg`Too many requests. Wait a moment and try again.`
	if (status >= 400 && status < 500) {
		return msg`That change couldn't be saved. Refresh the page and try again.`
	}
	return msg`Call history is unavailable right now. Try again.`
}

/**
 * Call logs hold caller PII and live in the regional tenant-api. App only
 * mints the token; every request goes browser → tenant-api `/operator/calls`.
 */
export function usePhoneCallsClient(orgSlug: string) {
	const { _ } = useLingui()
	const credentials = useRef<{
		orgSlug: string
		value: Promise<Credentials>
		expires: number
	} | null>(null)
	return useCallback(
		async (path: string, init: RequestInit = {}) => {
			const getCredentials = () => {
				if (
					!credentials.current ||
					credentials.current.orgSlug !== orgSlug ||
					credentials.current.expires <= Date.now()
				) {
					const value = fetch(
						`/${encodeURIComponent(orgSlug)}/phone-agent/calls-token`,
						{ headers: { Accept: 'application/json' } },
					).then(async (response) => {
						if (!response.ok) {
							throw new PhoneCallsError(
								_(
									msg`Unable to authorize call history. Refresh the page and try again.`,
								),
								response.status,
							)
						}
						return credentialsSchema.parse(await response.json())
					})
					credentials.current = {
						orgSlug,
						value,
						expires: Date.now() + CREDENTIALS_TTL_MS,
					}
					void value.catch(() => {
						if (credentials.current?.value === value) credentials.current = null
					})
				}
				return credentials.current.value
			}
			const send = async () => {
				const { jwt, tenantApiUrl } = await getCredentials()
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				return fetch(`${tenantApiUrl}/operator/calls${path}`, {
					...init,
					headers,
				})
			}
			let response: Response
			try {
				response = await send()
				if (response.status === 401) {
					credentials.current = null
					response = await send()
				}
			} catch (cause) {
				if (cause instanceof PhoneCallsError || init.signal?.aborted) {
					throw cause
				}
				throw new PhoneCallsError(
					_(
						msg`Couldn't reach call history. Check your connection and try again.`,
					),
					null,
				)
			}
			if (!response.ok) {
				throw new PhoneCallsError(
					_(statusMessage(response.status)),
					response.status,
				)
			}
			return response.json() as Promise<unknown>
		},
		[orgSlug, _],
	)
}

/**
 * Keeps `onCount` up to date with how many calls still need follow-up, on
 * load, on window focus, and every minute while the page is visible.
 */
export function useOpenCallFollowUps(
	orgSlug: string,
	enabled: boolean,
	onCount: (count: number) => void,
) {
	const request = usePhoneCallsClient(orgSlug)
	useEffect(() => {
		if (!orgSlug || !enabled) return
		const controller = new AbortController()
		const refresh = async () => {
			try {
				const result = z.object({ openFollowUps: z.number() }).safeParse(
					await request('/?followUp=open&limit=1', {
						signal: controller.signal,
					}),
				)
				if (result.success && !controller.signal.aborted) {
					onCount(result.data.openFollowUps)
				}
			} catch {
				/* Keep the last known count; unavailable is not zero. */
			}
		}
		const onFocus = () => void refresh()
		void refresh()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, 60_000)
		window.addEventListener('focus', onFocus)
		return () => {
			controller.abort()
			window.clearInterval(timer)
			window.removeEventListener('focus', onFocus)
		}
	}, [orgSlug, enabled, request, onCount])
}
