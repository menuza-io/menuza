import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { parseFormData } from '@mjackson/form-data-parser'
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useId, useState } from 'react'
import {
	type ActionFunctionArgs,
	Form,
	Link,
	type LoaderFunctionArgs,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import {
	isMenuImportKillSwitchOn,
	requireMenuImportAccess,
} from '#app/utils/menu/import/access.server.ts'
import {
	MENU_IMPORT_MAX_BYTES,
	MENU_IMPORT_STALE_MS,
} from '#app/utils/menu/import/schema.ts'
import {
	ACTIVE_MENU_IMPORT_STATUSES,
	cancelMenuImport,
	listMenuImportsForOrg,
	startMenuImport,
} from '#app/utils/menu/import/service.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuImportAccess(request, organization.id)

	const imports = await listMenuImportsForOrg(organization.id)
	const activeImport =
		imports.find((row) =>
			(ACTIVE_MENU_IMPORT_STATUSES as readonly string[]).includes(row.status),
		) ?? null
	const canCancelActiveImport = activeImport
		? activeImport.status !== 'applying' ||
			Date.now() - new Date(activeImport.updatedAt).getTime() >=
				MENU_IMPORT_STALE_MS
		: false

	return {
		orgSlug: organization.slug,
		imports,
		activeImport,
		canCancelActiveImport,
		disabled: isMenuImportKillSwitchOn(),
	}
}

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

	let formData: FormData
	try {
		formData = await parseFormData(request, {
			maxFileSize: MENU_IMPORT_MAX_BYTES,
		})
	} catch {
		return Response.json(
			{ ok: false, error: 'unsupported_file' },
			{ status: 400 },
		)
	}

	const intent = String(formData.get('intent') ?? 'start')

	if (intent === 'cancel') {
		const importId = String(formData.get('importId') ?? '').trim()
		if (!importId) {
			return Response.json(
				{ ok: false, error: 'invalid_request' },
				{ status: 400 },
			)
		}
		const cancelled = await cancelMenuImport({
			importId,
			organizationId: organization.id,
		})
		if (!cancelled.ok) {
			return Response.json(
				{ ok: false, error: cancelled.error },
				{ status: cancelled.status },
			)
		}
		return Response.json({ ok: true })
	}

	const mode = String(formData.get('mode') ?? 'url')

	if (mode === 'url') {
		const sourceUrl = String(formData.get('sourceUrl') ?? '').trim()
		const ownershipValue = String(formData.get('confirmedOwnership') ?? '')
		const confirmedOwnership =
			ownershipValue === 'true' || ownershipValue === 'on'
		const result = await startMenuImport({
			kind: 'url',
			organizationId: organization.id,
			userId,
			sourceUrl,
			confirmedOwnership,
		})
		if (!result.ok) {
			return Response.json(
				{
					ok: false,
					error: result.error,
					activeImportId: result.activeImportId,
				},
				{ status: result.status },
			)
		}
		return redirect(`/${organization.slug}/menu/import/${result.importId}`)
	}

	const uploaded = formData.get('file')
	if (!(uploaded instanceof File) || uploaded.size === 0) {
		return Response.json(
			{ ok: false, error: 'unsupported_file' },
			{ status: 400 },
		)
	}

	const bytes = new Uint8Array(await uploaded.arrayBuffer())
	const result = await startMenuImport({
		kind: 'file',
		organizationId: organization.id,
		userId,
		filename: uploaded.name || 'upload',
		mimeType: uploaded.type || null,
		bytes,
	})

	if (!result.ok) {
		return Response.json(
			{
				ok: false,
				error: result.error,
				activeImportId: result.activeImportId,
			},
			{ status: result.status },
		)
	}

	return redirect(`/${organization.slug}/menu/import/${result.importId}`)
}

const IMPORT_ERRORS: Record<string, MessageDescriptor> = {
	url_not_allowed: msg`That URL cannot be fetched. Paste a public HTTPS website address.`,
	fetch_failed: msg`Could not reach that URL or the file exceeded the 10 MB / 20 second limit.`,
	unsupported_file: msg`Unsupported file. Upload a PDF, JPG/PNG/WebP photo, CSV, TSV, or XLSX spreadsheet up to 10 MB.`,
	nothing_found: msg`We couldn't find any menu items there. Try uploading a PDF or a photo of your printed menu.`,
	ownership_not_confirmed: msg`Confirm "This is my restaurant's menu" before importing from a website URL.`,
	import_in_progress: msg`An import is already running for this organization. Review or cancel it before starting another.`,
	rate_limited: msg`Too many menu imports right now. Please try again later.`,
	menu_import_disabled: msg`Menu import is temporarily switched off.`,
	model_invalid: msg`The menu could not be structured cleanly. Try a clearer photo, PDF, or CSV.`,
	extract_failed: msg`Something went wrong reading that menu. Please try again.`,
}

const STATUS_LABELS: Record<string, MessageDescriptor> = {
	queued: msg`Queued`,
	running: msg`Reading`,
	ready: msg`Ready to review`,
	applying: msg`Applying`,
	applied: msg`Applied`,
	failed: msg`Failed`,
	cancelled: msg`Cancelled`,
}

const SOURCE_LABELS: Record<string, MessageDescriptor> = {
	url: msg`Website URL`,
	pdf: msg`PDF`,
	image: msg`Photo`,
	spreadsheet: msg`Spreadsheet`,
}

function statusVariant(
	status: string,
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline' {
	switch (status) {
		case 'applied':
			return 'success'
		case 'ready':
			return 'default'
		case 'failed':
			return 'destructive'
		case 'queued':
		case 'running':
		case 'applying':
			return 'warning'
		default:
			return 'secondary'
	}
}

type SourceMode = 'url' | 'pdf' | 'image' | 'spreadsheet'

export default function MenuImportPage() {
	const { _, i18n } = useLingui()
	const { orgSlug, imports, activeImport, canCancelActiveImport, disabled } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<{
		ok?: boolean
		error?: string
		activeImportId?: string
	}>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	const sourceLabelId = useId()
	const urlInputId = useId()
	const ownershipCheckboxId = useId()
	const fileInputId = useId()
	const [mode, setMode] = useState<SourceMode>('url')
	const [confirmedOwnership, setConfirmedOwnership] = useState(false)

	const acceptForMode =
		mode === 'pdf'
			? '.pdf,application/pdf'
			: mode === 'image'
				? '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'
				: '.csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

	return (
		<div className="flex flex-col gap-6">
			{disabled ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" className="size-4" />
					<AlertTitle>
						<Trans>Import unavailable</Trans>
					</AlertTitle>
					<AlertDescription>
						{_(IMPORT_ERRORS.menu_import_disabled!)}
					</AlertDescription>
				</Alert>
			) : null}

			{activeImport ? (
				<Alert>
					<Icon name="clock" className="size-4" />
					<AlertTitle>
						<Trans>Import in progress</Trans>
					</AlertTitle>
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span>
								<Trans>
									One import can run at a time. You can leave this page and
									return anytime while it finishes.
								</Trans>
							</span>
							<div className="flex items-center gap-2">
								<Button
									size="sm"
									render={
										<Link to={`/${orgSlug}/menu/import/${activeImport.id}`} />
									}
								>
									<Trans>View progress</Trans>
								</Button>
								{canCancelActiveImport ? (
									<Form method="post">
										<input type="hidden" name="intent" value="cancel" />
										<input
											type="hidden"
											name="importId"
											value={activeImport.id}
										/>
										<Button type="submit" size="sm" variant="outline">
											<Trans>Cancel</Trans>
										</Button>
									</Form>
								) : null}
							</div>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{actionData?.error ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" className="size-4" />
					<AlertTitle>
						<Trans>Could not start import</Trans>
					</AlertTitle>
					<AlertDescription>
						{_(
							IMPORT_ERRORS[actionData.error] ?? IMPORT_ERRORS.extract_failed!,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Import your menu with AI</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Paste your public menu website URL or upload a PDF, printed menu
							photo, or spreadsheet. You will review and edit every dish before
							anything goes on your menu.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form
						method="post"
						encType="multipart/form-data"
						className="flex flex-col gap-6"
					>
						<input type="hidden" name="intent" value="start" />
						<input type="hidden" name="mode" value={mode} />

						<div className="space-y-2">
							<Label id={sourceLabelId}>
								<Trans>Source</Trans>
							</Label>
							<RadioGroup
								aria-labelledby={sourceLabelId}
								value={mode}
								onValueChange={(value) => setMode(value as SourceMode)}
								className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
							>
								<ChoiceCard>
									<RadioGroupItem value="url" />
									<ChoiceCardContent>
										<ChoiceCardTitle>
											<Trans>Website URL</Trans>
										</ChoiceCardTitle>
										<ChoiceCardDescription>
											<Trans>Public HTTPS menu page or PDF link.</Trans>
										</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
								<ChoiceCard>
									<RadioGroupItem value="pdf" />
									<ChoiceCardContent>
										<ChoiceCardTitle>
											<Trans>PDF menu</Trans>
										</ChoiceCardTitle>
										<ChoiceCardDescription>
											<Trans>Exported or printed menu PDF up to 10 MB.</Trans>
										</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
								<ChoiceCard>
									<RadioGroupItem value="image" />
									<ChoiceCardContent>
										<ChoiceCardTitle>
											<Trans>Menu photo</Trans>
										</ChoiceCardTitle>
										<ChoiceCardDescription>
											<Trans>JPG, PNG, or WebP photo of a printed card.</Trans>
										</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
								<ChoiceCard>
									<RadioGroupItem value="spreadsheet" />
									<ChoiceCardContent>
										<ChoiceCardTitle>
											<Trans>Spreadsheet</Trans>
										</ChoiceCardTitle>
										<ChoiceCardDescription>
											<Trans>CSV, TSV, or XLSX menu table.</Trans>
										</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
							</RadioGroup>
						</div>

						{mode === 'url' ? (
							<div className="flex flex-col gap-4">
								<div className="max-w-xl space-y-1.5">
									<Label htmlFor={urlInputId}>
										<Trans>Menu page URL (HTTPS)</Trans>
									</Label>
									<Input
										id={urlInputId}
										name="sourceUrl"
										type="url"
										required
										placeholder="https://example.com/menu"
										disabled={disabled || Boolean(activeImport)}
									/>
								</div>
								<label
									htmlFor={ownershipCheckboxId}
									className="flex items-center gap-2 text-sm"
								>
									<Checkbox
										id={ownershipCheckboxId}
										checked={confirmedOwnership}
										onCheckedChange={(checked) =>
											setConfirmedOwnership(checked === true)
										}
										disabled={disabled || Boolean(activeImport)}
									/>
									<input
										type="hidden"
										name="confirmedOwnership"
										value={confirmedOwnership ? 'true' : 'false'}
									/>
									<span>
										<Trans>This is my restaurant's menu</Trans>
									</span>
								</label>
							</div>
						) : (
							<div className="max-w-xl space-y-1.5">
								<Label htmlFor={fileInputId}>
									{mode === 'pdf' ? (
										<Trans>Upload PDF (max 10 MB)</Trans>
									) : mode === 'image' ? (
										<Trans>Upload photo (JPG, PNG, or WebP, max 10 MB)</Trans>
									) : (
										<Trans>
											Upload spreadsheet (CSV, TSV, or XLSX, max 10 MB)
										</Trans>
									)}
								</Label>
								<Input
									id={fileInputId}
									name="file"
									type="file"
									accept={acceptForMode}
									required
									disabled={disabled || Boolean(activeImport)}
								/>
							</div>
						)}

						<div>
							<Button
								type="submit"
								disabled={
									disabled ||
									Boolean(activeImport) ||
									isSubmitting ||
									(mode === 'url' && !confirmedOwnership)
								}
							>
								<Icon name="arrow-up-from-line" className="mr-1.5 size-4" />
								{isSubmitting ? (
									<Trans>Starting import…</Trans>
								) : (
									<Trans>Start menu import</Trans>
								)}
							</Button>
						</div>
					</Form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Recent imports</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Leave and come back anytime to review, apply, or cancel an import.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{imports.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No menu imports yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Source</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead>
										<Trans>Started</Trans>
									</TableHead>
									<TableHead>
										<Trans>Details</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Action</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{imports.map((row) => (
									<TableRow key={row.id}>
										<TableCell className="wrap-anywhere">
											<span className="font-medium">
												{_(SOURCE_LABELS[row.sourceKind] ?? SOURCE_LABELS.url!)}
											</span>
											{row.sourceUrl ? (
												<div className="text-muted-foreground text-xs">
													{row.sourceUrl}
												</div>
											) : null}
										</TableCell>
										<TableCell>
											<Badge variant={statusVariant(row.status)}>
												{_(STATUS_LABELS[row.status] ?? STATUS_LABELS.queued!)}
											</Badge>
										</TableCell>
										<TableCell className="text-sm tabular-nums">
											{new Intl.DateTimeFormat(i18n.locale, {
												dateStyle: 'medium',
												timeStyle: 'short',
											}).format(new Date(row.createdAt))}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm wrap-anywhere">
											{row.error
												? _(
														IMPORT_ERRORS[row.error] ??
															IMPORT_ERRORS.extract_failed!,
													)
												: ''}
										</TableCell>
										<TableCell className="text-right">
											<Button
												size="sm"
												variant="outline"
												render={
													<Link to={`/${orgSlug}/menu/import/${row.id}`} />
												}
											>
												{row.status === 'ready' ? (
													<Trans>Review</Trans>
												) : (
													<Trans>Open</Trans>
												)}
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
