import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	defaultPrintCopy,
	getPrintSize,
	localeDirection,
	PRINT_MAX_FEATURED_ITEMS,
	PRINT_PRODUCTS,
	PRINT_TEMPLATE_STYLES,
	PRINT_TEXT_MAX,
	printDesignContentSchema,
	printTargetsFor,
	type PrintDesignContent,
	type PrintQrTarget,
} from '@repo/common/print-shop'
import { getSiteLocaleNativeLabel } from '@repo/common/site-locales'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
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
import { Field, FieldLabel, FieldLegend, FieldSet } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	PRINT_PRODUCT_LABELS,
	PRINT_QR_TARGET_LABELS,
	PRINT_STYLE_LABELS,
} from '#app/components/print/print-labels.ts'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	approvedSnapshot,
	approvePrintDesign,
	archivePrintDesign,
	currentSnapshot,
	requirePrintDesign,
	savePrintDesign,
	toDesignView,
} from '#app/utils/print/designs.server.ts'
import {
	listFeaturableItems,
	listOrgLocations,
	orgLocales,
	staleFacts,
} from '#app/utils/print/print-snapshot.server.ts'
import {
	canPrintQrTables,
	fetchQrTablesForPrint,
	isQrDineInOn,
} from '#app/utils/print/qr-tables.server.ts'

/** Width the proof document renders at (fits the aside on every screen). */
const PROOF_WIDTH_PX = 320

const localized = (max: number) =>
	z.record(z.string(), z.string().max(max)).optional().default({})

const DesignFormSchema = z.object({
	intent: z.enum(['save', 'approve']),
	name: z.string().trim().min(1).max(120),
	sizeKey: z.string().trim().min(1).max(20),
	style: z.enum(PRINT_TEMPLATE_STYLES),
	locale1: z.string().min(2).max(10),
	locale2: z.string().max(10).optional(),
	headline: localized(PRINT_TEXT_MAX.headline),
	body: localized(PRINT_TEXT_MAX.body),
	callToAction: localized(PRINT_TEXT_MAX.callToAction),
	qrKind: z.enum(['table', 'menu', 'reservations', 'site', 'none']),
	qrLocationId: z.string().max(100).optional(),
	qrPath: z.string().max(200).optional(),
	allTables: z.boolean().optional(),
	tableIds: z.array(z.string().max(100)).optional().default([]),
	featuredItemIds: z.array(z.string().max(100)).optional().default([]),
	locationId: z.string().max(100).optional(),
	showAddress: z.boolean().optional(),
	showWebsite: z.boolean().optional(),
})

type DesignForm = z.infer<typeof DesignFormSchema>

function toContent(form: DesignForm, siteLocales: readonly string[]) {
	const locales = [form.locale1, form.locale2]
		.filter((locale): locale is string => Boolean(locale))
		.filter((locale, index, list) => list.indexOf(locale) === index)
		.filter((locale) => siteLocales.includes(locale))
	const pick = (map: Record<string, string>) =>
		Object.fromEntries(
			locales.map((locale) => [locale, (map[locale] ?? '').trim()]),
		)
	let qr: PrintQrTarget
	switch (form.qrKind) {
		case 'table':
			qr = {
				kind: 'table',
				tableIds: form.allTables ? ['all'] : form.tableIds,
			}
			break
		case 'menu':
			qr = { kind: 'menu', locationId: form.qrLocationId || '' }
			break
		case 'reservations':
			qr = { kind: 'reservations', locationId: form.qrLocationId || null }
			break
		case 'site':
			qr = { kind: 'site', path: form.qrPath?.trim() || '/' }
			break
		default:
			qr = { kind: 'none' }
	}
	return printDesignContentSchema.safeParse({
		locales,
		headline: pick(form.headline),
		body: pick(form.body),
		callToAction: pick(form.callToAction),
		qr,
		featuredItemIds: form.featuredItemIds.slice(0, PRINT_MAX_FEATURED_ITEMS),
		locationId: form.locationId || null,
		showAddress: form.showAddress === true,
		showWebsite: form.showWebsite === true,
	} satisfies Record<keyof PrintDesignContent, unknown>)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const design = toDesignView(row)
	const product = PRINT_PRODUCTS[design.product]
	const { locales, defaultLocale } = orgLocales(access.organization)
	const locations = (await listOrgLocations(access.organization.id)).map(
		(location) => ({ id: location.id, name: location.name }),
	)
	const targets = [...printTargetsFor(design.product)].filter(
		(target) => target !== 'table',
	) as Array<PrintQrTarget['kind']>
	let tables: Array<{ id: string; label: string; locationId: string }> = []
	if (
		printTargetsFor(design.product).includes('table') &&
		(await isQrDineInOn(access.organization.id)) &&
		(await canPrintQrTables(access.userId, access.organization.id))
	) {
		targets.unshift('table')
		tables = (
			await fetchQrTablesForPrint(request, access.organization.slug).catch(
				() => [],
			)
		).map((table) => ({
			id: table.id,
			label: table.label,
			locationId: table.locationId,
		}))
	}
	const items = product.featuredItems
		? (
				await listFeaturableItems(
					access.organization,
					design.content.locationId,
				)
			).items.map((item) => ({
				id: item.id,
				name: item.name,
				hasImage: item.hasImage,
			}))
		: []

	// Re-order check: what changed in the menu or tables since approval.
	let stale: string[] = []
	const approved = approvedSnapshot(row)
	if (approved) {
		try {
			const live = await currentSnapshot(request, access, row, {
				skipImages: true,
			})
			stale = staleFacts(approved, live)
		} catch {
			stale = []
		}
	}

	const size = getPrintSize(design.product, design.sizeKey)
	const pieceCount = approved?.pieces.length ?? null
	// Pieces the proof stands for (a table set is one card per table).
	const proofPieces =
		design.content.qr.kind === 'table'
			? design.content.qr.tableIds.includes('all')
				? tables.length
				: design.content.qr.tableIds.length
			: 1
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		canOrder: access.canPay,
		// A download that could not be made lands back here (new tab).
		downloadProblem: (() => {
			const value = new URL(request.url).searchParams.get('download')
			return value === 'limited' || value === 'failed' ? value : null
		})(),
		// Table cards carry live table codes: only menu editors see them.
		tableCodesHidden:
			design.content.qr.kind === 'table' &&
			!(await canPrintQrTables(access.userId, access.organization.id)),
		design,
		locales,
		defaultLocale,
		locations,
		targets,
		tables,
		items,
		stale,
		pieceCount,
		proofPieces,
		proofAspect: size ? size.heightMm / size.widthMm : 1.4,
		folded: product.folded === true,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const formData = await request.formData()
	if (formData.get('intent') === 'archive') {
		await archivePrintDesign(row)
		return redirect(`/${access.organization.slug}/marketing/print`)
	}
	const submission = parseWithZod(formData, { schema: DesignFormSchema })
	if (submission.status !== 'success') {
		return { result: submission.reply(), error: null }
	}
	if (
		submission.value.qrKind === 'table' &&
		!submission.value.allTables &&
		submission.value.tableIds.length === 0
	) {
		return { result: submission.reply(), error: 'no_tables' as const }
	}
	const { locales } = orgLocales(access.organization)
	const content = toContent(submission.value, locales)
	if (!content.success) {
		const onQr = content.error.issues.some((issue) => issue.path[0] === 'qr')
		return {
			result: submission.reply(),
			error: onQr ? ('invalid_qr' as const) : ('invalid_content' as const),
		}
	}
	const saved = await savePrintDesign(row, {
		name: submission.value.name,
		sizeKey: submission.value.sizeKey,
		style: submission.value.style,
		content: content.data,
	})
	if (submission.value.intent === 'approve') {
		try {
			await approvePrintDesign(request, access, saved)
		} catch (error) {
			// Nothing to print (for example a table set with no tables yet).
			if (error instanceof Response && error.status === 422) {
				return { result: submission.reply(), error: 'no_tables' as const }
			}
			// The region holding the table codes is unreachable: saved, not approved.
			if (error instanceof Response && error.status === 503) {
				return {
					result: submission.reply(),
					error: 'tables_unavailable' as const,
				}
			}
			throw error
		}
	}
	return { result: submission.reply(), error: null }
}

export default function PrintDesignRoute() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const busy = navigation.state !== 'idle'
	const { design, orgSlug, canWrite } = data
	const content = design.content
	const product = PRINT_PRODUCTS[design.product]

	const [locale1, setLocale1] = useState(
		content.locales[0] ?? data.defaultLocale,
	)
	const [locale2, setLocale2] = useState(content.locales[1] ?? '')
	const [qrKind, setQrKind] = useState<PrintQrTarget['kind']>(content.qr.kind)
	const initialTables =
		content.qr.kind === 'table' ? content.qr.tableIds : ['all']
	const [allTables, setAllTables] = useState(initialTables.includes('all'))

	// Approving must approve what the proof shows: unsaved edits first.
	const [dirty, setDirty] = useState(false)
	useEffect(() => setDirty(false), [design.updatedAt])
	// The download problem is shown once: drop it from the address, so a save
	// (which posts to this URL) or a reload does not bring it back.
	useEffect(() => {
		if (!data.downloadProblem) return
		const url = new URL(window.location.href)
		url.searchParams.delete('download')
		window.history.replaceState(window.history.state, '', url)
	}, [data.downloadProblem])

	const [form] = useForm({
		id: `print-${design.id}`,
		lastResult: actionData?.result,
		onValidate: ({ formData }) =>
			parseWithZod(formData, { schema: DesignFormSchema }),
	})

	const shownLocales = [locale1, locale2].filter(
		(locale, index, list) => Boolean(locale) && list.indexOf(locale) === index,
	)
	const qrLocationId =
		content.qr.kind === 'menu' || content.qr.kind === 'reservations'
			? (content.qr.locationId ?? '')
			: (content.locationId ?? data.locations[0]?.id ?? '')
	const proofSrc = `/${orgSlug}/marketing/print/${design.id}/proof?v=${encodeURIComponent(design.updatedAt)}`
	const proofHeight = Math.round(
		Math.min(3, Math.max(1, data.proofPieces)) *
			(PROOF_WIDTH_PX * data.proofAspect * (data.folded ? 2 : 1) + 24) +
			24,
	)
	const isApproved = design.status === 'approved'

	return (
		<div className="space-y-8">
			<PageHeader
				title={design.name}
				description={`${_(PRINT_PRODUCT_LABELS[design.product].name)} · ${getPrintSize(design.product, design.sizeKey)?.label ?? ''}`}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/marketing/print`} />}
					>
						{_(msg`All prints`)}
					</Button>
				}
			/>

			{actionData?.error ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>
						{actionData.error === 'tables_unavailable'
							? _(msg`We could not approve this print`)
							: _(msg`We could not save this print`)}
					</AlertTitle>
					<AlertDescription>
						{actionData.error === 'no_tables'
							? _(msg`Choose at least one table for the cards.`)
							: actionData.error === 'tables_unavailable'
								? _(
										msg`Your changes are saved, but table codes could not be loaded to approve the proof. Try again in a minute.`,
									)
								: actionData.error === 'invalid_qr'
									? _(
											msg`Check the QR code: use a page on your own website, like /menu.`,
										)
									: _(msg`Check the words and choices, then save again.`)}
					</AlertDescription>
				</Alert>
			) : null}

			{data.downloadProblem ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{_(msg`The download could not be made`)}</AlertTitle>
					<AlertDescription>
						{data.downloadProblem === 'limited'
							? _(
									msg`Your organization made many new print files this hour. Try again in about 15 minutes; files made before still download.`,
								)
							: _(
									msg`Something went wrong making the file. Try again shortly.`,
								)}
					</AlertDescription>
				</Alert>
			) : null}

			{data.stale.length > 0 ? (
				<Alert>
					<AlertTitle>
						{_(msg`Your menu or tables changed since approval`)}
					</AlertTitle>
					<AlertDescription>
						{_(
							msg`Prices, dish names or table codes on this print are out of date. Approve the proof again to refresh it, or keep printing the approved version.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
				<Form
					method="post"
					{...getFormProps(form)}
					className="space-y-6"
					onChange={() => setDirty(true)}
				>
					<fieldset disabled={!canWrite} className="space-y-6">
						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Basics`)}</CardTitle>
							</CardHeader>
							<CardContent className="space-y-5">
								<Field>
									<FieldLabel htmlFor="print-name">{_(msg`Name`)}</FieldLabel>
									<Input
										id="print-name"
										name="name"
										defaultValue={design.name}
										maxLength={120}
										required
									/>
								</Field>
								<FieldSet>
									<FieldLegend variant="label">{_(msg`Size`)}</FieldLegend>
									<RadioGroup
										name="sizeKey"
										defaultValue={design.sizeKey}
										className="flex flex-wrap gap-3"
									>
										{product.sizes.map((size) => (
											<Label
												key={size.key}
												className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
											>
												<RadioGroupItem value={size.key} />
												<bdi>{size.label}</bdi>
											</Label>
										))}
									</RadioGroup>
								</FieldSet>
								<FieldSet>
									<FieldLegend variant="label">{_(msg`Style`)}</FieldLegend>
									<RadioGroup
										name="style"
										defaultValue={design.style}
										className="flex flex-wrap gap-3"
									>
										{PRINT_TEMPLATE_STYLES.map((style) => (
											<Label
												key={style}
												className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
											>
												<RadioGroupItem value={style} />
												{_(PRINT_STYLE_LABELS[style])}
											</Label>
										))}
									</RadioGroup>
								</FieldSet>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Words`)}</CardTitle>
								<CardDescription>
									{_(
										msg`Leave a field empty to use the suggested words. Add a second language for a bilingual print.`,
									)}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<div className="grid gap-4 sm:grid-cols-2">
									<Field>
										<FieldLabel htmlFor="print-locale1">
											{_(msg`Main language`)}
										</FieldLabel>
										<select
											id="print-locale1"
											name="locale1"
											value={locale1}
											onChange={(event) => setLocale1(event.target.value)}
											className="border-input bg-background h-11 rounded-md border px-3 text-sm"
										>
											{data.locales.map((locale) => (
												<option key={locale} value={locale}>
													{getSiteLocaleNativeLabel(locale)}
												</option>
											))}
										</select>
									</Field>
									<Field>
										<FieldLabel htmlFor="print-locale2">
											{_(msg`Second language`)}
										</FieldLabel>
										<select
											id="print-locale2"
											name="locale2"
											value={locale2}
											onChange={(event) => setLocale2(event.target.value)}
											className="border-input bg-background h-11 rounded-md border px-3 text-sm"
										>
											<option value="">{_(msg`None`)}</option>
											{data.locales
												.filter((locale) => locale !== locale1)
												.map((locale) => (
													<option key={locale} value={locale}>
														{getSiteLocaleNativeLabel(locale)}
													</option>
												))}
										</select>
									</Field>
								</div>
								{shownLocales.map((locale) => (
									<FieldSet key={locale} lang={locale}>
										<FieldLegend variant="label">
											{getSiteLocaleNativeLabel(locale)}
										</FieldLegend>
										<Field>
											<FieldLabel htmlFor={`headline-${locale}`}>
												{_(msg`Headline`)}
											</FieldLabel>
											<Input
												id={`headline-${locale}`}
												name={`headline.${locale}`}
												dir={localeDirection(locale)}
												defaultValue={content.headline[locale] ?? ''}
												placeholder={defaultPrintCopy(locale, qrKind).headline}
												maxLength={PRINT_TEXT_MAX.headline}
											/>
										</Field>
										<Field>
											<FieldLabel htmlFor={`body-${locale}`}>
												{_(msg`Message`)}
											</FieldLabel>
											<Textarea
												id={`body-${locale}`}
												name={`body.${locale}`}
												dir={localeDirection(locale)}
												defaultValue={content.body[locale] ?? ''}
												maxLength={PRINT_TEXT_MAX.body}
												rows={3}
											/>
										</Field>
										<Field>
											<FieldLabel htmlFor={`cta-${locale}`}>
												{_(msg`Call to action`)}
											</FieldLabel>
											<Input
												id={`cta-${locale}`}
												name={`callToAction.${locale}`}
												dir={localeDirection(locale)}
												defaultValue={content.callToAction[locale] ?? ''}
												placeholder={
													defaultPrintCopy(locale, qrKind).callToAction
												}
												maxLength={PRINT_TEXT_MAX.callToAction}
											/>
										</Field>
									</FieldSet>
								))}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>{_(msg`QR code`)}</CardTitle>
								<CardDescription>
									{_(
										msg`Where a guest lands when they scan. Links point at your own website only.`,
									)}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<RadioGroup
									name="qrKind"
									value={qrKind}
									onValueChange={(value) =>
										setQrKind(value as PrintQrTarget['kind'])
									}
									className="grid gap-2"
								>
									{data.targets.map((target) => (
										<Label
											key={target}
											className="flex min-h-11 cursor-pointer items-center gap-3"
										>
											<RadioGroupItem value={target} />
											{_(PRINT_QR_TARGET_LABELS[target])}
										</Label>
									))}
								</RadioGroup>

								{qrKind === 'table' ? (
									data.tables.length === 0 ? (
										<p className="text-muted-foreground text-sm">
											{_(
												msg`Add tables in QR ordering first. Each table gets its own card.`,
											)}
										</p>
									) : (
										<FieldSet>
											<Label className="flex min-h-11 items-center gap-3">
												<Switch
													name="allTables"
													checked={allTables}
													onCheckedChange={setAllTables}
												/>
												{_(
													msg`Every table (new tables are added when you approve)`,
												)}
											</Label>
											{!allTables ? (
												<div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-3">
													{data.tables.map((table) => (
														<Label
															key={table.id}
															className="flex min-h-11 items-center gap-3"
														>
															<Checkbox
																name="tableIds"
																value={table.id}
																defaultChecked={initialTables.includes(
																	table.id,
																)}
															/>
															<bdi className="wrap-anywhere">{table.label}</bdi>
														</Label>
													))}
												</div>
											) : null}
										</FieldSet>
									)
								) : null}

								{(qrKind === 'menu' || qrKind === 'reservations') &&
								data.locations.length > 1 ? (
									<Field>
										<FieldLabel htmlFor="qr-location">
											{_(msg`Location`)}
										</FieldLabel>
										<select
											id="qr-location"
											name="qrLocationId"
											defaultValue={qrLocationId}
											className="border-input bg-background h-11 rounded-md border px-3 text-sm"
										>
											{data.locations.map((location) => (
												<option key={location.id} value={location.id}>
													{location.name}
												</option>
											))}
										</select>
									</Field>
								) : (qrKind === 'menu' || qrKind === 'reservations') &&
								  data.locations[0] ? (
									<input
										type="hidden"
										name="qrLocationId"
										value={data.locations[0].id}
									/>
								) : null}

								{qrKind === 'site' ? (
									<Field>
										<FieldLabel htmlFor="qr-path">{_(msg`Page`)}</FieldLabel>
										<Input
											id="qr-path"
											name="qrPath"
											dir="ltr"
											defaultValue={
												content.qr.kind === 'site' ? content.qr.path : '/'
											}
											placeholder="/menu"
										/>
									</Field>
								) : null}
							</CardContent>
						</Card>

						{product.featuredItems ? (
							<Card>
								<CardHeader>
									<CardTitle>{_(msg`Featured dishes`)}</CardTitle>
									<CardDescription>
										{_(
											msg`Pick up to 4 dishes. Names, prices and photos come from your menu.`,
										)}
									</CardDescription>
								</CardHeader>
								<CardContent>
									{data.items.length === 0 ? (
										<p className="text-muted-foreground text-sm">
											{_(msg`Your menu has no dishes to feature yet.`)}
										</p>
									) : (
										<div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2">
											{data.items.map((item) => (
												<Label
													key={item.id}
													className="flex min-h-11 items-center gap-3"
												>
													<Checkbox
														name="featuredItemIds"
														value={item.id}
														defaultChecked={content.featuredItemIds.includes(
															item.id,
														)}
													/>
													<span className="wrap-anywhere">{item.name}</span>
													{item.hasImage ? (
														<Icon
															name="image"
															className="text-muted-foreground size-4"
															aria-hidden
														/>
													) : null}
												</Label>
											))}
										</div>
									)}
								</CardContent>
							</Card>
						) : null}

						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Details`)}</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								{data.locations.length > 1 ? (
									<Field>
										<FieldLabel htmlFor="print-location">
											{_(msg`Address and prices from`)}
										</FieldLabel>
										<select
											id="print-location"
											name="locationId"
											defaultValue={content.locationId ?? ''}
											className="border-input bg-background h-11 rounded-md border px-3 text-sm"
										>
											{data.locations.map((location) => (
												<option key={location.id} value={location.id}>
													{location.name}
												</option>
											))}
										</select>
									</Field>
								) : data.locations[0] ? (
									<input
										type="hidden"
										name="locationId"
										value={data.locations[0].id}
									/>
								) : null}
								<Label className="flex min-h-11 items-center gap-3">
									<Switch
										name="showAddress"
										defaultChecked={content.showAddress}
									/>
									{_(msg`Show the address`)}
								</Label>
								<Label className="flex min-h-11 items-center gap-3">
									<Switch
										name="showWebsite"
										defaultChecked={content.showWebsite}
									/>
									{_(msg`Show the website`)}
								</Label>
							</CardContent>
						</Card>
					</fieldset>

					{canWrite ? (
						<div className="flex flex-wrap gap-3">
							<Button
								type="submit"
								name="intent"
								value="save"
								variant="outline"
								disabled={busy}
							>
								{_(msg`Save and update proof`)}
							</Button>
							<Button
								type="submit"
								name="intent"
								value="approve"
								disabled={busy || dirty}
								aria-describedby={dirty ? 'approve-hint' : undefined}
							>
								<Icon name="check" className="size-4" />
								{_(msg`Approve proof`)}
							</Button>
							{dirty ? (
								<p
									id="approve-hint"
									className="text-muted-foreground w-full text-sm"
								>
									{_(
										msg`Save first, so the proof shows your changes before you approve it.`,
									)}
								</p>
							) : null}
						</div>
					) : null}
				</Form>

				<aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
					<Card>
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								{_(msg`Proof`)}
								{isApproved ? (
									<Badge variant="success">{_(msg`Approved`)}</Badge>
								) : (
									<Badge variant="secondary">{_(msg`Draft`)}</Badge>
								)}
							</CardTitle>
							{data.tableCodesHidden ? null : (
								<CardDescription>
									{_(
										msg`The dashed line is where the print is cut. Keep words away from the edge.`,
									)}
								</CardDescription>
							)}
						</CardHeader>
						<CardContent>
							{data.tableCodesHidden ? (
								<p className="text-muted-foreground text-sm" role="note">
									{_(
										msg`Table cards carry each table's ordering code, so only people who can edit the menu can see the proof and download it.`,
									)}
								</p>
							) : data.proofPieces > 3 ? (
								<p className="text-muted-foreground mb-2 text-sm">
									{(() => {
										const total = data.proofPieces
										return _(
											msg`Showing 3 of ${total} cards. Every card uses the same layout.`,
										)
									})()}
								</p>
							) : null}
							{data.tableCodesHidden ? null : (
								<iframe
									key={proofSrc}
									title={_(msg`Print proof`)}
									src={proofSrc}
									className="bg-muted w-full rounded-md border"
									height={proofHeight}
									sandbox=""
								/>
							)}
						</CardContent>
					</Card>

					<DownloadCard
						orgSlug={orgSlug}
						designId={design.id}
						approved={isApproved}
						hidden={data.tableCodesHidden}
					/>

					{data.canOrder && product.shippable ? (
						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Have it printed`)}</CardTitle>
								<CardDescription>
									{isApproved
										? _(msg`We print and ship it to your door.`)
										: _(msg`Approve the proof to order prints.`)}
								</CardDescription>
							</CardHeader>
							<CardContent>
								{isApproved ? (
									<Button
										render={
											<Link to={`/${orgSlug}/marketing/print/orders/new`} />
										}
									>
										{_(msg`Order prints`)}
									</Button>
								) : (
									<Button disabled>{_(msg`Order prints`)}</Button>
								)}
							</CardContent>
						</Card>
					) : null}

					{canWrite ? (
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button variant="ghost" className="text-muted-foreground">
										{_(msg`Archive this print`)}
									</Button>
								}
							/>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										{_(msg`Archive this print?`)}
									</AlertDialogTitle>
									<AlertDialogDescription>
										{_(
											msg`It leaves the Print shop list. Orders already placed keep printing it.`,
										)}
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>{_(msg`Keep it`)}</AlertDialogCancel>
									<Form method="post">
										<Button
											type="submit"
											name="intent"
											value="archive"
											variant="destructive"
										>
											{_(msg`Archive`)}
										</Button>
									</Form>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : null}
				</aside>
			</div>
		</div>
	)
}

function DownloadCard({
	orgSlug,
	designId,
	approved,
	hidden,
}: {
	orgSlug: string
	designId: string
	approved: boolean
	/** Table codes on this print are not for this user (menu edit needed). */
	hidden: boolean
}) {
	const { _ } = useLingui()
	const base = `/${orgSlug}/marketing/print/${designId}/download`
	return (
		<Card>
			<CardHeader>
				<CardTitle>{_(msg`Download`)}</CardTitle>
				<CardDescription>
					{hidden
						? _(
								msg`Only people who can edit the menu can download table cards, because they carry each table's ordering code.`,
							)
						: approved
							? _(msg`Free PDFs of the approved proof.`)
							: _(msg`Approve the proof to download it.`)}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<DownloadLink
					href={`${base}?format=home&sheet=letter`}
					disabled={!approved || hidden}
					label={_(msg`Print at home (US Letter)`)}
				/>
				<DownloadLink
					href={`${base}?format=home&sheet=a4`}
					disabled={!approved || hidden}
					label={_(msg`Print at home (A4)`)}
				/>
				<DownloadLink
					href={`${base}?format=pro`}
					disabled={!approved || hidden}
					label={_(msg`For a print shop (with bleed)`)}
				/>
			</CardContent>
		</Card>
	)
}

function DownloadLink({
	href,
	label,
	disabled,
}: {
	href: string
	label: string
	disabled: boolean
}) {
	if (disabled) {
		return (
			<Button variant="outline" disabled className="justify-start gap-2">
				<Icon name="download" className="size-4" />
				{label}
			</Button>
		)
	}
	return (
		<Button
			variant="outline"
			className="justify-start gap-2"
			render={
				// A file download or the browser print page: a full navigation.
				<a href={href} target="_blank" rel="noopener" />
			}
		>
			<Icon name="download" className="size-4" />
			{label}
			<span className="sr-only">
				<Trans>(opens in a new tab)</Trans>
			</span>
		</Button>
	)
}
