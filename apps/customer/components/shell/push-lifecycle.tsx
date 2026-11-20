import { useEffect, useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { PushClient } from '../../lib/api/push'
import { useAppSnapshot } from '../../lib/app/use-app'
import {
	notificationsAdapter,
	type PushTapData,
} from '../../lib/push/notifications'
import { PushManager } from '../../lib/push/push-manager'
import { destinationForPush } from '../../lib/push/tap'

/**
 * Keeps push working while the app runs (#105), and renders nothing:
 *
 * - signed in: registers this device again when the system already allows
 *   notifications (a push token can change), never asking the system;
 * - a tap, while the app runs or from a cold start: reports it (message id
 *   only) and opens the screen the payload's registry link names, or the
 *   website for a link the app does not claim.
 */
export function PushLifecycle(props: {
	navigate: (target: {
		pathname: string
		params: Record<string, string>
	}) => void
	openUrl: (url: string) => void
}) {
	const { session, configuration, language, isSignedIn } = useAppSnapshot()
	const handled = useRef(new Set<string>())
	const platform = Platform.OS === 'android' ? 'android' : 'ios'
	const manager = useMemo(
		() =>
			session && isSignedIn
				? new PushManager({ session, language: () => language.code })
				: null,
		[session, isSignedIn, language.code],
	)

	useEffect(() => {
		void manager?.sync()
	}, [manager])

	const { navigate, openUrl } = props
	useEffect(() => {
		if (!session || !isSignedIn) return
		const client = new PushClient(session)
		const handle = (data: PushTapData) => {
			// One tap is handled once, even when the cold-start and listener both see it.
			const id = data.messageId ?? data.url ?? ''
			if (id && handled.current.has(id)) return
			if (id) handled.current.add(id)
			if (data.messageId) void client.opened(data.messageId)
			const destination = destinationForPush(data, configuration, platform)
			if (destination.kind === 'screen') {
				navigate({ pathname: destination.pathname, params: destination.params })
			} else if (destination.kind === 'web') {
				openUrl(destination.url)
			}
		}
		const adapter = notificationsAdapter()
		let live = true
		void adapter
			.initialTap()
			.then((data) => {
				if (live && data) handle(data)
			})
			.catch(() => undefined)
		const stop = adapter.onTap(handle)
		return () => {
			live = false
			stop()
		}
	}, [session, isSignedIn, configuration, platform, navigate, openUrl])

	return null
}
