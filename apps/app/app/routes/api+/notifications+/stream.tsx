import { requireUserId } from '@repo/auth'
import {
	and,
	db,
	eq,
	gte,
	asc,
	Organization,
	Notification,
} from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { filterVisibleNotifications } from '#app/utils/staffing/notification-visibility.server.ts'

const POLL_INTERVAL_MS = 3000
const KEEP_ALIVE_INTERVAL_MS = 30000

function getErrorDetails(error: unknown) {
	const cause =
		error instanceof Error
			? (error as Error & { cause?: unknown }).cause
			: undefined
	const rootCause = cause ?? error

	if (rootCause instanceof Error) {
		return { name: rootCause.name, message: rootCause.message }
	}

	if (
		typeof rootCause === 'object' &&
		rootCause !== null &&
		'message' in rootCause &&
		typeof rootCause.message === 'string'
	) {
		return { name: 'UnknownError', message: rootCause.message }
	}

	return { name: 'UnknownError', message: String(rootCause) }
}

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	const url = new URL(request.url)
	const orgSlug = url.searchParams.get('orgSlug')

	let organizationId: string | undefined
	if (orgSlug) {
		const [org] = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(eq(Organization.slug, orgSlug))
			.limit(1)
		if (!org) {
			return new Response('Organization not found', { status: 404 })
		}
		organizationId = org.id
	}

	let isClosed = false

	let keepAliveTimer: ReturnType<typeof setInterval> | undefined
	let pollTimer: ReturnType<typeof setTimeout> | undefined

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder()

			const send = (event: string, data: any) => {
				if (isClosed) return
				controller.enqueue(encoder.encode(`event: ${event}\n`))
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
			}

			// Keep-alive
			keepAliveTimer = setInterval(() => {
				if (isClosed) return
				controller.enqueue(encoder.encode(':\n\n'))
			}, KEEP_ALIVE_INTERVAL_MS)

			// CAPACITY & CORRECTNESS NOTE:
			// 1. Scales linearly (N queries / 3s). High scale requires Redis pub/sub.
			// 2. Relies on wall-clock time (`updatedAt`). High clock drift between nodes may cause missed events.
			// We overlap using `gte` and `seenIds` to handle same-millisecond edge cases.
			let lastCheckedAt = new Date()
			const seenIds = new Set<string>()

			const schedulePoll = () => {
				if (isClosed) return
				pollTimer = setTimeout(() => {
					void poll()
				}, POLL_INTERVAL_MS)
			}

			// Poll sequentially rather than using setInterval: a slow D1 request must
			// never cause additional polls to pile up behind it.
			const poll = async () => {
				try {
					const newNotifications = await db
						.select()
						.from(Notification)
						.where(
							and(
								eq(Notification.userId, userId),
								organizationId
									? eq(Notification.organizationId, organizationId)
									: undefined,
								gte(Notification.updatedAt, lastCheckedAt),
							),
						)
						.orderBy(asc(Notification.updatedAt))

					const unseen = newNotifications.filter((n) => !seenIds.has(n.id))

					if (unseen.length > 0) {
						lastCheckedAt = unseen[unseen.length - 1]!.updatedAt
						const visible = new Set(
							(await filterVisibleNotifications(userId, unseen)).map(
								(n) => n.id,
							),
						)
						for (const notification of unseen) {
							seenIds.add(notification.id)
							if (visible.has(notification.id)) {
								send('notification', notification)
							}
						}

						// Rebuild seenIds to contain only IDs that can be returned by the next gte query
						seenIds.clear()
						for (const n of newNotifications) {
							if (n.updatedAt.getTime() >= lastCheckedAt.getTime()) {
								seenIds.add(n.id)
							}
						}
					}
				} catch (e) {
					// Drizzle wraps D1 errors. Log its cause so Workers Logs retains the
					// D1 diagnostic without logging query parameters or notification data.
					const { name, message } = getErrorDetails(e)
					console.error(`SSE Poll Error (${name}): ${message}`)
				} finally {
					schedulePoll()
				}
			}

			schedulePoll()

			request.signal.addEventListener('abort', () => {
				isClosed = true
				clearInterval(keepAliveTimer)
				if (pollTimer) clearTimeout(pollTimer)
				controller.close()
			})
		},
		cancel() {
			isClosed = true
			if (keepAliveTimer) clearInterval(keepAliveTimer)
			if (pollTimer) clearTimeout(pollTimer)
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	})
}
