import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Progress } from '@repo/ui/progress'
import { useState } from 'react'
import { Link, useRevalidator } from 'react-router'
import { MenuReviewStack } from '#app/components/menu/menu-review-stack.tsx'
import {
	getMenuHealthFixes,
	MENU_HEALTH_CATEGORY_CHECKS,
	MENU_HEALTH_PARAM,
	type MenuHealth,
	type MenuHealthCheck,
	type MenuHealthCheckKey,
	type MenuHealthSeverity,
} from '#app/utils/menu/menu-health.ts'

function SeverityIcon({ severity }: { severity: MenuHealthSeverity }) {
	switch (severity) {
		case 'error':
			return <Icon name="circle-alert" className="text-destructive" />
		case 'warning':
			return <Icon name="alert-triangle" className="text-warning" />
		case 'info':
			return <Icon name="info" className="text-muted-foreground" />
	}
}

function ScoreLabel({ score }: { score: number }) {
	if (score >= 90)
		return (
			<Badge variant="success">
				<Trans>Excellent</Trans>
			</Badge>
		)
	if (score >= 75)
		return (
			<Badge variant="default">
				<Trans>Good</Trans>
			</Badge>
		)
	if (score >= 50)
		return (
			<Badge variant="warning">
				<Trans>Needs work</Trans>
			</Badge>
		)
	return (
		<Badge variant="destructive">
			<Trans>Incomplete</Trans>
		</Badge>
	)
}

function FixLabel({ check }: { check: MenuHealthCheck }) {
	const n = check.count
	const all = check.count === check.total
	switch (check.key) {
		case 'zero_price':
			return (
				<Plural
					value={n}
					one="# dish is priced at 0"
					other="# dishes are priced at 0"
				/>
			)
		case 'no_photo':
			return all ? (
				<Trans>No dish has a photo</Trans>
			) : (
				<Plural
					value={n}
					one="# dish has no photo"
					other="# dishes have no photo"
				/>
			)
		case 'no_description':
			return all ? (
				<Trans>No dish has a description</Trans>
			) : (
				<Plural
					value={n}
					one="# dish has no description"
					other="# dishes have no description"
				/>
			)
		case 'missing_translation':
			return check.locales?.length === 1 && check.locales[0] === 'ar' ? (
				<Plural
					value={n}
					one="# dish is missing an Arabic name or description"
					other="# dishes are missing an Arabic name or description"
				/>
			) : (
				<Plural
					value={n}
					one="# dish is missing a translated name or description"
					other="# dishes are missing a translated name or description"
				/>
			)
		case 'no_allergens_or_calories':
			return all ? (
				<Trans>No dish lists allergens or calories</Trans>
			) : (
				<Plural
					value={n}
					one="# dish doesn't list allergens or calories"
					other="# dishes don't list allergens or calories"
				/>
			)
		case 'long_unavailable':
			return (
				<Plural
					value={n}
					one="# dish has been unavailable for more than a week"
					other="# dishes have been unavailable for more than a week"
				/>
			)
		case 'empty_category':
			return (
				<Plural
					value={n}
					one="# category is empty"
					other="# categories are empty"
				/>
			)
	}
}

function fixHref(orgSlug: string, key: MenuHealthCheckKey) {
	const list = MENU_HEALTH_CATEGORY_CHECKS.has(key) ? 'categories' : 'items'
	return `/${orgSlug}/menu/${list}?${MENU_HEALTH_PARAM}=${key}`
}

/** Checks the Review suggestions stack can fix; the rest stay as lists. */
const REVIEWABLE_CHECKS: ReadonlySet<MenuHealthCheckKey> =
	new Set<MenuHealthCheckKey>([
		'missing_translation',
		'no_description',
		'empty_category',
		'long_unavailable',
	])

export type MenuReviewSettings = {
	canEdit: boolean
	translationLocales: string[]
	autoTranslate: boolean
}

/**
 * Menu health on the Menu overview: a 0-100 score and the fix-it list behind
 * it. Each line opens the Items or Categories list filtered to what it counts.
 * Members who can edit the menu also get "Review suggestions", a card stack
 * that fixes translations, descriptions, empty categories and long-unavailable
 * dishes one at a time.
 */
export function MenuHealthCard({
	health,
	orgSlug,
	review,
}: {
	health: MenuHealth
	orgSlug: string
	review?: MenuReviewSettings
}) {
	const { _ } = useLingui()
	const revalidator = useRevalidator()
	const [reviewOpen, setReviewOpen] = useState(false)
	if (health.itemCount === 0) {
		return (
			<Card size="sm">
				<CardHeader>
					<CardTitle>
						<Trans>Menu health</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Add your first dishes to see how complete your menu is.
						</Trans>
					</CardDescription>
					<CardAction>
						<Button
							variant="outline"
							size="sm"
							render={<Link to={`/${orgSlug}/menu/items/new`} />}
						>
							<Icon name="plus" className="size-4" />
							<Trans>Add a dish</Trans>
						</Button>
					</CardAction>
				</CardHeader>
			</Card>
		)
	}

	const fixes = getMenuHealthFixes(health)
	const canReview =
		Boolean(review?.canEdit) &&
		fixes.some((check) => REVIEWABLE_CHECKS.has(check.key))

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					<Trans>Menu health</Trans>
				</CardTitle>
				<CardDescription>
					{fixes.length === 0 ? (
						<Trans>
							Every dish has a photo, a description and a price. Nice work.
						</Trans>
					) : (
						<Trans>Finish these to help guests choose and order.</Trans>
					)}
				</CardDescription>
				<CardAction>
					<div className="flex items-center gap-2">
						<span className="text-2xl font-semibold tabular-nums">
							{health.score}
						</span>
						<span className="text-muted-foreground text-sm">/ 100</span>
						<ScoreLabel score={health.score} />
					</div>
				</CardAction>
			</CardHeader>
			<CardContent className="space-y-3">
				<Progress value={health.score} aria-label={_(t`Menu health score`)} />
				{canReview ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() => setReviewOpen(true)}
					>
						<Icon name="sparkles" className="size-4" />
						<Trans>Review suggestions</Trans>
					</Button>
				) : null}
				{fixes.length === 0 ? (
					<Item variant="muted" size="sm">
						<ItemMedia variant="icon">
							<Icon name="circle-check" className="text-success" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>
								<Trans>Nothing left to fix</Trans>
							</ItemTitle>
						</ItemContent>
					</Item>
				) : (
					<ItemGroup>
						{fixes.map((check) => (
							<Item
								key={check.key}
								size="xs"
								render={<Link to={fixHref(orgSlug, check.key)} />}
							>
								<ItemMedia variant="icon">
									<SeverityIcon severity={check.severity} />
								</ItemMedia>
								<ItemContent>
									<ItemTitle className="font-normal">
										<FixLabel check={check} />
									</ItemTitle>
								</ItemContent>
								<ItemActions>
									<Icon
										name="chevron-right"
										className="text-muted-foreground size-4 rtl:rotate-180"
									/>
								</ItemActions>
							</Item>
						))}
					</ItemGroup>
				)}
			</CardContent>
			{canReview && review ? (
				<MenuReviewStack
					orgSlug={orgSlug}
					open={reviewOpen}
					onOpenChange={setReviewOpen}
					translationLocales={review.translationLocales}
					autoTranslate={review.autoTranslate}
					onChanged={() => void revalidator.revalidate()}
				/>
			) : null}
		</Card>
	)
}

function FilterLabel({ checkKey }: { checkKey: MenuHealthCheckKey }) {
	switch (checkKey) {
		case 'zero_price':
			return <Trans>Showing dishes priced at 0</Trans>
		case 'no_photo':
			return <Trans>Showing dishes with no photo</Trans>
		case 'no_description':
			return <Trans>Showing dishes with no description</Trans>
		case 'missing_translation':
			return (
				<Trans>Showing dishes missing a translated name or description</Trans>
			)
		case 'no_allergens_or_calories':
			return <Trans>Showing dishes that don't list allergens or calories</Trans>
		case 'long_unavailable':
			return <Trans>Showing dishes unavailable for more than a week</Trans>
		case 'empty_category':
			return <Trans>Showing empty categories</Trans>
	}
}

/** Shown above the Items or Categories list while `?health=` filters it. */
export function MenuHealthFilterNotice({
	checkKey,
	count,
	clearTo,
}: {
	checkKey: MenuHealthCheckKey
	count: number
	clearTo: string
}) {
	return (
		<Item variant="muted" size="sm">
			<ItemMedia variant="icon">
				<Icon name={count === 0 ? 'circle-check' : 'activity'} />
			</ItemMedia>
			<ItemContent>
				<ItemTitle>
					{count === 0 ? (
						<Trans>All fixed. Nothing left in this list.</Trans>
					) : (
						<FilterLabel checkKey={checkKey} />
					)}
				</ItemTitle>
			</ItemContent>
			<ItemActions>
				<Button variant="ghost" size="sm" render={<Link to={clearTo} />}>
					<Icon name="x" className="size-4" />
					<Trans>Show all</Trans>
				</Button>
			</ItemActions>
		</Item>
	)
}
