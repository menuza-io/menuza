import { Trans } from '@lingui/macro'
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router'
import { LanguageToggle } from '#app/components/kiosk/kiosk-chrome.tsx'
import { PairForm } from '#app/components/kiosk/kiosk-pair.tsx'
import { ScreenTitle } from '#app/components/kiosk/kiosk-screens.tsx'
import { useKioskLocale } from '#app/hooks/use-kiosk-locale.ts'
import {
	pairKiosk,
	type TenantApiUrls,
} from '#app/utils/kiosk/kiosk-pair-client.ts'
import { parsePairingFragment } from '#app/utils/staffing/kiosk-pairing.ts'

/**
 * Where the pairing QR code leads: `/kiosk/pair#r=<region>&c=<code>`. The code
 * is in the fragment, so no server ever receives it. It is removed from the
 * address bar before anything else happens, then used once against the regional
 * node. On success the tablet goes to the clock; on failure it offers the
 * paste box instead.
 */
export default function KioskPairRoute() {
	const { urls } = useOutletContext<{ urls: TenantApiUrls }>()
	const [state, setState] = useState<'working' | 'manual'>('working')
	const [message, setMessage] = useState<string | null>(null)
	const [locale, changeLocale] = useKioskLocale()

	useEffect(() => {
		const parsed = parsePairingFragment(window.location.hash)
		// Never leave the one-time code in the address bar or the history.
		window.history.replaceState(null, '', window.location.pathname)
		if (!parsed) {
			setState('manual')
			return
		}
		let live = true
		void pairKiosk(urls, parsed.code, parsed.region).then((result) => {
			if (!live) return
			if (result.ok) {
				// A full load, so the service worker takes over the clock page.
				window.location.replace('/kiosk')
			} else {
				setMessage(result.code)
				setState('manual')
			}
		})
		return () => {
			live = false
		}
	}, [urls])

	if (state === 'working') {
		return (
			<main
				id="main-content"
				role="status"
				className="flex min-h-0 flex-1 items-center justify-center p-6"
			>
				<ScreenTitle>
					<Trans>Pairing this tablet…</Trans>
				</ScreenTitle>
			</main>
		)
	}

	return (
		<main
			id="main-content"
			className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col justify-center gap-6 overflow-y-auto p-6"
		>
			<div className="flex items-start justify-between gap-3">
				<ScreenTitle>
					<Trans>Pair this tablet</Trans>
				</ScreenTitle>
				<LanguageToggle locale={locale} onChange={changeLocale} />
			</div>
			<PairForm
				initialErrorCode={message}
				onPair={async (code, region) => {
					const result = await pairKiosk(urls, code, region)
					if (result.ok) {
						window.location.replace('/kiosk')
						return { ok: true }
					}
					return result
				}}
			/>
		</main>
	)
}
