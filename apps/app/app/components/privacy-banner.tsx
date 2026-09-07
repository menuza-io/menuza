import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { useFetcher } from 'react-router'

export function CookieConsentBanner({
	consent,
}: {
	consent: boolean | undefined
}) {
	const fetcher = useFetcher()

	if (consent !== undefined) {
		return null
	}

	return (
		<aside
			aria-label="Cookie consent"
			className="bg-background text-foreground fixed inset-x-4 bottom-4 z-[100] max-h-[calc(100svh-2rem)] max-w-[360px] overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border p-5 shadow-lg sm:right-auto sm:bottom-5 sm:left-5"
		>
			<p className="text-muted-foreground m-0 text-sm leading-6">
				<Trans>
					We use cookies to enhance your experience, analyze site traffic and
					deliver personalized content.{' '}
					<a
						href="/legal/cookie-policy/"
						target="_blank"
						rel="noreferrer"
						className="text-foreground decoration-border hover:decoration-foreground font-medium underline underline-offset-4 transition-colors"
					>
						Read our Cookie Policy
					</a>
					.
				</Trans>
			</p>
			<div className="mt-4 flex gap-2.5">
				<Button
					type="button"
					variant="secondary"
					className="flex-1"
					onClick={() => {
						void fetcher.submit(
							{ consent: 'false' },
							{ method: 'POST', action: '/resources/cookie-consent' },
						)
					}}
				>
					<Trans>Reject</Trans>
				</Button>
				<Button
					type="button"
					className="flex-[2]"
					onClick={() => {
						void fetcher.submit(
							{ consent: 'true' },
							{ method: 'POST', action: '/resources/cookie-consent' },
						)
					}}
				>
					<Trans>Accept</Trans>
				</Button>
			</div>
		</aside>
	)
}
