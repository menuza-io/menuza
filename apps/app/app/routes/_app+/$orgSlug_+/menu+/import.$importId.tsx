import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import { db, eq, OrganizationMenuItem } from '@repo/database'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Spinner } from '@repo/ui/spinner'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
	useRevalidator,
} from 'react-router'
import { z } from 'zod'
import { currencyCodeForDataRegion } from '#app/utils/menu/bulk-apply.server.ts'
import {
	isMenuImportKillSwitchOn,
	requireMenuImportAccess,
} from '#app/utils/menu/import/access.server.ts'
import {
	applyMenuImport,
	type ApplyMenuImportResult,
} from '#app/utils/menu/import/apply.server.ts'
import {
	hasCurrencyMismatch,
	type MenuImportDraft,
	menuImportDraftSchema,
	MENU_IMPORT_MISSING_EXISTING_ACTIONS,
	type MenuImportMissingExistingAction,
	normalizeMatchName,
	pickDraftText,
} from '#app/utils/menu/import/schema.ts'
import {
	cancelMenuImport,
	loadMenuImportForOrg,
	saveMenuImportDraft,
} from '#app/utils/menu/import/service.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	await requireMenuImportAccess(request, organization.id)

	const importId = params.importId
	if (!importId) {
		throw new Response('Not Found', { status: 404 })
	}

	const loaded = await loadMenuImportForOrg({
		importId,
		organizationId: organization.id,
	})
	if (!loaded) {
		throw new Response('Not Found', { status: 404 })
	}

	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)

	const rawExistingItems = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			price: OrganizationMenuItem.price,
			availabilityStatus: OrganizationMenuItem.availabilityStatus,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organization.id))

	const existingItems = rawExistingItems.map((item) => {
		const parsedName = parseLocalizedString(item.displayName, defaultLocale)
		const label =
			parsedName[defaultLocale] ||
			parsedName.en ||
			parsedName.ar ||
			Object.values(parsedName)[0] ||
			item.id
		return {
			id: item.id,
			label,
			price: item.price,
			availabilityStatus: item.availabilityStatus,
			matchKeys: Object.values(parsedName)
				.filter((v): v is string => Boolean(v))
				.map(normalizeMatchName),
		}
	})

	return {
		orgSlug: organization.slug,
		orgCurrency: currencyCodeForDataRegion(organization.dataRegion),
		orgLocales: locales,
		defaultLocale,
		record: loaded.record,
		draft: loaded.draft,
		existingItems,
		disabled: isMenuImportKillSwitchOn(),
	}
}

const ActionBodySchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('cancel') }),
	z.object({
		intent: z.literal('save'),
		draft: menuImportDraftSchema,
	}),
	z.object({
		intent: z.literal('apply'),
		draft: menuImportDraftSchema,
		publishNow: z.boolean().default(false),
		missingExistingAction: z
			.enum(MENU_IMPORT_MISSING_EXISTING_ACTIONS)
			.default('keep'),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const userId = await requireMenuImportAccess(request, organization.id)

	if (isMenuImportKillSwitchOn()) {
		return Response.json(
			{ ok: false, error: 'menu_import_disabled' },
			{ status: 503 },
		)
	}

	const importId = params.importId
	if (!importId) {
		return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
	}

	let rawBody: unknown
	const contentType = request.headers.get('content-type') || ''
	if (contentType.includes('application/json')) {
		rawBody = await request.json().catch(() => null)
	} else {
		const formData = await request.formData()
		const intent = String(formData.get('intent') ?? '')
		if (intent === 'cancel') {
			rawBody = { intent: 'cancel' }
		} else {
			const draftRaw = String(formData.get('draft') ?? '')
			let parsedDraft: unknown = null
			try {
				parsedDraft = JSON.parse(draftRaw)
			} catch {
				parsedDraft = null
			}
			rawBody = {
				intent,
				draft: parsedDraft,
				publishNow: formData.get('publishNow') === 'true',
				missingExistingAction: String(
					formData.get('missingExistingAction') ?? 'keep',
				),
			}
		}
	}

	const parsed = ActionBodySchema.safeParse(rawBody)
	if (!parsed.success) {
		return Response.json({ ok: false, error: 'invalid_draft' }, { status: 400 })
	}

	if (parsed.data.intent === 'cancel') {
		const result = await cancelMenuImport({
			importId,
			organizationId: organization.id,
		})
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error },
				{ status: result.status },
			)
		}
		return Response.json({ ok: true, cancelled: true })
	}

	if (parsed.data.intent === 'save') {
		const saved = await saveMenuImportDraft({
			importId,
			organizationId: organization.id,
			draft: parsed.data.draft,
		})
		if (!saved.ok) {
			return Response.json(
				{ ok: false, error: saved.error },
				{ status: saved.status },
			)
		}
		return Response.json({ ok: true, saved: true })
	}

	await saveMenuImportDraft({
		importId,
		organizationId: organization.id,
		draft: parsed.data.draft,
	})

	const applied = await applyMenuImport({
		importId,
		organizationId: organization.id,
		organizationSlug: organization.slug,
		userId,
		draft: parsed.data.draft,
		publishNow: parsed.data.publishNow,
		missingExistingAction: parsed.data.missingExistingAction,
		request,
	})

	if (!applied.ok) {
		return Response.json(
			{ ok: false, error: applied.error, message: applied.message },
			{ status: applied.status },
		)
	}

	return Response.json({ ok: true, applied })
}

const IMPORT_ERRORS: Record<string, MessageDescriptor> = {
	url_not_allowed: msg`That URL cannot be fetched. Paste a public HTTPS website address.`,
	fetch_failed: msg`Could not reach that URL or the response exceeded the 10 MB / 20 second limit.`,
	unsupported_file: msg`Unsupported file format.`,
	nothing_found: msg`We couldn't find any menu items there. Try uploading a PDF or a photo of your printed menu.`,
	model_invalid: msg`The extracted menu could not be validated. Try a clearer photo, PDF, or CSV.`,
	extract_failed: msg`Something went wrong reading that menu. Please try again.`,
	menu_import_disabled: msg`Menu import is temporarily switched off.`,
	invalid_draft: msg`Check that every included dish has a name and a non-negative price.`,
	apply_failed: msg`Could not apply the menu import.`,
}

const NEW_DISH_VALUE = '__new__'

export default function MenuImportReviewPage() {
	const { _ } = useLingui()
	const {
		orgSlug,
		orgCurrency,
		orgLocales,
		defaultLocale,
		record,
		draft: initialDraft,
		existingItems,
		disabled,
	} = useLoaderData<typeof loader>()
	const revalidator = useRevalidator()
	const saveFetcher = useFetcher<{
		ok?: boolean
		saved?: boolean
		error?: string
	}>()
	const applyFetcher = useFetcher<{
		ok?: boolean
		applied?: ApplyMenuImportResult
		error?: string
		message?: string
	}>()
	const cancelFetcher = useFetcher<{ ok?: boolean; error?: string }>()

	const existingByKey = useMemo(() => {
		const map = new Map<string, string>()
		for (const item of existingItems) {
			for (const key of item.matchKeys) {
				if (key && !map.has(key)) map.set(key, item.id)
			}
		}
		return map
	}, [existingItems])

	const [draft, setDraft] = useState<MenuImportDraft | null>(() => {
		if (!initialDraft) return null
		return {
			...initialDraft,
			menus: initialDraft.menus.map((menu) => ({
				...menu,
				categories: menu.categories.map((category) => ({
					...category,
					items: category.items.map((item) => {
						if (item.matchExistingItemId) return item
						const byEn = item.name.en
							? existingByKey.get(normalizeMatchName(item.name.en))
							: undefined
						const byAr = item.name.ar
							? existingByKey.get(normalizeMatchName(item.name.ar))
							: undefined
						return {
							...item,
							matchExistingItemId: byEn ?? byAr ?? null,
						}
					}),
				})),
			})),
		}
	})

	useEffect(() => {
		if (initialDraft && !draft) {
			setDraft(initialDraft)
		}
	}, [initialDraft, draft])

	useEffect(() => {
		if (record.status !== 'queued' && record.status !== 'running') return
		const interval = setInterval(() => {
			if (revalidator.state === 'idle') {
				void revalidator.revalidate()
			}
		}, 2000)
		return () => clearInterval(interval)
	}, [record.status, revalidator])

	const [publishNow, setPublishNow] = useState(false)
	const [missingExistingAction, setMissingExistingAction] =
		useState<MenuImportMissingExistingAction>('keep')

	const showEnglish = orgLocales.includes('en') || defaultLocale === 'en'
	const showArabic = orgLocales.includes('ar') || defaultLocale === 'ar'

	const matchSelectItems = useMemo(
		() => [
			{ value: NEW_DISH_VALUE, label: _(t`Add as new dish`) },
			...existingItems.map((item) => {
				const name = item.label
				return {
					value: item.id,
					label: _(t`Update: ${name}`),
				}
			}),
		],
		[existingItems, _],
	)

	if (record.status === 'queued' || record.status === 'running') {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Spinner className="size-4" />
						<Trans>Reading your menu…</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							This runs in the background. You can leave this page and return
							anytime.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-3">
					<Button
						variant="outline"
						disabled={cancelFetcher.state !== 'idle'}
						onClick={() =>
							void cancelFetcher.submit(
								{ intent: 'cancel' },
								{ method: 'post', encType: 'application/json' },
							)
						}
					>
						<Trans>Cancel import</Trans>
					</Button>
					<Button
						variant="ghost"
						render={<Link to={`/${orgSlug}/menu/import`} />}
					>
						<Trans>Back to imports</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}

	if (record.status === 'failed') {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Menu import could not finish</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Alert variant="destructive">
						<Icon name="circle-alert" className="size-4" />
						<AlertTitle>
							<Trans>Import failed</Trans>
						</AlertTitle>
						<AlertDescription>
							{_(
								IMPORT_ERRORS[record.error ?? 'extract_failed'] ??
									IMPORT_ERRORS.extract_failed!,
							)}
						</AlertDescription>
					</Alert>
					<div>
						<Button render={<Link to={`/${orgSlug}/menu/import`} />}>
							<Trans>Try another source</Trans>
						</Button>
					</div>
				</CardContent>
			</Card>
		)
	}

	if (record.status === 'cancelled') {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Import cancelled</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>No changes were made to your menu.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button render={<Link to={`/${orgSlug}/menu/import`} />}>
						<Trans>Start a new import</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}

	if (record.status === 'applied' || applyFetcher.data?.ok) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Menu import applied</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							A before-import snapshot was saved in Menu History. Review your
							imported dishes and publish when ready.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-3">
					<Button render={<Link to={`/${orgSlug}/menu/items`} />}>
						<Trans>View items</Trans>
					</Button>
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/menu/menus`} />}
					>
						<Trans>View menus</Trans>
					</Button>
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/menu/history`} />}
					>
						<Trans>Menu history</Trans>
					</Button>
					<Button
						variant="ghost"
						render={<Link to={`/${orgSlug}/menu/import`} />}
					>
						<Trans>Back to imports</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}

	if (!draft) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Draft not available</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<Button render={<Link to={`/${orgSlug}/menu/import`} />}>
						<Trans>Back to imports</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}

	const currencyMismatch = hasCurrencyMismatch(
		draft.detectedCurrency,
		orgCurrency,
	)
	const detectedCurrency = draft.detectedCurrency

	const updateMenu = (
		menuIndex: number,
		updater: (
			menu: MenuImportDraft['menus'][number],
		) => MenuImportDraft['menus'][number],
	) => {
		setDraft((prev) =>
			prev
				? {
						...prev,
						menus: prev.menus.map((m, idx) =>
							idx === menuIndex ? updater(m) : m,
						),
					}
				: prev,
		)
	}

	const updateCategory = (
		menuIndex: number,
		catIndex: number,
		updater: (
			cat: MenuImportDraft['menus'][number]['categories'][number],
		) => MenuImportDraft['menus'][number]['categories'][number],
	) => {
		updateMenu(menuIndex, (menu) => ({
			...menu,
			categories: menu.categories.map((c, idx) =>
				idx === catIndex ? updater(c) : c,
			),
		}))
	}

	const updateItem = (
		menuIndex: number,
		catIndex: number,
		itemIndex: number,
		updater: (
			item: MenuImportDraft['menus'][number]['categories'][number]['items'][number],
		) => MenuImportDraft['menus'][number]['categories'][number]['items'][number],
	) => {
		updateCategory(menuIndex, catIndex, (category) => ({
			...category,
			items: category.items.map((it, idx) =>
				idx === itemIndex ? updater(it) : it,
			),
		}))
	}

	const actionError =
		applyFetcher.data?.error ??
		saveFetcher.data?.error ??
		cancelFetcher.data?.error

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold">
						<Trans>Review extracted menu</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Edit names or prices, untick rows to skip them, or match to an
							existing dish. Allergens and calories are never imported.
						</Trans>
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{detectedCurrency ? (
						<Badge variant="outline">
							<Trans>Currency: {detectedCurrency}</Trans>
						</Badge>
					) : null}
					<Badge variant="secondary">
						<Trans>Org currency: {orgCurrency}</Trans>
					</Badge>
				</div>
			</div>

			{currencyMismatch && detectedCurrency ? (
				<Alert>
					<Icon name="alert-triangle" className="size-4" />
					<AlertTitle>
						<Trans>Currency mismatch</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Detected currency {detectedCurrency} differs from your
							organization currency {orgCurrency}. Prices are shown as extracted
							and will not be converted.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{actionError ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" className="size-4" />
					<AlertTitle>
						<Trans>Action failed</Trans>
					</AlertTitle>
					<AlertDescription>
						{applyFetcher.data?.message ??
							_(IMPORT_ERRORS[actionError] ?? IMPORT_ERRORS.apply_failed!)}
					</AlertDescription>
				</Alert>
			) : null}

			{saveFetcher.data?.saved ? (
				<Alert>
					<Icon name="check-circle" className="size-4" />
					<AlertTitle>
						<Trans>Draft saved</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>Your edits are saved. Apply when ready.</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{draft.imageSuggestions.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>
							<Trans>Images found on page (suggestions only)</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								These images were found on the source page and are not attached
								automatically.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ul className="flex flex-col gap-1.5 text-sm">
							{draft.imageSuggestions.map((img) => (
								<li
									key={img.url}
									className="text-muted-foreground wrap-anywhere"
								>
									<a
										href={img.url}
										target="_blank"
										rel="noopener noreferrer"
										className="text-foreground underline underline-offset-2"
									>
										{img.alt || img.url}
									</a>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}

			{draft.menus.map((menu, menuIndex) => (
				<Card key={menu.id}>
					<CardHeader className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center gap-3">
							<Checkbox
								checked={menu.included}
								onCheckedChange={(checked) =>
									updateMenu(menuIndex, (m) => ({
										...m,
										included: checked === true,
									}))
								}
							/>
							<Badge variant="outline">
								<Trans>Menu</Trans>
							</Badge>
							{showEnglish ? (
								<Input
									aria-label={_(t`Menu name (English)`)}
									value={menu.name.en ?? ''}
									placeholder={_(t`Menu name (English)`)}
									className="max-w-xs"
									onChange={(event) =>
										updateMenu(menuIndex, (m) => ({
											...m,
											name: { ...m.name, en: event.target.value },
										}))
									}
								/>
							) : null}
							{showArabic ? (
								<Input
									aria-label={_(t`Menu name (Arabic)`)}
									dir="rtl"
									value={menu.name.ar ?? ''}
									placeholder={_(t`Menu name (Arabic)`)}
									className="max-w-xs"
									onChange={(event) =>
										updateMenu(menuIndex, (m) => ({
											...m,
											name: { ...m.name, ar: event.target.value },
										}))
									}
								/>
							) : null}
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-6">
						{menu.categories.map((category, catIndex) => (
							<div
								key={category.id}
								className="border-border flex flex-col gap-4 rounded-lg border p-4"
							>
								<div className="flex flex-wrap items-center gap-3">
									<Checkbox
										checked={category.included}
										onCheckedChange={(checked) =>
											updateCategory(menuIndex, catIndex, (c) => ({
												...c,
												included: checked === true,
											}))
										}
									/>
									<Badge variant="secondary">
										<Trans>Category</Trans>
									</Badge>
									{showEnglish ? (
										<Input
											aria-label={_(t`Category name (English)`)}
											value={category.name.en ?? ''}
											placeholder={_(t`Category name (English)`)}
											className="max-w-xs"
											onChange={(event) =>
												updateCategory(menuIndex, catIndex, (c) => ({
													...c,
													name: { ...c.name, en: event.target.value },
												}))
											}
										/>
									) : null}
									{showArabic ? (
										<Input
											aria-label={_(t`Category name (Arabic)`)}
											dir="rtl"
											value={category.name.ar ?? ''}
											placeholder={_(t`Category name (Arabic)`)}
											className="max-w-xs"
											onChange={(event) =>
												updateCategory(menuIndex, catIndex, (c) => ({
													...c,
													name: { ...c.name, ar: event.target.value },
												}))
											}
										/>
									) : null}
								</div>

								<div className="flex flex-col gap-3">
									{category.items.map((item, itemIndex) => {
										const isLowConfidence =
											item.confidence === 'low' ||
											item.lowConfidenceFields.length > 0
										return (
											<div
												key={item.id}
												className={
													isLowConfidence
														? 'border-warning bg-warning/5 flex flex-col gap-3 rounded-md border p-3'
														: 'border-border flex flex-col gap-3 rounded-md border p-3'
												}
											>
												<div className="flex flex-wrap items-center justify-between gap-2">
													<div className="flex flex-wrap items-center gap-2">
														<Checkbox
															checked={item.included}
															onCheckedChange={(checked) =>
																updateItem(
																	menuIndex,
																	catIndex,
																	itemIndex,
																	(it) => ({
																		...it,
																		included: checked === true,
																	}),
																)
															}
														/>
														<span className="text-sm font-medium wrap-anywhere">
															{pickDraftText(item.name, defaultLocale) ||
																_(t`Untitled dish`)}
														</span>
														{isLowConfidence ? (
															<Badge variant="warning">
																<Trans>Low confidence</Trans>
															</Badge>
														) : null}
													</div>

													<div className="w-60">
														<Select
															value={item.matchExistingItemId ?? NEW_DISH_VALUE}
															items={matchSelectItems}
															onValueChange={(value) =>
																updateItem(
																	menuIndex,
																	catIndex,
																	itemIndex,
																	(it) => ({
																		...it,
																		matchExistingItemId:
																			!value || value === NEW_DISH_VALUE
																				? null
																				: value,
																	}),
																)
															}
														>
															<SelectTrigger
																aria-label={_(t`Match existing dish`)}
																className="w-full"
															>
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{matchSelectItems.map((opt) => (
																	<SelectItem key={opt.value} value={opt.value}>
																		{opt.label}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													</div>
												</div>

												<div className="grid gap-3 md:grid-cols-3">
													{showEnglish ? (
														<div className="space-y-1">
															<Label>
																<Trans>Name (English)</Trans>
															</Label>
															<Input
																value={item.name.en ?? ''}
																onChange={(event) =>
																	updateItem(
																		menuIndex,
																		catIndex,
																		itemIndex,
																		(it) => ({
																			...it,
																			name: {
																				...it.name,
																				en: event.target.value,
																			},
																		}),
																	)
																}
															/>
														</div>
													) : null}
													{showArabic ? (
														<div className="space-y-1">
															<Label>
																<Trans>Name (Arabic)</Trans>
															</Label>
															<Input
																dir="rtl"
																value={item.name.ar ?? ''}
																onChange={(event) =>
																	updateItem(
																		menuIndex,
																		catIndex,
																		itemIndex,
																		(it) => ({
																			...it,
																			name: {
																				...it.name,
																				ar: event.target.value,
																			},
																		}),
																	)
																}
															/>
														</div>
													) : null}
													<div className="space-y-1">
														<Label>
															<Trans>Price</Trans>
														</Label>
														<Input
															type="number"
															min={0}
															step="0.01"
															value={item.price}
															onChange={(event) => {
																const parsedPrice = Number(event.target.value)
																updateItem(
																	menuIndex,
																	catIndex,
																	itemIndex,
																	(it) => ({
																		...it,
																		price:
																			Number.isFinite(parsedPrice) &&
																			parsedPrice >= 0
																				? parsedPrice
																				: 0,
																		lowConfidenceFields:
																			it.lowConfidenceFields.filter(
																				(f) => f !== 'price',
																			),
																	}),
																)
															}}
														/>
													</div>
												</div>

												<div className="grid gap-3 md:grid-cols-2">
													{showEnglish ? (
														<div className="space-y-1">
															<Label>
																<Trans>Description (English)</Trans>
															</Label>
															<Textarea
																rows={2}
																value={item.description.en ?? ''}
																onChange={(event) =>
																	updateItem(
																		menuIndex,
																		catIndex,
																		itemIndex,
																		(it) => ({
																			...it,
																			description: {
																				...it.description,
																				en: event.target.value,
																			},
																		}),
																	)
																}
															/>
														</div>
													) : null}
													{showArabic ? (
														<div className="space-y-1">
															<Label>
																<Trans>Description (Arabic)</Trans>
															</Label>
															<Textarea
																rows={2}
																dir="rtl"
																value={item.description.ar ?? ''}
																onChange={(event) =>
																	updateItem(
																		menuIndex,
																		catIndex,
																		itemIndex,
																		(it) => ({
																			...it,
																			description: {
																				...it.description,
																				ar: event.target.value,
																			},
																		}),
																	)
																}
															/>
														</div>
													) : null}
												</div>

												{item.sizes.length > 0 ? (
													<div className="space-y-2">
														<Label>
															<Trans>Sizes</Trans>
														</Label>
														<div className="flex flex-wrap gap-2">
															{item.sizes.map((size, sizeIndex) => (
																<div
																	key={size.id}
																	className="border-border flex items-center gap-2 rounded border p-2"
																>
																	<Input
																		aria-label={_(t`Size name`)}
																		className="w-28"
																		value={size.name.en ?? size.name.ar ?? ''}
																		onChange={(event) =>
																			updateItem(
																				menuIndex,
																				catIndex,
																				itemIndex,
																				(it) => ({
																					...it,
																					sizes: it.sizes.map((s, sIdx) =>
																						sIdx === sizeIndex
																							? {
																									...s,
																									name: {
																										...s.name,
																										[defaultLocale === 'ar'
																											? 'ar'
																											: 'en']:
																											event.target.value,
																									},
																								}
																							: s,
																					),
																				}),
																			)
																		}
																	/>
																	<Input
																		aria-label={_(t`Size price`)}
																		type="number"
																		min={0}
																		step="0.01"
																		className="w-24"
																		value={size.price}
																		onChange={(event) => {
																			const nextPrice = Number(
																				event.target.value,
																			)
																			updateItem(
																				menuIndex,
																				catIndex,
																				itemIndex,
																				(it) => ({
																					...it,
																					sizes: it.sizes.map((s, sIdx) =>
																						sIdx === sizeIndex
																							? {
																									...s,
																									price:
																										Number.isFinite(
																											nextPrice,
																										) && nextPrice >= 0
																											? nextPrice
																											: 0,
																								}
																							: s,
																					),
																				}),
																			)
																		}}
																	/>
																</div>
															))}
														</div>
													</div>
												) : null}

												{item.modifierGroups.length > 0 ? (
													<div className="space-y-2">
														<Label>
															<Trans>Modifier groups</Trans>
														</Label>
														<div className="flex flex-col gap-2">
															{item.modifierGroups.map((group, groupIndex) => (
																<div
																	key={group.id}
																	className="border-border rounded border p-2.5 text-sm"
																>
																	<div className="flex items-center gap-2 font-medium">
																		<Checkbox
																			checked={group.included}
																			onCheckedChange={(checked) =>
																				updateItem(
																					menuIndex,
																					catIndex,
																					itemIndex,
																					(it) => ({
																						...it,
																						modifierGroups:
																							it.modifierGroups.map(
																								(g, gIdx) =>
																									gIdx === groupIndex
																										? {
																												...g,
																												included:
																													checked === true,
																											}
																										: g,
																							),
																					}),
																				)
																			}
																		/>
																		<span className="wrap-anywhere">
																			{pickDraftText(group.name, defaultLocale)}
																		</span>
																	</div>
																	<ul className="mt-2 flex flex-wrap gap-3 pl-6">
																		{group.options.map((opt, optIndex) => (
																			<li
																				key={opt.id}
																				className="flex items-center gap-1.5"
																			>
																				<Checkbox
																					checked={opt.included}
																					onCheckedChange={(checked) =>
																						updateItem(
																							menuIndex,
																							catIndex,
																							itemIndex,
																							(it) => ({
																								...it,
																								modifierGroups:
																									it.modifierGroups.map(
																										(g, gIdx) =>
																											gIdx === groupIndex
																												? {
																														...g,
																														options:
																															g.options.map(
																																(o, oIdx) =>
																																	oIdx ===
																																	optIndex
																																		? {
																																				...o,
																																				included:
																																					checked ===
																																					true,
																																			}
																																		: o,
																															),
																													}
																												: g,
																									),
																							}),
																						)
																					}
																				/>
																				<span>
																					{pickDraftText(
																						opt.name,
																						defaultLocale,
																					)}{' '}
																					({opt.price})
																				</span>
																			</li>
																		))}
																	</ul>
																</div>
															))}
														</div>
													</div>
												) : null}
											</div>
										)
									})}
								</div>
							</div>
						))}
					</CardContent>
				</Card>
			))}

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Apply options</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							A snapshot is taken automatically before applying so you can undo
							anytime in Menu History.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					<div className="space-y-2">
						<Label>
							<Trans>Existing dishes not in this import</Trans>
						</Label>
						<RadioGroup
							value={missingExistingAction}
							onValueChange={(value) =>
								setMissingExistingAction(
									value as MenuImportMissingExistingAction,
								)
							}
							className="grid gap-3 sm:grid-cols-2"
						>
							<ChoiceCard>
								<RadioGroupItem value="keep" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>Keep existing dishes</Trans>
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										<Trans>
											Leave existing dishes that are not in this import as they
											are.
										</Trans>
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
							<ChoiceCard>
								<RadioGroupItem value="mark_unavailable" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>Mark missing dishes unavailable</Trans>
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										<Trans>
											Mark existing dishes that were not part of this import as
											unavailable.
										</Trans>
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
						</RadioGroup>
					</div>

					<label className="flex items-center gap-2 text-sm">
						<Checkbox
							checked={publishNow}
							onCheckedChange={(checked) => setPublishNow(checked === true)}
						/>
						<span>
							<Trans>
								Publish now (otherwise imported menus and dishes start
								unavailable)
							</Trans>
						</span>
					</label>

					<div className="flex flex-wrap items-center gap-3">
						<Button
							disabled={disabled || applyFetcher.state !== 'idle'}
							onClick={() =>
								void applyFetcher.submit(
									{
										intent: 'apply',
										draft,
										publishNow,
										missingExistingAction,
									} as never,
									{ method: 'post', encType: 'application/json' },
								)
							}
						>
							{applyFetcher.state !== 'idle' ? (
								<Trans>Applying…</Trans>
							) : (
								<Trans>Apply import</Trans>
							)}
						</Button>
						<Button
							variant="outline"
							disabled={disabled || saveFetcher.state !== 'idle'}
							onClick={() =>
								void saveFetcher.submit({ intent: 'save', draft } as never, {
									method: 'post',
									encType: 'application/json',
								})
							}
						>
							<Trans>Save draft</Trans>
						</Button>
						<Button
							variant="ghost"
							disabled={cancelFetcher.state !== 'idle'}
							onClick={() =>
								void cancelFetcher.submit(
									{ intent: 'cancel' },
									{ method: 'post', encType: 'application/json' },
								)
							}
						>
							<Trans>Cancel import</Trans>
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
