import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { useFetcher } from 'react-router'

/**
 * "Give this dish its own page" (#137, `website.dish_pages`): publishes
 * `/menu/<slug>` on the website while the dish is visible online.
 */
export function DishPageCard({
	orgSlug,
	itemId,
	enabled,
	slug,
}: {
	orgSlug: string
	itemId: string
	enabled: boolean
	slug: string | null
}) {
	const fetcher = useFetcher<{ ok: boolean; slug?: string | null }>()
	const pending = fetcher.formData?.get('enabled')
	const checked = pending ? pending === 'true' : enabled
	const shownSlug = fetcher.data?.slug ?? slug
	return (
		<Card data-testid="dish-page-card">
			<CardHeader>
				<CardTitle className="text-base">
					<Trans>Website page</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						A page of its own helps guests find this dish in search. It
						disappears while the dish is hidden.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-wrap items-center gap-3">
				<Switch
					id={`dish-page-${itemId}`}
					checked={checked}
					onCheckedChange={(next) =>
						void fetcher.submit(
							{ enabled: String(next) },
							{
								method: 'POST',
								action: `/${orgSlug}/menu/items/${itemId}/site-page`,
							},
						)
					}
				/>
				<Label htmlFor={`dish-page-${itemId}`}>
					<Trans>Give this dish its own page</Trans>
				</Label>
				{checked && shownSlug ? (
					<span dir="ltr" className="text-muted-foreground font-mono text-xs">
						/menu/{shownSlug}
					</span>
				) : null}
			</CardContent>
		</Card>
	)
}
