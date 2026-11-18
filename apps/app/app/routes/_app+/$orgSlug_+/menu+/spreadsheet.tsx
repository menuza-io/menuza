import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { currencyCodeForDataRegion } from '#app/utils/menu/bulk-apply.server.ts'
import { isMenuBulkEditKillSwitchOn } from '#app/utils/menu/bulk-edit-switch.server.ts'
import { requireMenuBulkEditAccess } from '#app/utils/menu/menu-feature-access.server.ts'
import {
	applySpreadsheet,
	loadSpreadsheetDishes,
	previewSpreadsheet,
	type SpreadsheetPreview,
} from '#app/utils/menu/menu-spreadsheet.server.ts'
import {
	buildMenuSpreadsheet,
	SPREADSHEET_MAX_BYTES,
	type SpreadsheetAvailability,
	type SpreadsheetColumn,
	type SpreadsheetProblem,
} from '#app/utils/menu/menu-spreadsheet.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/**
 * Menu > Spreadsheet (#411): download every dish with its price, order-type
 * prices and availability, edit it in Excel, upload, check the preview, apply.
 * Part of bulk edit (#72): the same flag, kill switch, snapshot and activity
 * log entry.
 */

function bulkEditOff() {
	return isMenuBulkEditKillSwitchOn(
		process.env as { MENU_BULK_EDIT_ENABLED?: string },
	)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
	})
	await requireMenuBulkEditAccess(request, organization.id)
	const url = new URL(request.url)
	if (url.searchParams.get('download') === '1') {
		const dishes = await loadSpreadsheetDishes(
			organization.id,
			organization.siteDefaultLocale || 'en',
		)
		return new Response(buildMenuSpreadsheet(dishes), {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="${organization.slug}-menu-prices.csv"`,
				'Cache-Control': 'private, no-store',
			},
		})
	}
	return {
		orgSlug: organization.slug,
		currency: currencyCodeForDataRegion(organization.dataRegion),
		disabled: bulkEditOff(),
	}
}

const BodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('preview'),
		csv: z.string().max(SPREADSHEET_MAX_BYTES),
	}),
	z.object({
		intent: z.literal('apply'),
		csv: z.string().max(SPREADSHEET_MAX_BYTES),
		stamps: z.record(z.string(), z.string()),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	if (bulkEditOff()) {
		return Response.json({ error: 'bulk_edit_disabled' }, { status: 503 })
	}
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})
	await requireMenuBulkEditAccess(request, organization.id)
	const userId = await requireMenuWrite(request, organization.id)
	let raw: unknown
	try {
		raw = await request.json()
	} catch {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}
	const parsed = BodySchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}
	const locale = organization.siteDefaultLocale || 'en'
	if (parsed.data.intent === 'preview') {
		const result = await previewSpreadsheet(
			organization.id,
			locale,
			parsed.data.csv,
		)
		return result.ok
			? Response.json({ preview: result.preview })
			: Response.json({ error: result.error }, { status: 422 })
	}
	const result = await applySpreadsheet({
		organizationId: organization.id,
		organizationSlug: organization.slug,
		userId,
		locale,
		csv: parsed.data.csv,
		stamps: parsed.data.stamps,
		request,
	})
	if (!result.ok) {
		return Response.json(result, {
			status: result.error === 'stale_rows' ? 409 : 422,
		})
	}
	return Response.json(result)
}

const ERRORS: Record<string, MessageDescriptor> = {
	not_template: msg`This file does not match the template. Download the template, change only the price and availability columns, and upload it again.`,
	empty: msg`The file is empty.`,
	too_many_rows: msg`The file has too many rows (2,000 at most).`,
	has_problems: msg`Fix the rows listed below first. Nothing was changed.`,
	stale_rows: msg`Some dishes changed since the preview. Check the file again.`,
	bulk_edit_disabled: msg`Bulk changes are switched off right now.`,
	invalid_body: msg`The file could not be read.`,
}

const PROBLEMS: Record<SpreadsheetProblem, MessageDescriptor> = {
	unknown_dish: msg`No dish has this id.`,
	duplicate_row: msg`This dish is in the file twice.`,
	bad_price: msg`This is not a price.`,
	bad_availability: msg`Use available, sold out or hidden.`,
	variation_price: msg`This dish has variations: change its prices on the dish page.`,
}

const COLUMNS: Record<SpreadsheetColumn, MessageDescriptor> = {
	id: msg`Id`,
	dish: msg`Dish`,
	category: msg`Category`,
	price: msg`Price`,
	dine_in_price: msg`Dine-in price`,
	pickup_price: msg`Pickup price`,
	delivery_price: msg`Delivery price`,
	availability: msg`Availability`,
}

const AVAILABILITY: Record<SpreadsheetAvailability, MessageDescriptor> = {
	available: msg`Available`,
	sold_out: msg`Sold out`,
	hidden: msg`Hidden`,
}

export default function MenuSpreadsheet() {
	const { _, i18n } = useLingui()
	const { orgSlug, currency, disabled } = useLoaderData<typeof loader>()
	const preview = useFetcher<{ preview?: SpreadsheetPreview; error?: string }>()
	const apply = useFetcher<{ ok?: boolean; applied?: number; error?: string }>()
	const [csv, setCsv] = useState<string | null>(null)
	const [fileError, setFileError] = useState<string | null>(null)
	const money = (amount: number) =>
		new Intl.NumberFormat(i18n.locale, { style: 'currency', currency }).format(
			amount,
		)

	const onFile = async (file: File | undefined) => {
		setFileError(null)
		if (!file) return
		if (file.size > SPREADSHEET_MAX_BYTES) {
			setFileError(_(msg`The file is too large (1 MB at most).`))
			return
		}
		const text = await file.text()
		setCsv(text)
		void preview.submit(
			{ intent: 'preview', csv: text },
			{ method: 'post', encType: 'application/json' },
		)
	}

	const data = preview.data?.preview
	const changeCount = data?.changes.length ?? 0
	const problemCount = data?.problems.length ?? 0
	const rowCount = data?.rows ?? 0
	const appliedCount = apply.data?.applied ?? 0
	const errorCode = apply.data?.error ?? preview.data?.error
	const changedValue = (
		change: SpreadsheetPreview['changes'][number],
		field: SpreadsheetColumn,
		side: 'before' | 'after',
	) => {
		const values = change[side]
		if (field === 'price') return money(values.price)
		if (field === 'availability') return _(AVAILABILITY[values.availability])
		const type =
			field === 'dine_in_price'
				? 'dine_in'
				: field === 'pickup_price'
					? 'pickup'
					: 'delivery'
		const value = values.orderTypePrices?.[type]
		return value === undefined ? _(msg`Base price`) : money(value)
	}

	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Update prices from a spreadsheet</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Download the template, change prices or availability in Excel or
							any spreadsheet app, and upload it. Blank cells change nothing. A
							dash (-) in a dine-in, pickup or delivery price removes it. You
							see every change before it is applied.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div>
						<Button
							variant="outline"
							render={
								<a href={`/${orgSlug}/menu/spreadsheet?download=1`} download />
							}
						>
							<Trans>Download template</Trans>
						</Button>
					</div>
					<div className="max-w-sm space-y-1.5">
						<Label htmlFor="menu-spreadsheet-file">
							<Trans>Upload the edited file (CSV)</Trans>
						</Label>
						<Input
							id="menu-spreadsheet-file"
							type="file"
							accept=".csv,text/csv"
							disabled={disabled}
							onChange={(event) => void onFile(event.target.files?.[0])}
						/>
					</div>
					{disabled ? (
						<p className="text-muted-foreground text-sm">
							{_(ERRORS.bulk_edit_disabled!)}
						</p>
					) : null}
					{fileError || errorCode ? (
						<p role="alert" className="text-destructive text-sm">
							{fileError ?? _(ERRORS[errorCode!] ?? ERRORS.invalid_body!)}
						</p>
					) : null}
					{apply.data?.ok ? (
						<p role="status" className="text-sm">
							<Trans>{appliedCount} dishes updated.</Trans>
						</p>
					) : null}
				</CardContent>
			</Card>

			{data ? (
				<Card data-testid="spreadsheet-preview">
					<CardHeader>
						<CardTitle>
							<Trans>Preview</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								{changeCount} changes and {problemCount} problems in {rowCount}{' '}
								rows.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{data.problems.length > 0 ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Row</Trans>
										</TableHead>
										<TableHead>
											<Trans>Column</Trans>
										</TableHead>
										<TableHead>
											<Trans>Problem</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.problems.map((problem) => (
										<TableRow key={`${problem.row}:${problem.column ?? ''}`}>
											<TableCell className="tabular-nums">
												{problem.row}
											</TableCell>
											<TableCell>
												{problem.column ? _(COLUMNS[problem.column]) : ''}
											</TableCell>
											<TableCell>
												<Badge variant="destructive">
													{_(PROBLEMS[problem.problem])}
												</Badge>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						) : null}
						{data.changes.length > 0 ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Dish</Trans>
										</TableHead>
										<TableHead>
											<Trans>Change</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.changes.map((change) => (
										<TableRow key={change.itemId}>
											<TableCell className="wrap-anywhere">
												{change.name}
											</TableCell>
											<TableCell>
												<ul className="flex flex-col gap-0.5">
													{change.fields.map((field) => (
														<li key={field} className="tabular-nums">
															{_(COLUMNS[field])}:{' '}
															{changedValue(change, field, 'before')} →{' '}
															{changedValue(change, field, 'after')}
														</li>
													))}
												</ul>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						) : null}
						<div>
							<Button
								disabled={
									!csv ||
									disabled ||
									data.problems.length > 0 ||
									data.changes.length === 0 ||
									apply.state !== 'idle'
								}
								onClick={() =>
									void apply.submit(
										{ intent: 'apply', csv: csv ?? '', stamps: data.stamps },
										{ method: 'post', encType: 'application/json' },
									)
								}
							>
								<Trans>Apply {changeCount} changes</Trans>
							</Button>
						</div>
					</CardContent>
				</Card>
			) : null}
		</div>
	)
}
