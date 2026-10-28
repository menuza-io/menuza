import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	localeDirection,
	PRINT_MAX_FEATURED_ITEMS,
	PRINT_TEMPLATE_STYLES,
	PRINT_TEXT_MAX,
	printSitePath,
	type PrintArtwork,
	type PrintDesignContent,
	type PrintQrTarget,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
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
import { useState } from 'react'
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
	PRINT_ARTWORK_ERROR_FALLBACK,
	PRINT_ARTWORK_ERROR_LABELS,
} from '#app/components/print/artwork-labels.ts'
import {
	PRINT_STYLE_LABELS,
	printProductLabel,
	printTargetLabel,
} from '#app/components/print/print-labels.ts'
import { printShopUi } from '#app/components/print/vertical-ui.tsx'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	canvaEditUrl,
	PrintArtworkError,
	refreshCanvaArtwork,
	sendDesignToCanva,
} from '#app/utils/print/artwork.server.ts'
import { isCanvaConfigured } from '#app/utils/print/canva/env.server.ts'
import {
	approvedSnapshot,
	approvePrintDesign,
	archivePrintDesign,
	currentSnapshot,
	requirePrintDesign,
	savePrintDesign,
	toDesignView,
	updateArtworkDesign,
} from '#app/utils/print/designs.server.ts'
import {
	listFeaturableItems,
	listPrintScopes,
	orgLocales,
	staleFacts,
} from '#app/utils/print/print-snapshot.server.ts'
import {
	availableQrTargets,
	canViewQrCodes,
} from '#app/utils/print/qr-access.server.ts'
import { printVertical } from '#app/utils/print/vertical.server.ts'

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
	qrKind: z.string().min(1).max(40),
	qrPath: z.string().max(200).optional(),
	featuredItemIds: z.array(z.string().max(100)).optional().default([]),
	scopeId: z.string().max(100).optional(),
	showAddress: z.boolean().optional(),
	showWebsite: z.boolean().optional(),
})

type DesignForm = z.infer<typeof DesignFormSchema>

/** The target the form chose: the core's own kinds, or the vertical's. */
function qrFromForm(
	form: DesignForm,
	formData: FormData,
): PrintQrTarget | 'empty' {
	if (form.qrKind === 'site') {
		return { kind: 'site', path: form.qrPath?.trim() || '/' }
	}
	if (form.qrKind === 'none') return { kind: 'none' }
	const target = printVertical.qrTargets?.[form.qrKind]
	return target ? target.fromForm(formData) : { kind: form.qrKind }
}

function toContent(
	form: DesignForm,
	qr: PrintQrTarget,
	siteLocales: readonly string[],
) {
	const locales = [form.locale1, form.locale2]
		.filter((locale): locale is string => Boolean(locale))
		.filter((locale, index, list) => list.indexOf(locale) === index)
		.filter((locale) => siteLocales.includes(locale))
	const pick = (map: Record<string, string>) =>
		Object.fromEntries(
			locales.map((locale) => [locale, (map[locale] ?? '').trim()]),
		)
	return printCatalog.designContentSchema.safeParse({
		locales,
		headline: pick(form.headline),
		body: pick(form.body),
		callToAction: pick(form.callToAction),
		qr,
		featuredItemIds: form.featuredItemIds.slice(0, PRINT_MAX_FEATURED_ITEMS),
		scopeId: form.scopeId || null,
		showAddress: form.showAddress === true,
		showWebsite: form.showWebsite === true,
	} satisfies Record<keyof PrintDesignContent, unknown>)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const design = toDesignView(row)
	const product = printCatalog.products[design.product]
	if (!product) throw new Response('Not Found', { status: 404 })
	const { locales, defaultLocale } = orgLocales(access.organization)
	const scopes = (await listPrintScopes(access.organization.id)).map(
		(scope) => ({ id: scope.id, name: scope.name }),
	)
	const targets = await availableQrTargets(
		access,
		printCatalog.targetsFor(design.product),
	)
	// Editor data of the vertical's targets (for example the codes to pick).
	const targetData: Record<string, unknown> = {}
	for (const kind of targets) {
		const editorData = printVertical.qrTargets?.[kind]?.editorData
		if (editorData) targetData[kind] = await editorData(request, access)
	}
	const featuredSource = Boolean(printVertical.featuredItems)
	const items =
		product.featuredItems && featuredSource
			? (
					await listFeaturableItems(access.organization, design.content.scopeId)
				).items.map((item) => ({
					id: item.id,
					name: item.name,
					hasImage: Boolean(item.imageKey),
				}))
			: []

	// Re-order check: what changed in the items or codes since approval.
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

	const size = printCatalog.getSize(design.product, design.sizeKey)
	const pieceCount = approved?.pieces.length ?? null
	// Pieces the proof stands for (a per-piece target prints one card each).
	const countPieces =
		printVertical.qrTargets?.[design.content.qr.kind]?.pieceCount
	const proofPieces = countPieces
		? countPieces(design.content.qr, targetData[design.content.qr.kind])
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
		// Some codes are capabilities: the vertical decides who sees them.
		qrHidden: !(await canViewQrCodes(access, design.content.qr)),
		design,
		locales,
		defaultLocale,
		scopes,
		targets,
		targetData,
		featuredSource,
		items,
		stale,
		pieceCount,
		proofPieces,
		proofAspect: design.artwork
			? design.artwork.heightMm / design.artwork.widthMm
			: size
				? size.heightMm / size.widthMm
				: 1.4,
		folded: design.artwork ? false : product.folded === true,
		// Import from and send to Canva (the member's own Canva account).
		canva: access.features.canva && access.canWrite && isCanvaConfigured(),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	const row = await requirePrintDesign(access.organization.id, params.designId)
	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent === 'archive') {
		await archivePrintDesign(row)
		return redirect(`/${access.organization.slug}/marketing/print`)
	}
	if (
		intent === 'canva-send' ||
		intent === 'canva-edit' ||
		intent === 'canva-refresh'
	) {
		if (!access.features.canva || !isCanvaConfigured()) {
			throw new Response('Not Found', { status: 404 })
		}
		try {
			// Edit and send open Canva (the forms post to a new tab).
			if (intent === 'canva-send') {
				return redirect(await sendDesignToCanva(request, access, row))
			}
			if (intent === 'canva-edit') {
				return redirect(await canvaEditUrl(access, row))
			}
			await refreshCanvaArtwork(access, row)
			return { result: undefined, error: null, canva: 'refreshed' as const }
		} catch (error) {
			if (error instanceof PrintArtworkError) {
				return { result: undefined, error: null, canvaError: error.code }
			}
			throw error
		}
	}
	if (row.source === 'artwork') {
		// A finished file: only its name changes here, then approve as usual.
		const name = String(formData.get('name') ?? '').trim()
		if (!name || name.length > 120) {
			return { result: undefined, error: 'invalid_content' as const }
		}
		const saved = await updateArtworkDesign(row, { name })
		if (intent === 'approve') {
			try {
				await approvePrintDesign(request, access, saved)
			} catch (error) {
				if (error instanceof Response && error.status === 409) {
					return { result: undefined, error: 'changed' as const }
				}
				throw error
			}
		}
		return { result: undefined, error: null }
	}
	const submission = parseWithZod(formData, { schema: DesignFormSchema })
	if (submission.status !== 'success') {
		return { result: submission.reply(), error: null }
	}
	const qr = qrFromForm(submission.value, formData)
	if (qr === 'empty') {
		return { result: submission.reply(), error: 'qr_empty' as const }
	}
	const { locales } = orgLocales(access.organization)
	const content = toContent(submission.value, qr, locales)
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
			// Nothing to print (for example a set of cards with none chosen).
			if (error instanceof Response && error.status === 422) {
				return { result: submission.reply(), error: 'qr_empty' as const }
			}
			// Someone saved between the snapshot and the approval: approve again.
			if (error instanceof Response && error.status === 409) {
				return { result: submission.reply(), error: 'changed' as const }
			}
			// The codes' source is unreachable: saved, not approved.
			if (error instanceof Response && error.status === 503) {
				return {
					result: submission.reply(),
					error: 'qr_unavailable' as const,
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
	const product = printCatalog.products[design.product]!

	const [locale1, setLocale1] = useState(
		content.locales[0] ?? data.defaultLocale,
	)
	const [locale2, setLocale2] = useState(content.locales[1] ?? '')
	const [qrKind, setQrKind] = useState<PrintQrTarget['kind']>(content.qr.kind)
	const targetUi = printShopUi.qrTargets?.[qrKind]
	const TargetFields = targetUi?.Fields
	const hiddenNote =
		printShopUi.qrTargets?.[content.qr.kind]?.hidden ??
		msg`This print carries private QR codes, so only people who may see them can see the proof and download it.`

	// Approving must approve what the proof shows: unsaved edits first. A new
	// save (a new `updatedAt`) clears the flag, adjusted during render.
	const [dirty, setDirty] = useState(false)
	const [savedAt, setSavedAt] = useState(design.updatedAt)
	if (savedAt !== design.updatedAt) {
		setSavedAt(design.updatedAt)
		setDirty(false)
	}

	const [form] = useForm({
		id: `print-${design.id}`,
		lastResult: actionData?.result,
		onValidate: ({ formData }) =>
			parseWithZod(formData, { schema: DesignFormSchema }),
	})

	const shownLocales = [locale1, locale2].filter(
		(locale, index, list) => Boolean(locale) && list.indexOf(locale) === index,
	)
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
				description={`${_(printProductLabel(design.product).name)} · ${printCatalog.getSize(design.product, design.sizeKey)?.label ?? ''}`}
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
						{actionData.error === 'qr_unavailable' ||
						actionData.error === 'changed'
							? _(msg`We could not approve this print`)
							: _(msg`We could not save this print`)}
					</AlertTitle>
					<AlertDescription>
						{actionData.error === 'qr_empty'
							? _(
									printShopUi.qrTargets?.[qrKind]?.empty ??
										msg`Choose what the QR codes are for.`,
								)
							: actionData.error === 'qr_unavailable'
								? _(
										msg`Your changes are saved, but the QR codes could not be loaded to approve the proof. Try again in a minute.`,
									)
								: actionData.error === 'changed'
									? _(
											msg`Someone else changed this print while you approved it. Check the proof, then approve again.`,
										)
									: actionData.error === 'invalid_qr'
										? _(
												msg`Check the QR code: use a page on your own website, like /contact.`,
											)
										: _(msg`Check the words and choices, then save again.`)}
					</AlertDescription>
				</Alert>
			) : null}

			{data.downloadProblem ? (
				<Alert
					variant="destructive"
					role="alert"
					// Shown once: drop it from the address, so a save (which posts to
					// this URL) or a reload does not bring it back.
					ref={(node) => {
						if (!node) return
						const url = new URL(window.location.href)
						if (!url.searchParams.has('download')) return
						url.searchParams.delete('download')
						window.history.replaceState(window.history.state, '', url)
					}}
				>
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
						{_(msg`Details on this print changed since approval`)}
					</AlertTitle>
					<AlertDescription>
						{_(
							msg`Prices, names or QR codes on this print are out of date. Approve the proof again to refresh it, or keep printing the approved version.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{actionData && 'canvaError' in actionData && actionData.canvaError ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{_(msg`Canva could not do that`)}</AlertTitle>
					<AlertDescription>
						{_(
							PRINT_ARTWORK_ERROR_LABELS[actionData.canvaError] ??
								PRINT_ARTWORK_ERROR_FALLBACK,
						)}
					</AlertDescription>
				</Alert>
			) : actionData && 'canva' in actionData ? (
				<Alert role="status">
					<AlertTitle>{_(msg`Updated from Canva`)}</AlertTitle>
					<AlertDescription>
						{_(
							msg`The latest version of the design is in. Approve the proof again to print it.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
				{design.artwork ? (
					<ArtworkDetails
						name={design.name}
						artwork={design.artwork}
						canWrite={canWrite}
						busy={busy}
						canva={data.canva}
					/>
				) : (
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
													placeholder={
														printCatalog.defaultCopy(locale, qrKind).headline
													}
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
														printCatalog.defaultCopy(locale, qrKind)
															.callToAction
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
											msg`Where people land when they scan. Links point at your own website only.`,
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
												{_(printTargetLabel(target))}
											</Label>
										))}
									</RadioGroup>

									{TargetFields ? (
										<TargetFields
											key={qrKind}
											target={
												content.qr.kind === qrKind
													? content.qr
													: { kind: qrKind }
											}
											data={data.targetData[qrKind] ?? null}
											scopes={data.scopes}
										/>
									) : null}

									{qrKind === 'site' ? (
										<Field>
											<FieldLabel htmlFor="qr-path">{_(msg`Page`)}</FieldLabel>
											<Input
												id="qr-path"
												name="qrPath"
												dir="ltr"
												defaultValue={printSitePath(content.qr) ?? '/'}
												placeholder="/contact"
											/>
										</Field>
									) : null}
								</CardContent>
							</Card>

							{product.featuredItems && data.featuredSource ? (
								<Card>
									<CardHeader>
										<CardTitle>
											{_(
												printShopUi.featuredItems?.title ?? msg`Featured items`,
											)}
										</CardTitle>
										<CardDescription>
											{_(
												printShopUi.featuredItems?.description ??
													msg`Pick up to 4 items. Names, prices and photos come from your catalog.`,
											)}
										</CardDescription>
									</CardHeader>
									<CardContent>
										{data.items.length === 0 ? (
											<p className="text-muted-foreground text-sm">
												{_(
													printShopUi.featuredItems?.empty ??
														msg`There are no items to feature yet.`,
												)}
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
									{data.scopes.length > 1 ? (
										<Field>
											<FieldLabel htmlFor="print-scope">
												{_(printShopUi.scope?.source ?? msg`Address from`)}
											</FieldLabel>
											<select
												id="print-scope"
												name="scopeId"
												defaultValue={content.scopeId ?? ''}
												className="border-input bg-background h-11 rounded-md border px-3 text-sm"
											>
												{data.scopes.map((scope) => (
													<option key={scope.id} value={scope.id}>
														{scope.name}
													</option>
												))}
											</select>
										</Field>
									) : data.scopes[0] ? (
										<input
											type="hidden"
											name="scopeId"
											value={data.scopes[0].id}
										/>
									) : null}
									{data.scopes.length > 0 ? (
										<Label className="flex min-h-11 items-center gap-3">
											<Switch
												name="showAddress"
												defaultChecked={content.showAddress}
											/>
											{_(msg`Show the address`)}
										</Label>
									) : null}
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
				)}

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
							{data.qrHidden ? null : (
								<CardDescription>
									{_(
										msg`The dashed line is where the print is cut. Keep words away from the edge.`,
									)}
								</CardDescription>
							)}
						</CardHeader>
						<CardContent>
							{data.qrHidden ? (
								<p className="text-muted-foreground text-sm" role="note">
									{_(hiddenNote)}
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
							{data.qrHidden ? null : (
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
						hidden={data.qrHidden}
						artwork={Boolean(design.artwork)}
					/>

					{data.canva && !design.artwork ? (
						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Canva`)}</CardTitle>
								<CardDescription>
									{_(
										msg`Open a copy in Canva to change anything freely. Bring it back with Import from Canva.`,
									)}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Form method="post" reloadDocument target="_blank">
									<Button
										type="submit"
										name="intent"
										value="canva-send"
										variant="outline"
										disabled={busy || data.qrHidden}
									>
										{_(msg`Send to Canva`)}
									</Button>
								</Form>
							</CardContent>
						</Card>
					) : null}

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
	artwork,
}: {
	orgSlug: string
	designId: string
	approved: boolean
	/** A finished file downloads as it is: one PDF, no sheets. */
	artwork: boolean
	/** The QR codes on this print are not for this user (vertical's rule). */
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
								msg`Only people who may see its QR codes can download this print.`,
							)
						: approved
							? _(msg`Free PDFs of the approved proof.`)
							: _(msg`Approve the proof to download it.`)}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{artwork ? (
					<DownloadLink
						href={`${base}?format=pro`}
						disabled={!approved || hidden}
						label={_(msg`Download the PDF`)}
					/>
				) : (
					<>
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
					</>
				)}
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

/** The left column of a finished-file print: its source and its name. */
function ArtworkDetails({
	name,
	artwork,
	canWrite,
	busy,
	canva,
}: {
	name: string
	artwork: PrintArtwork
	canWrite: boolean
	busy: boolean
	canva: boolean
}) {
	const { _ } = useLingui()
	const [draft, setDraft] = useState(name)
	const dirty = draft.trim() !== name
	const size = `${artwork.widthMm} × ${artwork.heightMm} mm`
	return (
		<div className="space-y-6">
			<Form method="post" className="space-y-6">
				<Card>
					<CardHeader>
						<CardTitle>{_(msg`Basics`)}</CardTitle>
					</CardHeader>
					<CardContent>
						<Field>
							<FieldLabel htmlFor="artwork-name">{_(msg`Name`)}</FieldLabel>
							<Input
								id="artwork-name"
								name="name"
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								maxLength={120}
								disabled={!canWrite}
								required
							/>
						</Field>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>{_(msg`From Canva`)}</CardTitle>
						<CardDescription>
							{_(
								msg`This print is a finished design: it prints exactly as it looks in Canva. Change it there, then update it here.`,
							)}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2">
						<p className="text-sm font-medium wrap-anywhere">{artwork.title}</p>
						<p className="text-muted-foreground text-sm">
							<bdi dir="ltr">{size}</bdi>
							{' · '}
							{artwork.bleedMm > 0
								? (() => {
										const bleed = artwork.bleedMm
										return _(msg`${bleed} mm bleed`)
									})()
								: _(msg`No bleed`)}
						</p>
						{artwork.bleedMm === 0 ? (
							<p className="text-muted-foreground text-sm" role="note">
								{_(
									msg`Without bleed, color that runs to the edge can show a thin white line after cutting. Add bleed in Canva (File, Settings, Show print bleed) for shipped prints.`,
								)}
							</p>
						) : null}
						{artwork.pages > 1 ? (
							<p className="text-muted-foreground text-sm" role="note">
								{_(msg`The design has more pages: only the first one prints.`)}
							</p>
						) : null}
					</CardContent>
				</Card>

				{canWrite ? (
					<div className="flex flex-wrap gap-3">
						<Button
							type="submit"
							name="intent"
							value="save"
							variant="outline"
							disabled={busy || !dirty || !draft.trim()}
						>
							{_(msg`Save`)}
						</Button>
						<Button
							type="submit"
							name="intent"
							value="approve"
							disabled={busy || !draft.trim()}
						>
							<Icon name="check" className="size-4" />
							{_(msg`Approve proof`)}
						</Button>
					</div>
				) : null}
			</Form>

			{canva ? (
				<div className="flex flex-wrap gap-3">
					<Form method="post">
						<Button
							type="submit"
							name="intent"
							value="canva-refresh"
							variant="outline"
							disabled={busy}
						>
							{_(msg`Update from Canva`)}
						</Button>
					</Form>
					<Form method="post" reloadDocument target="_blank">
						<Button
							type="submit"
							name="intent"
							value="canva-edit"
							variant="ghost"
							disabled={busy}
						>
							{_(msg`Edit in Canva`)}
						</Button>
					</Form>
				</div>
			) : null}
		</div>
	)
}
