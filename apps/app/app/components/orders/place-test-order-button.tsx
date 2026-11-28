import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { useEffect } from 'react'
import { useFetcher } from 'react-router'

/**
 * "Place a test order" (#119): opens the location's website menu in a new tab
 * with a one-time code in its URL fragment. The test runs the real guest path
 * (kitchen screens, ticket, confirmation email) without money, sales, points,
 * stock or discount use. The minting action refuses while `launch.test_order`
 * is off, and answers `test_order_limit` after 10 codes a day per location.
 */
const ERRORS: Record<string, ReturnType<typeof msg>> = {
	test_order_limit: msg`You have placed the most test orders allowed today at this location. Try again tomorrow.`,
	location_not_found: msg`That location is not available to you.`,
}

export function PlaceTestOrderButton({
	orgSlug,
	locationId,
	variant = 'outline',
	size,
}: {
	orgSlug: string
	locationId: string
	variant?: 'outline' | 'default' | 'ghost'
	size?: 'sm'
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ url?: string; error?: string }>()
	const busy = fetcher.state !== 'idle'
	const url = fetcher.data?.url
	useEffect(() => {
		// The new tab opens from the answer; popup blockers allow it after a click
		// only when it follows the click closely, so the link below also stays.
		if (url) window.open(url, '_blank', 'noopener,noreferrer')
	}, [url])
	return (
		<div className="flex flex-col items-start gap-1">
			<fetcher.Form method="post" action={`/${orgSlug}/orders-test-code`}>
				<input type="hidden" name="locationId" value={locationId} />
				<Button
					type="submit"
					variant={variant}
					size={size}
					disabled={busy || !locationId}
					data-testid="place-test-order"
				>
					<Trans>Place a test order</Trans>
				</Button>
			</fetcher.Form>
			{url ? (
				<div className="flex flex-col gap-0.5">
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary text-xs underline-offset-4 hover:underline"
						data-testid="test-order-link"
					>
						<Trans>Open the test menu again</Trans>
					</a>
					<span className="text-muted-foreground text-xs">
						<Trans>
							The link works until the test order is placed. Then start a new
							one.
						</Trans>
					</span>
				</div>
			) : null}
			{fetcher.data?.error ? (
				<p role="alert" className="text-destructive text-xs">
					{_(
						ERRORS[fetcher.data.error] ??
							msg`We could not start a test order. Try again.`,
					)}
				</p>
			) : null}
		</div>
	)
}
