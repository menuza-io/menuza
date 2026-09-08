import { type GetSrcArgs, defaultGetSrc } from 'openimg/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFormAction, useNavigation } from 'react-router'
import { useSpinDelay } from 'spin-delay'

import { getBrandDomain } from '@repo/config/brand'

export function getUserImgSrc(objectKey?: string | null) {
	return objectKey
		? `/resources/images?objectKey=${encodeURIComponent(objectKey)}`
		: '/img/user.png'
}

export function getNoteImgSrc(objectKey: string, organizationId?: string) {
	const params = new URLSearchParams({ objectKey })
	if (organizationId) {
		params.set('organizationId', organizationId)
	}
	return `/resources/images?${params.toString()}`
}

export function getVideoSourceSrc(objectKey: string, organizationId?: string) {
	const params = new URLSearchParams({ objectKey })
	if (organizationId) {
		params.set('organizationId', organizationId)
	}
	return `/resources/videos/source?${params.toString()}`
}

function buildMediaTransformUrl(
	sourcePath: string,
	options: string,
	mediaTransformBaseUrl?: string | null,
) {
	if (!mediaTransformBaseUrl) {
		return sourcePath
	}
	const base = mediaTransformBaseUrl.replace(/\/$/, '')
	const absoluteSource = `${base}${sourcePath.startsWith('/') ? sourcePath : `/${sourcePath}`}`
	return `${base}/cdn-cgi/media/${options}/${encodeURIComponent(absoluteSource)}`
}

export function getVideoPosterSrc(
	objectKey: string,
	organizationId?: string,
	mediaTransformBaseUrl?: string | null,
) {
	const sourcePath = getVideoSourceSrc(objectKey, organizationId)
	return buildMediaTransformUrl(
		sourcePath,
		'mode=frame,time=1s,width=640,fit=scale-down,format=jpg',
		mediaTransformBaseUrl,
	)
}

export function getVideoClipSrc(
	objectKey: string,
	organizationId?: string,
	mediaTransformBaseUrl?: string | null,
) {
	const sourcePath = getVideoSourceSrc(objectKey, organizationId)
	return buildMediaTransformUrl(
		sourcePath,
		'mode=video,time=1s,duration=3s,width=480,fit=scale-down,audio=false',
		mediaTransformBaseUrl,
	)
}

export function formatDate(date: Date | string | number) {
	return new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(date))
}

export function getImgSrc({
	height,
	optimizerEndpoint,
	src,
	width,
	fit,
	format,
}: GetSrcArgs) {
	// We customize getImgSrc so our src looks nice like this:
	// /resources/images?objectKey=...&h=...&w=...&fit=...&format=...
	// instead of this:
	// /resources/images?src=%2Fresources%2Fimages%3FobjectKey%3D...%26w%3D...%26h%3D...
	if (src.startsWith(optimizerEndpoint)) {
		const [endpoint, query] = src.split('?')
		const searchParams = new URLSearchParams(query)
		searchParams.set('h', height.toString())
		searchParams.set('w', width.toString())
		if (fit) {
			searchParams.set('fit', fit)
		}
		if (format) {
			searchParams.set('format', format)
		}
		return `${endpoint}?${searchParams.toString()}`
	}
	return defaultGetSrc({ height, optimizerEndpoint, src, width, fit, format })
}

export function getErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	console.error('Unable to get error message for error', error)
	return 'Unknown Error'
}

export function getDomainUrl(request: Request) {
	// WARNING: We do NOT use X-Forwarded-Host to prevent host spoofing.
	// If you are behind a reverse proxy, configure it to preserve the original Host header,
	// or explicitly validate the X-Forwarded-Host against an allowlist before using it.
	const host =
		request.headers.get('host') ??
		new URL(request.url).host

	const hostValue = host.split(',')[0]?.trim() ?? host
	const hostLower = hostValue.toLowerCase()
	const brandDomain = getBrandDomain().toLowerCase()
	const isTrustedHost =
		hostLower === 'localhost' ||
		hostLower.endsWith('.localhost') ||
		hostLower === brandDomain ||
		hostLower.endsWith(`.${brandDomain}`)

	const forwardedProto =
		request.headers.get('X-Forwarded-Proto') ??
		request.headers.get('x-forwarded-proto')

	const protocol =
		(isTrustedHost && forwardedProto
			? forwardedProto
			: new URL(request.url).protocol.slice(0, -1))
			.split(',')[0]
			?.trim() ?? 'http'

	// If we're behind a proxy that terminates TLS, use https
	// Also brute force for specific domain to match existing logic
	if (protocol === 'https' || hostValue.includes(getBrandDomain())) {
		return `https://${hostValue}`
	}
	return `${protocol}://${hostValue}`
}

export function getReferrerRoute(request: Request) {
	// spelling errors and whatever makes this annoyingly inconsistent
	// in my own testing, `referer` returned the right value, but 🤷‍♂️
	const referrer =
		request.headers.get('referer') ??
		request.headers.get('referrer') ??
		request.referrer
	const domain = getDomainUrl(request)
	if (referrer?.startsWith(domain)) {
		return referrer.slice(domain.length)
	} else {
		return '/'
	}
}

/**
 * Merge multiple headers objects into one (uses set so headers are overridden)
 */
export function mergeHeaders(
	...headers: Array<ResponseInit['headers'] | null | undefined>
) {
	const merged = new Headers()
	for (const header of headers) {
		if (!header) continue
		const h = header instanceof Headers ? header : new Headers(header)
		for (const [key, value] of h.entries()) {
			merged.set(key, value)
		}
		if (h.getSetCookie) {
			const setCookies = h.getSetCookie()
			if (setCookies.length > 0) {
				merged.delete('set-cookie')
				for (const setCookie of setCookies) {
					merged.append('set-cookie', setCookie)
				}
			}
		}
	}
	return merged
}

/**
 * Combine multiple header objects into one (uses append so headers are not overridden)
 */
export function combineHeaders(
	...headers: Array<ResponseInit['headers'] | null | undefined>
) {
	const combined = new Headers()
	for (const header of headers) {
		if (!header) continue
		const h = header instanceof Headers ? header : new Headers(header)
		for (const [key, value] of h.entries()) {
			if (key === 'set-cookie') continue
			combined.append(key, value)
		}
		if (h.getSetCookie) {
			for (const setCookie of h.getSetCookie()) {
				combined.append('set-cookie', setCookie)
			}
		} else {
			const setCookie = h.get('set-cookie')
			if (setCookie) {
				combined.append('set-cookie', setCookie)
			}
		}
	}
	return combined
}

/**
 * Combine multiple response init objects into one (uses combineHeaders)
 */
export function combineResponseInits(
	...responseInits: Array<ResponseInit | null | undefined>
) {
	let combined: ResponseInit = {}
	for (const responseInit of responseInits) {
		combined = {
			...responseInit,
			headers: combineHeaders(combined.headers, responseInit?.headers),
		}
	}
	return combined
}

/**
 * Returns true if the current navigation is submitting the current route's
 * form. Defaults to the current route's form action and method POST.
 *
 * Defaults state to 'non-idle'
 *
 * NOTE: the default formAction will include query params, but the
 * navigation.formAction will not, so don't use the default formAction if you
 * want to know if a form is submitting without specific query params.
 */
export function useIsPending({
	formAction,
	formMethod = 'POST',
	state = 'non-idle',
}: {
	formAction?: string
	formMethod?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'
	state?: 'submitting' | 'loading' | 'non-idle'
} = {}) {
	const contextualFormAction = useFormAction()
	const navigation = useNavigation()
	const isPendingState =
		state === 'non-idle'
			? navigation.state !== 'idle'
			: navigation.state === state
	return (
		isPendingState &&
		navigation.formAction === (formAction ?? contextualFormAction) &&
		navigation.formMethod === formMethod
	)
}

/**
 * This combines useSpinDelay (from https://npm.im/spin-delay) and useIsPending
 * from our own utilities to give you a nice way to show a loading spinner for
 * a minimum amount of time, even if the request finishes right after the delay.
 *
 * This avoids a flash of loading state regardless of how fast or slow the
 * request is.
 */
export function useDelayedIsPending({
	formAction,
	formMethod,
	delay = 400,
	minDuration = 300,
}: Parameters<typeof useIsPending>[0] &
	Parameters<typeof useSpinDelay>[1] = {}) {
	const isPending = useIsPending({ formAction, formMethod })
	const delayedIsPending = useSpinDelay(isPending, {
		delay,
		minDuration,
	})
	return delayedIsPending
}

function callAll<Args extends Array<unknown>>(
	...fns: Array<((...args: Args) => unknown) | undefined>
) {
	return (...args: Args) => fns.forEach((fn) => fn?.(...args))
}

/**
 * Use this hook with a button and it will make it so the first click sets a
 * `doubleCheck` state to true, and the second click will actually trigger the
 * `onClick` handler. This allows you to have a button that can be like a
 * "are you sure?" experience for the user before doing destructive operations.
 */
export function useDoubleCheck() {
	const [doubleCheck, setDoubleCheck] = useState(false)

	function getButtonProps(
		props?: React.ButtonHTMLAttributes<HTMLButtonElement>,
	) {
		const onBlur: React.ButtonHTMLAttributes<HTMLButtonElement>['onBlur'] =
			() => setDoubleCheck(false)

		const onClick: React.ButtonHTMLAttributes<HTMLButtonElement>['onClick'] =
			doubleCheck
				? undefined
				: (e) => {
						e.preventDefault()
						setDoubleCheck(true)
					}

		const onKeyUp: React.ButtonHTMLAttributes<HTMLButtonElement>['onKeyUp'] = (
			e,
		) => {
			if (e.key === 'Escape') {
				setDoubleCheck(false)
			}
		}

		return {
			...props,
			onBlur: callAll(onBlur, props?.onBlur),
			onClick: callAll(onClick, props?.onClick),
			onKeyUp: callAll(onKeyUp, props?.onKeyUp),
		}
	}

	return { doubleCheck, getButtonProps }
}

/**
 * Simple debounce implementation
 */
function debounce<Callback extends (...args: Parameters<Callback>) => void>(
	fn: Callback,
	delay: number,
) {
	let timer: ReturnType<typeof setTimeout> | null = null
	return (...args: Parameters<Callback>) => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			fn(...args)
		}, delay)
	}
}

/**
 * Debounce a callback function
 */
export function useDebounce<
	Callback extends (...args: Parameters<Callback>) => ReturnType<Callback>,
>(callback: Callback, delay: number) {
	const callbackRef = useRef(callback)
	useEffect(() => {
		callbackRef.current = callback
	})
	return useMemo(
		() =>
			debounce(
				(...args: Parameters<Callback>) => callbackRef.current(...args),
				delay,
			),
		[delay],
	)
}

export async function downloadFile(url: string, retries: number = 0) {
	const MAX_RETRIES = 3
	try {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`Failed to fetch image with status ${response.status}`)
		}
		const contentType = response.headers.get('content-type') ?? 'image/jpg'
		const arrayBuffer = await response.arrayBuffer()
		const blob = new Blob([arrayBuffer], { type: contentType })
		const file = new File([blob], 'downloaded-file', {
			type: contentType,
		})
		return file
	} catch (e) {
		if (retries > MAX_RETRIES) throw e
		return downloadFile(url, retries + 1)
	}
}
