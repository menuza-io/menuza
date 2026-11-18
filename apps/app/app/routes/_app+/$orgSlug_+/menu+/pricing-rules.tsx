import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { auditService, AuditAction } from '@repo/audit'
import { userHasOrganizationPermission } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	isNull,
	ne,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuPricingRule,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { currencyCodeForDataRegion } from '#app/utils/menu/bulk-apply.server.ts'
import {
	assertDraftInOrganization,
	draftFromBody,
	loadPreviewInput,
	loadPricingRuleRows,
	PREVIEW_ROWS_MAX,
	PRICING_RULES_MAX,
	PricingRuleBodySchema,
	type PricingRuleFormError,
} from '#app/utils/menu/pricing-rules.server.ts'
import {
	isRuleLive,
	parseIdList,
	previewPricingRule,
	roundingOf,
	type PreviewRow,
} from '#app/utils/menu/pricing-rules.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * Menu > Pricing rules (#388): +N% (or -N%) on chosen menus or categories at
 * chosen locations, rounded up, optionally skipping a price range. A rule
 * covers dishes added later, never changes a dish with a fixed location price,
 * and can be ended (prices go back to base). Every channel applies it with
 * `resolveMenuItemPrice` from `@repo/common/menu-pricing`.
 */

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
	})
	const userId = await requireMenuRead(request, organization.id)
	const [rows, menus, categories, locations, canEdit] = await Promise.all([
		loadPricingRuleRows(organization.id),
		db
			.select({ id: OrganizationMenu.id, name: OrganizationMenu.displayName })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.organizationId, organization.id),
					ne(OrganizationMenu.menuType, 'drop'),
				),
			)
			.orderBy(asc(OrganizationMenu.position)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				name: OrganizationMenuCategory.displayName,
			})
			.from(OrganizationMenuCategory)
			.where(
				and(
					eq(OrganizationMenuCategory.organizationId, organization.id),
					isNull(OrganizationMenuCategory.parentId),
				),
			)
			.orderBy(asc(OrganizationMenuCategory.position)),
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organization.id),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.name)),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_MENU_ANY,
		),
	])
	const locale = organization.siteDefaultLocale || 'en'
	const nameOf = (value: string) => getLocalizedMenuValue(value, locale, locale)
	const now = new Date()
	return {
		currency: currencyCodeForDataRegion(organization.dataRegion),
		canEdit,
		menus: menus.map((menu) => ({ id: menu.id, name: nameOf(menu.name) })),
		categories: categories.map((category) => ({
			id: category.id,
			name: nameOf(category.name),
		})),
		locations,
		rules: rows
			.slice()
			.reverse()
			.map((row) => ({
				id: row.id,
				name: row.name,
				percentBp: row.percentBp,
				menuIds: parseIdList(row.menuIds),
				categoryIds: parseIdList(row.categoryIds),
				locationIds: parseIdList(row.locationIds),
				rounding: roundingOf(row),
				excludeMinPrice: row.excludeMinPrice,
				excludeMaxPrice: row.excludeMaxPrice,
				live: isRuleLive(row, now),
				endedAt: row.endedAt ? row.endedAt.toISOString() : null,
			})),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})
	const userId = await requireMenuWrite(request, organization.id)
	let raw: unknown
	try {
		raw = await request.json()
	} catch {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}
	const parsed = PricingRuleBodySchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}
	const body = parsed.data

	if (body.intent === 'end') {
		const [ended] = await db
			.update(OrganizationMenuPricingRule)
			.set({ endedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(OrganizationMenuPricingRule.id, body.ruleId),
					eq(OrganizationMenuPricingRule.organizationId, organization.id),
					isNull(OrganizationMenuPricingRule.endedAt),
				),
			)
			.returning({ id: OrganizationMenuPricingRule.id })
		if (!ended) return Response.json({ error: 'not_found' }, { status: 404 })
		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId,
			organizationId: organization.id,
			resourceType: 'menu_pricing_rule',
			resourceId: ended.id,
			details: 'Ended a menu pricing rule',
			metadata: { change: 'ended' },
			request,
		})
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		return Response.json({ ok: true })
	}

	const draft = draftFromBody(body)
	if (!draft.ok) return Response.json({ error: draft.error }, { status: 422 })
	await assertDraftInOrganization(organization.id, draft.draft)

	if (body.intent === 'preview') {
		const input = await loadPreviewInput(organization.id)
		const locale = organization.siteDefaultLocale || 'en'
		const rows = previewPricingRule(draft.draft, input).map((row) => ({
			...row,
			name: getLocalizedMenuValue(row.name, locale, locale),
		}))
		return Response.json({
			preview: {
				total: rows.length,
				changed: rows.filter((row) => row.after !== row.before).length,
				rows: rows.slice(0, PREVIEW_ROWS_MAX),
			},
		})
	}

	if (!body.name)
		return Response.json({ error: 'name_required' }, { status: 422 })
	const live = (await loadPricingRuleRows(organization.id)).filter((row) =>
		isRuleLive(row, new Date()),
	)
	if (live.length >= PRICING_RULES_MAX) {
		return Response.json({ error: 'too_many_rules' }, { status: 422 })
	}
	const { rounding } = draft.draft
	const [created] = await db
		.insert(OrganizationMenuPricingRule)
		.values({
			organizationId: organization.id,
			name: body.name,
			percentBp: draft.draft.percentBp,
			menuIds: JSON.stringify(draft.draft.menuIds),
			categoryIds: JSON.stringify(draft.draft.categoryIds),
			locationIds: JSON.stringify(draft.draft.locationIds),
			roundingMode: rounding.mode,
			roundingValue:
				rounding.mode === 'decimals'
					? rounding.decimals
					: rounding.mode === 'amount'
						? rounding.amountMinor
						: 0,
			excludeMinPrice: draft.draft.excludeMinPrice,
			excludeMaxPrice: draft.draft.excludeMaxPrice,
		})
		.returning({ id: OrganizationMenuPricingRule.id })
	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'menu_pricing_rule',
		resourceId: created!.id,
		details: 'Created a menu pricing rule',
		metadata: {
			change: 'created',
			percentBp: draft.draft.percentBp,
			menuIds: draft.draft.menuIds,
			categoryIds: draft.draft.categoryIds,
			locationIds: draft.draft.locationIds,
			roundingMode: rounding.mode,
		},
		request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	return Response.json({ ok: true, id: created!.id })
}

const ERROR_MESSAGES: Record<
	PricingRuleFormError | 'invalid_body',
	MessageDescriptor
> = {
	name_required: msg`Give the rule a name.`,
	percent_invalid: msg`Enter a percentage between -90 and 500, not zero (for example 8 or -5).`,
	rounding_invalid: msg`Enter a round-up amount between 0.01 and 100.`,
	range_invalid: msg`Enter prices for the range to skip, with the lower one first.`,
	too_many_rules: msg`You have the most rules that can be on at once. End one first.`,
	invalid_body: msg`Something went wrong. Check the form and try again.`,
}

type PreviewData = { total: number; changed: number; rows: PreviewRow[] }

type Draft = {
	name: string
	percent: string
	menuIds: string[]
	categoryIds: string[]
	locationIds: string[]
	roundingMode: 'none' | 'decimals' | 'amount'
	roundingDecimals: 0 | 1
	roundingAmount: string
	excludeMin: string
	excludeMax: string
}

const EMPTY_DRAFT: Draft = {
	name: '',
	percent: '',
	menuIds: [],
	categoryIds: [],
	locationIds: [],
	roundingMode: 'none',
	roundingDecimals: 0,
	roundingAmount: '',
	excludeMin: '',
	excludeMax: '',
}

function toggle(list: string[], id: string, on: boolean) {
	return on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id)
}

export default function MenuPricingRules() {
	const { _, i18n } = useLingui()
	const { rules, menus, categories, locations, currency, canEdit } =
		useLoaderData<typeof loader>()
	const previewFetcher = useFetcher<{ preview?: PreviewData; error?: string }>()
	const saveFetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const endFetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
	const set = (patch: Partial<Draft>) =>
		setDraft((current) => ({ ...current, ...patch }))

	useEffect(() => {
		if (saveFetcher.state === 'idle' && saveFetcher.data?.ok)
			setDraft(EMPTY_DRAFT)
	}, [saveFetcher.state, saveFetcher.data])

	const money = (amount: number) =>
		new Intl.NumberFormat(i18n.locale, { style: 'currency', currency }).format(
			amount,
		)
	const percentText = (bp: number) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'percent',
			maximumFractionDigits: 2,
			signDisplay: 'always',
		}).format(bp / 10_000)
	const names = (ids: string[], list: Array<{ id: string; name: string }>) =>
		ids
			.map((id) => list.find((entry) => entry.id === id)?.name ?? '')
			.filter(Boolean)
	const locationName = (id: string) =>
		locations.find((entry) => entry.id === id)?.name ?? ''
	const submit = (
		fetcher: typeof previewFetcher,
		intent: 'preview' | 'create',
	) =>
		void fetcher.submit(
			{ intent, ...draft },
			{ method: 'post', encType: 'application/json' },
		)
	const errorText = (code?: string) =>
		code
			? _(
					ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES] ??
						ERROR_MESSAGES.invalid_body,
				)
			: null

	const roundingItems = [
		{ value: 'none', label: _(t`No rounding`) },
		{ value: 'decimals', label: _(t`Round up to decimals`) },
		{ value: 'amount', label: _(t`Round up to an amount`) },
	]
	const decimalsItems = [
		{ value: '0', label: _(t`Whole units (11.00)`) },
		{ value: '1', label: _(t`One decimal (10.90)`) },
	]
	const preview = previewFetcher.data?.preview
	const changedCount = preview?.changed ?? 0
	const totalCount = preview?.total ?? 0

	return (
		<div className="flex flex-col gap-6">
			{canEdit ? (
				<Card>
					<CardHeader>
						<CardTitle>
							<Trans>New pricing rule</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Raise or lower prices by a percentage on chosen menus or
								categories. Dishes added later follow the rule. A dish with its
								own location price keeps that price.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-5">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="rule-name">
									<Trans>Name</Trans>
								</Label>
								<Input
									id="rule-name"
									value={draft.name}
									maxLength={80}
									onChange={(event) => set({ name: event.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="rule-percent">
									<Trans>Change (%)</Trans>
								</Label>
								<Input
									id="rule-percent"
									inputMode="decimal"
									placeholder="8"
									value={draft.percent}
									onChange={(event) => set({ percent: event.target.value })}
								/>
							</div>
						</div>

						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Menus</Trans>
							</legend>
							<div className="flex flex-wrap gap-4">
								{menus.map((menu) => (
									<label
										key={menu.id}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={draft.menuIds.includes(menu.id)}
											onCheckedChange={(on) =>
												set({
													menuIds: toggle(draft.menuIds, menu.id, on === true),
												})
											}
										/>
										<span className="wrap-anywhere">{menu.name}</span>
									</label>
								))}
							</div>
						</fieldset>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Categories</Trans>
							</legend>
							<div className="flex flex-wrap gap-4">
								{categories.map((category) => (
									<label
										key={category.id}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={draft.categoryIds.includes(category.id)}
											onCheckedChange={(on) =>
												set({
													categoryIds: toggle(
														draft.categoryIds,
														category.id,
														on === true,
													),
												})
											}
										/>
										<span className="wrap-anywhere">{category.name}</span>
									</label>
								))}
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Choose no menu and no category to cover every dish.
								</Trans>
							</p>
						</fieldset>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Locations</Trans>
							</legend>
							<div className="flex flex-wrap gap-4">
								{locations.map((location) => (
									<label
										key={location.id}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={draft.locationIds.includes(location.id)}
											onCheckedChange={(on) =>
												set({
													locationIds: toggle(
														draft.locationIds,
														location.id,
														on === true,
													),
												})
											}
										/>
										<span className="wrap-anywhere">{location.name}</span>
									</label>
								))}
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>Choose no location to cover every location.</Trans>
							</p>
						</fieldset>

						<div className="grid gap-4 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label>
									<Trans>Rounding</Trans>
								</Label>
								<Select
									value={draft.roundingMode}
									items={roundingItems}
									onValueChange={(value) =>
										set({
											roundingMode: (value ?? 'none') as Draft['roundingMode'],
										})
									}
								>
									<SelectTrigger aria-label={_(t`Rounding`)}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{roundingItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{draft.roundingMode === 'decimals' ? (
								<div className="space-y-1.5">
									<Label>
										<Trans>Decimals</Trans>
									</Label>
									<Select
										value={String(draft.roundingDecimals)}
										items={decimalsItems}
										onValueChange={(value) =>
											set({ roundingDecimals: value === '1' ? 1 : 0 })
										}
									>
										<SelectTrigger aria-label={_(t`Decimals`)}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{decimalsItems.map((item) => (
												<SelectItem key={item.value} value={item.value}>
													{item.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							) : null}
							{draft.roundingMode === 'amount' ? (
								<div className="space-y-1.5">
									<Label htmlFor="rule-round-amount">
										<Trans>Round up to</Trans>
									</Label>
									<Input
										id="rule-round-amount"
										inputMode="decimal"
										placeholder="0.25"
										value={draft.roundingAmount}
										onChange={(event) =>
											set({ roundingAmount: event.target.value })
										}
									/>
								</div>
							) : null}
						</div>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="rule-exclude-min">
									<Trans>Skip prices from</Trans>
								</Label>
								<Input
									id="rule-exclude-min"
									inputMode="decimal"
									value={draft.excludeMin}
									onChange={(event) => set({ excludeMin: event.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="rule-exclude-max">
									<Trans>Skip prices up to</Trans>
								</Label>
								<Input
									id="rule-exclude-max"
									inputMode="decimal"
									value={draft.excludeMax}
									onChange={(event) => set({ excludeMax: event.target.value })}
								/>
							</div>
						</div>

						{errorText(
							previewFetcher.data?.error ?? saveFetcher.data?.error,
						) ? (
							<p role="alert" className="text-destructive text-sm">
								{errorText(
									previewFetcher.data?.error ?? saveFetcher.data?.error,
								)}
							</p>
						) : null}

						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								disabled={previewFetcher.state !== 'idle'}
								onClick={() => submit(previewFetcher, 'preview')}
							>
								<Trans>Preview prices</Trans>
							</Button>
							<Button
								disabled={!preview || saveFetcher.state !== 'idle'}
								onClick={() => submit(saveFetcher, 'create')}
							>
								<Trans>Save rule</Trans>
							</Button>
						</div>

						{preview ? (
							<div
								className="flex flex-col gap-2"
								data-testid="pricing-preview"
							>
								<p className="text-sm">
									<Trans>
										{changedCount} of {totalCount} prices change.
									</Trans>
								</p>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>
												<Trans>Dish</Trans>
											</TableHead>
											<TableHead>
												<Trans>Location</Trans>
											</TableHead>
											<TableHead>
												<Trans>Now</Trans>
											</TableHead>
											<TableHead>
												<Trans>With the rule</Trans>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{preview.rows.map((row) => (
											<TableRow key={`${row.locationId}:${row.itemId}`}>
												<TableCell className="wrap-anywhere">
													{row.name}
												</TableCell>
												<TableCell className="wrap-anywhere">
													{locationName(row.locationId)}
												</TableCell>
												<TableCell className="tabular-nums">
													{money(row.before)}
												</TableCell>
												<TableCell className="tabular-nums">
													{money(row.after)}
													{row.unchanged === 'fixed_price' ? (
														<span className="text-muted-foreground ms-2 text-xs">
															<Trans>Own location price</Trans>
														</span>
													) : row.unchanged === 'excluded_range' ? (
														<span className="text-muted-foreground ms-2 text-xs">
															<Trans>Skipped price range</Trans>
														</span>
													) : null}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						) : null}
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Rules</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							One rule prices a dish: a category rule first, then a menu rule,
							then a rule for every dish. Ending a rule returns prices to base.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{rules.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No pricing rules yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Rule</Trans>
									</TableHead>
									<TableHead>
										<Trans>Covers</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead>
										<span className="sr-only">
											<Trans>Actions</Trans>
										</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rules.map((rule) => {
									const scope = [
										...names(rule.menuIds, menus),
										...names(rule.categoryIds, categories),
									]
									const where = names(rule.locationIds, locations)
									return (
										<TableRow key={rule.id}>
											<TableCell className="wrap-anywhere">
												{rule.name} · {percentText(rule.percentBp)}
											</TableCell>
											<TableCell className="wrap-anywhere">
												{scope.length ? scope.join(', ') : _(t`Every dish`)} ·{' '}
												{where.length ? where.join(', ') : _(t`Every location`)}
											</TableCell>
											<TableCell>
												{rule.live ? (
													<Badge variant="success">
														<Trans>On</Trans>
													</Badge>
												) : (
													<Badge variant="secondary">
														<Trans>Ended</Trans>
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-end">
												{canEdit && rule.live ? (
													<Button
														variant="outline"
														size="sm"
														disabled={endFetcher.state !== 'idle'}
														onClick={() =>
															void endFetcher.submit(
																{ intent: 'end', ruleId: rule.id },
																{ method: 'post', encType: 'application/json' },
															)
														}
													>
														<Trans>End rule</Trans>
													</Button>
												) : null}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
