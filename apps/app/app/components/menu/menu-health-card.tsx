import { type MessageDescriptor } from '@lingui/core'
import { msg, Plural, Trans, t } from '@lingui/macro'
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
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Progress } from '@repo/ui/progress'
import {
	createContext,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react'
import { Link, useFetcher, useRevalidator } from 'react-router'
import { toast } from 'sonner'
import { MenuReviewStack } from '#app/components/menu/menu-review-stack.tsx'
import { type MenuChecksBody } from '#app/routes/_app+/$orgSlug_+/menu+/checks.ts'
import {
	getMenuHealthFixes,
	MENU_HEALTH_PARAM,
	menuHealthEntityType,
	type MenuHealthCheckKey,
	type MenuHealthCheckSummary,
	type MenuHealthEntityType,
	type MenuHealthGrade,
	type MenuHealthRecordRef,
	type MenuHealthSeverity,
	type MenuHealthSummary,
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

/** The words beside the grade, from the grade itself so the two agree. */
function GradeLabel({ grade }: { grade: MenuHealthGrade }) {
	switch (grade) {
		case 'A':
			return (
				<Badge variant="success">
					<Trans>Excellent</Trans>
				</Badge>
			)
		case 'B':
			return (
				<Badge variant="default">
					<Trans>Good</Trans>
				</Badge>
			)
		case 'C':
		case 'D':
			return (
				<Badge variant="warning">
					<Trans>Needs work</Trans>
				</Badge>
			)
		case 'F':
			return (
				<Badge variant="destructive">
					<Trans>Incomplete</Trans>
				</Badge>
			)
	}
}

function FixLabel({ check }: { check: MenuHealthCheckSummary }) {
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
		case 'weak_photo':
			return (
				<Plural
					value={n}
					one="# dish has a weak photo"
					other="# dishes have a weak photo"
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
		case 'dishes_guests_cannot_see':
			return (
				<Plural
					value={n}
					one="# dish guests cannot see"
					other="# dishes guests cannot see"
				/>
			)
		case 'name_all_caps':
			return (
				<Plural
					value={n}
					one="# dish name is written in capitals"
					other="# dish names are written in capitals"
				/>
			)
		case 'name_too_long':
			return (
				<Plural
					value={n}
					one="# dish name is over 60 characters"
					other="# dish names are over 60 characters"
				/>
			)
		case 'empty_option_group':
			return (
				<Plural
					value={n}
					one="# option group has no choices guests can see"
					other="# option groups have no choices guests can see"
				/>
			)
		case 'impossible_minimum':
			return (
				<Plural
					value={n}
					one="# option group requires more picks than it allows"
					other="# option groups require more picks than they allow"
				/>
			)
		case 'duplicate_item':
			return (
				<Plural
					value={n}
					one="# dish is listed twice (same name and price)"
					other="# dishes are listed twice (same name and price)"
				/>
			)
		case 'delivery_menu_differs':
			return (
				<Plural
					value={n}
					one="# delivery menu differs from Menuza"
					other="# delivery menus differ from Menuza"
				/>
			)
	}
}

const CHECK_TITLES: Record<MenuHealthCheckKey, MessageDescriptor> = {
	zero_price: msg`Dishes priced at 0`,
	no_photo: msg`Dishes with no photo`,
	weak_photo: msg`Dishes with a weak photo`,
	no_description: msg`Dishes with no description`,
	missing_translation: msg`Dishes missing a translation`,
	no_allergens_or_calories: msg`Dishes without allergens or calories`,
	long_unavailable: msg`Dishes unavailable for a week`,
	empty_category: msg`Empty categories`,
	dishes_guests_cannot_see: msg`Dishes guests cannot see`,
	name_all_caps: msg`Dish names in capitals`,
	name_too_long: msg`Dish names that are too long`,
	empty_option_group: msg`Option groups with no choices`,
	impossible_minimum: msg`Option groups with an impossible minimum`,
	duplicate_item: msg`Dishes listed twice`,
	delivery_menu_differs: msg`Delivery menus out of sync`,
}

const CHECK_HINTS: Record<MenuHealthCheckKey, MessageDescriptor> = {
	zero_price: msg`A free dish is usually a mistake.`,
	no_photo: msg`Photos help guests choose.`,
	weak_photo: msg`Dark, blurry or small photos hurt orders. Fix them in the photo studio.`,
	no_description: msg`A short description helps guests order.`,
	missing_translation: msg`Guests reading another language see a gap.`,
	no_allergens_or_calories: msg`Guests look for allergens and calories.`,
	long_unavailable: msg`Hide it or bring it back.`,
	empty_category: msg`Guests see a heading with nothing under it.`,
	dishes_guests_cannot_see: msg`In no category, or only on a menu that is not published.`,
	name_all_caps: msg`Capitals read like shouting. Use normal case.`,
	name_too_long: msg`Long names get cut off on small screens.`,
	empty_option_group: msg`Guests are asked to choose and have nothing to pick.`,
	impossible_minimum: msg`Guests can never finish ordering this dish.`,
	duplicate_item: msg`Guests see the same dish twice.`,
	delivery_menu_differs: msg`Dishes, prices, or availability on a delivery platform differ from Menuza.`,
}

const DISMISS_LABELS: Partial<Record<MenuHealthCheckKey, MessageDescriptor>> = {
	no_photo: msg`No photo on purpose`,
	weak_photo: msg`Photo is fine`,
	no_description: msg`No description on purpose`,
	zero_price: msg`Price 0 on purpose`,
}

/** The photo studio opens on the weak photo with its issues filled in (#145). */
export function studioHref(
	orgSlug: string,
	photo: { assetId: string; issues: readonly string[] },
) {
	const query = new URLSearchParams({ studio: photo.assetId })
	if (photo.issues.length > 0) query.set('issues', photo.issues.join(','))
	return `/${orgSlug}/media?${query.toString()}`
}

function editHref(
	orgSlug: string,
	entityType: MenuHealthEntityType,
	id: string,
) {
	if (entityType === 'integration') {
		return `/${orgSlug}/settings/integrations`
	}
	const folder =
		entityType === 'category'
			? 'categories'
			: entityType === 'modifier_group'
				? 'modifiers'
				: 'items'
	return `/${orgSlug}/menu/${folder}/${id}`
}

const GRADE_VARIANT: Record<
	MenuHealthGrade,
	'success' | 'default' | 'warning' | 'destructive'
> = {
	A: 'success',
	B: 'default',
	C: 'warning',
	D: 'warning',
	F: 'destructive',
}

function GradeChip({ grade }: { grade: MenuHealthGrade }) {
	return (
		<Badge variant={GRADE_VARIANT[grade]}>
			<span className="sr-only">
				<Trans>Grade</Trans>{' '}
			</span>
			{grade}
		</Badge>
	)
}

/**
 * Where focus goes after a dismiss or restore removes the focused row: the
 * `data-focus-id` values to try in order. The card moves focus there once
 * the new health arrives.
 */
const FocusAfterActionContext = createContext<{
	current: string[] | null
} | null>(null)

const checkFocusId = (key: MenuHealthCheckKey) => `check:${key}`
const rowFocusId = (key: MenuHealthCheckKey, id: string) => `row:${key}:${id}`

/** Posts a dismiss or restore for one record and reports a failure. */
function useCheckAction(orgSlug: string) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data && !fetcher.data.ok) {
			toast.error(
				fetcher.data.error === 'not_failing'
					? _(t`This one already passes, so there is nothing to dismiss.`)
					: _(t`Could not update this check. Try again.`),
			)
		}
	}, [fetcher.state, fetcher.data, _])
	const submit = (body: MenuChecksBody) =>
		void fetcher.submit(body, {
			method: 'post',
			action: `/${orgSlug}/menu/checks`,
			encType: 'application/json',
		})
	return { submit, busy: fetcher.state !== 'idle' }
}

function RecordRow({
	orgSlug,
	check,
	record,
	canEdit,
	dismissed,
}: {
	orgSlug: string
	check: MenuHealthCheckSummary
	record: MenuHealthRecordRef
	canEdit: boolean
	dismissed: boolean
}) {
	const { _ } = useLingui()
	const { submit, busy } = useCheckAction(orgSlug)
	const focusAfter = useContext(FocusAfterActionContext)
	const hintId = useId()
	const name = record.name
	const dismissLabel = _(DISMISS_LABELS[check.key] ?? msg`Dismiss`)
	const buttonLabel = dismissed
		? _(t`Restore: ${name}`)
		: _(t`${dismissLabel}: ${name}`)
	return (
		<li className="flex items-center justify-between gap-2 py-0.5 text-sm">
			<Link
				to={editHref(orgSlug, check.entityType, record.id)}
				className="min-w-0 wrap-anywhere hover:underline"
			>
				{record.name}
			</Link>
			{record.photo && canEdit && !dismissed ? (
				<Link
					to={studioHref(orgSlug, record.photo)}
					className="text-primary shrink-0 text-xs hover:underline"
				>
					<Trans>Fix in photo studio</Trans>
				</Link>
			) : null}
			{canEdit && check.entityType !== 'integration' ? (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					data-focus-id={rowFocusId(check.key, record.id)}
					aria-label={buttonLabel}
					aria-describedby={dismissed ? undefined : hintId}
					onClick={(event) => {
						if (focusAfter) {
							const row = event.currentTarget.closest('li')
							const neighbour =
								row?.nextElementSibling ?? row?.previousElementSibling
							const neighbourId = neighbour
								?.querySelector('[data-focus-id]')
								?.getAttribute('data-focus-id')
							focusAfter.current = [
								...(neighbourId ? [neighbourId] : []),
								checkFocusId(check.key),
								'card',
							]
						}
						submit(
							dismissed
								? {
										intent: 'restore',
										checkKey: check.key,
										entityId: record.id,
									}
								: {
										intent: 'dismiss',
										checkKey: check.key,
										entityId: record.id,
										reason: 'on_purpose',
									},
						)
					}}
				>
					{dismissed ? <Trans>Restore</Trans> : dismissLabel}
				</Button>
			) : null}
			{canEdit && !dismissed ? (
				<span id={hintId} className="sr-only">
					<Trans>Stays dismissed until this changes.</Trans>
				</span>
			) : null}
		</li>
	)
}

function DismissedList({
	orgSlug,
	check,
	canEdit,
}: {
	orgSlug: string
	check: MenuHealthCheckSummary
	canEdit: boolean
}) {
	if (check.dismissedCount === 0) return null
	return (
		<Collapsible>
			<CollapsibleTrigger
				render={
					<Button variant="ghost" size="sm" className="text-muted-foreground" />
				}
			>
				<Icon name="chevron-right" className="size-4 rtl:rotate-180" />
				<Plural
					value={check.dismissedCount}
					one="# dismissed"
					other="# dismissed"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="ms-5">
					{check.dismissed.map((record) => (
						<RecordRow
							key={record.id}
							orgSlug={orgSlug}
							check={check}
							record={record}
							canEdit={canEdit}
							dismissed
						/>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	)
}

function CheckRow({
	orgSlug,
	check,
	canEdit,
}: {
	orgSlug: string
	check: MenuHealthCheckSummary
	canEdit: boolean
}) {
	const { _ } = useLingui()
	const total = check.count
	return (
		<Collapsible>
			<CollapsibleTrigger
				data-focus-id={checkFocusId(check.key)}
				render={
					<Button
						variant="ghost"
						className="h-auto w-full justify-start py-1.5 text-start font-normal whitespace-normal"
					/>
				}
			>
				<SeverityIcon severity={check.severity} />
				<span className="min-w-0 flex-1">
					<FixLabel check={check} />
				</span>
				<Icon
					name="chevron-down"
					className="text-muted-foreground size-4 shrink-0"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="ms-6 space-y-1 pb-2">
					<p className="text-muted-foreground text-xs">
						{_(CHECK_HINTS[check.key])}
					</p>
					<ul>
						{check.records.map((record) => (
							<RecordRow
								key={record.id}
								orgSlug={orgSlug}
								check={check}
								record={record}
								canEdit={canEdit}
								dismissed={false}
							/>
						))}
					</ul>
					{check.count > check.records.length ? (
						<Link
							to={fixHref(orgSlug, check.key)}
							className="text-primary text-sm hover:underline"
						>
							<Trans>See all {total}</Trans>
						</Link>
					) : null}
					{check.key === 'missing_translation' ? (
						<Link
							to={`/${orgSlug}/menu/translations`}
							className="text-primary block text-sm hover:underline"
						>
							<Trans>
								See every missing name and description, for options and
								categories too
							</Trans>
						</Link>
					) : null}
					{check.key === 'delivery_menu_differs' ? (
						<Link
							to={`/${orgSlug}/settings/integrations`}
							className="text-primary block text-sm hover:underline"
						>
							<Trans>Review differences in Integrations</Trans>
						</Link>
					) : null}
					<DismissedList orgSlug={orgSlug} check={check} canEdit={canEdit} />
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function fixHref(orgSlug: string, key: MenuHealthCheckKey) {
	const entityType = menuHealthEntityType(key)
	if (entityType === 'integration') {
		return `/${orgSlug}/settings/integrations`
	}
	const list =
		entityType === 'category'
			? 'categories'
			: entityType === 'modifier_group'
				? 'modifiers'
				: 'items'
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
	health: MenuHealthSummary
	orgSlug: string
	review?: MenuReviewSettings
}) {
	const { _ } = useLingui()
	const revalidator = useRevalidator()
	const [reviewOpen, setReviewOpen] = useState(false)
	const focusAfter = useRef<string[] | null>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	// After a dismiss or restore the focused row is gone; move focus on.
	useEffect(() => {
		const targets = focusAfter.current
		const root = contentRef.current
		if (!targets || !root) return
		for (const target of targets) {
			const element =
				target === 'card'
					? root
					: root.querySelector<HTMLElement>(`[data-focus-id="${target}"]`)
			if (element) {
				focusAfter.current = null
				element.focus()
				return
			}
		}
	}, [health])
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
	const canEdit = Boolean(review?.canEdit)
	// Checks that pass now but still hold dismissals, so they can be restored.
	const dismissedOnly = health.checks.filter(
		(check) => check.count === 0 && check.dismissedCount > 0,
	)
	const dismissedTotal = health.checks.reduce(
		(sum, check) => sum + check.dismissedCount,
		0,
	)
	const canReview =
		canEdit && fixes.some((check) => REVIEWABLE_CHECKS.has(check.key))

	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					<Trans>Menu health</Trans>
				</CardTitle>
				<CardDescription>
					{fixes.length === 0 ? (
						dismissedTotal > 0 ? (
							<Plural
								value={dismissedTotal}
								one="Nothing left to fix. # dismissed."
								other="Nothing left to fix. # dismissed."
							/>
						) : (
							<Trans>
								Every dish has a photo, a description and a price. Nice work.
							</Trans>
						)
					) : (
						<>
							<Plural
								value={health.fixCount}
								one="# thing to fix."
								other="# things to fix."
							/>{' '}
							<Trans>Finish these to help guests choose and order.</Trans>
						</>
					)}
				</CardDescription>
				<CardAction>
					<div className="flex items-center gap-2">
						<span className="text-2xl font-semibold tabular-nums">
							{health.score}
						</span>
						<span className="text-muted-foreground text-sm">/ 100</span>
						<GradeChip grade={health.grade} />
						<GradeLabel grade={health.grade} />
					</div>
				</CardAction>
			</CardHeader>
			<CardContent
				ref={contentRef}
				tabIndex={-1}
				className="space-y-3 outline-none"
			>
				<FocusAfterActionContext.Provider value={focusAfter}>
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
						<div className="space-y-1">
							{fixes.map((check) => (
								<CheckRow
									key={check.key}
									orgSlug={orgSlug}
									check={check}
									canEdit={canEdit}
								/>
							))}
						</div>
					)}
					{dismissedOnly.map((check) => (
						<div key={check.key}>
							<p className="text-muted-foreground text-xs">
								{_(CHECK_TITLES[check.key])}
							</p>
							<DismissedList
								orgSlug={orgSlug}
								check={check}
								canEdit={canEdit}
							/>
						</div>
					))}
				</FocusAfterActionContext.Provider>
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
		case 'weak_photo':
			return <Trans>Showing dishes with a weak photo</Trans>
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
		case 'dishes_guests_cannot_see':
			return <Trans>Showing dishes guests cannot see</Trans>
		case 'name_all_caps':
			return <Trans>Showing dishes with names in capitals</Trans>
		case 'name_too_long':
			return <Trans>Showing dishes with names over 60 characters</Trans>
		case 'empty_option_group':
			return <Trans>Showing option groups with no choices guests can see</Trans>
		case 'impossible_minimum':
			return (
				<Trans>
					Showing option groups that require more picks than they allow
				</Trans>
			)
		case 'duplicate_item':
			return <Trans>Showing dishes listed twice</Trans>
		case 'delivery_menu_differs':
			return <Trans>Showing delivery connections that differ from Menuza</Trans>
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
