import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	parseSalesCsv,
	SALES_CSV_DATE_ORDERS,
	SALES_CSV_MAX_BYTES,
	type SalesCsvDateOrder,
} from '@repo/staffing'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldError } from '@repo/ui/field'
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableRow,
} from '@repo/ui/table'
import { Textarea } from '@repo/ui/textarea'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { saveSalesBulk } from '#app/utils/staffing/labor-api.ts'
import {
	CSV_ERROR_MESSAGES,
	describeLaborError,
} from '#app/utils/staffing/labor-errors.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'

const PREVIEW_ROWS = 5
const SHOWN_ERRORS = 8

/**
 * Daily sales from a spreadsheet saved as CSV (a register export, for
 * example). The file is read here in the browser with the same parser the
 * tests cover, shown back as a preview with every line it could not read, and
 * only the readable days are sent. Days already entered are replaced; nothing
 * is guessed: an unreadable line is named and left out.
 */
export function SalesImportDialog({
	client,
	scopeId,
	currency,
	onClose,
	onImported,
}: {
	client: StaffClient
	scopeId: string
	currency: string
	onClose: () => void
	onImported: () => void
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [text, setText] = useState('')
	const [dateOrder, setDateOrder] = useState<SalesCsvDateOrder>('iso')
	const [fileProblem, setFileProblem] = useState<string | null>(null)
	const fileRef = useRef<HTMLInputElement>(null)
	const action = useStaffAction(describeLaborError)

	const parsed = useMemo(
		() => (text.trim() === '' ? null : parseSalesCsv(text, { dateOrder })),
		[text, dateOrder],
	)

	async function readFile(file: File | undefined) {
		if (!file) return
		if (file.size > SALES_CSV_MAX_BYTES) {
			setFileProblem(_(t`That file is too large. Split it into smaller files.`))
			return
		}
		setFileProblem(null)
		setText(await file.text())
	}

	async function submit() {
		if (!parsed || parsed.rows.length === 0 || action.pending) return
		const result = await action.run(() =>
			saveSalesBulk(client, {
				scopeId,
				currency,
				entries: parsed.rows.map((row) => ({
					date: row.date,
					netSalesMinor: row.netSalesMinor,
					note: row.note,
				})),
			}),
		)
		if (result.ok) {
			const { created, updated, unchanged } = result.value
			toast.success(
				_(
					t`Imported: ${created} added, ${updated} changed, ${unchanged} already the same.`,
				),
			)
			onImported()
			onClose()
		}
	}

	const dateOrderLabels: Record<SalesCsvDateOrder, string> = {
		iso: _(t`2026-03-31 (year first)`),
		mdy: _(t`03/31/2026 (month first)`),
		dmy: _(t`31/03/2026 (day first)`),
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Import daily sales</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Use a CSV file with a Date column and a Net sales column. Days you
							have already entered are replaced.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="flex flex-wrap items-center gap-2">
						<input
							ref={fileRef}
							type="file"
							accept=".csv,.txt,text/csv,text/plain"
							className="sr-only"
							aria-label={_(t`Choose a CSV file`)}
							onChange={(event) => void readFile(event.target.files?.[0])}
						/>
						<Button
							type="button"
							variant="outline"
							onClick={() => fileRef.current?.click()}
						>
							<Trans>Choose a file</Trans>
						</Button>
						<span className="text-muted-foreground text-sm">
							<Trans>or paste it below</Trans>
						</span>
					</div>
					{fileProblem ? <FieldError>{fileProblem}</FieldError> : null}
					<Textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						rows={5}
						dir="ltr"
						spellCheck={false}
						aria-label={_(t`CSV text`)}
						placeholder={'Date,Net sales\n2026-03-30,1250.50'}
						className="font-mono text-xs"
					/>
					<SelectField
						label={<Trans>How dates are written in the file</Trans>}
						value={dateOrder}
						onValueChange={(value) => setDateOrder(value as SalesCsvDateOrder)}
						options={SALES_CSV_DATE_ORDERS.map((value) => ({
							value,
							label: dateOrderLabels[value],
						}))}
					/>

					{parsed ? (
						<div className="flex flex-col gap-3" aria-live="polite">
							<p className="text-sm font-medium">
								{parsed.rows.length > 0
									? plural(parsed.rows.length, {
											one: '# day is ready to import.',
											other: '# days are ready to import.',
										})
									: _(t`Nothing in this file can be imported yet.`)}
								{parsed.errors.length > 0
									? ` ${plural(parsed.errors.length, {
											one: '# line was skipped.',
											other: '# lines were skipped.',
										})}`
									: ''}
							</p>
							{parsed.rows.length > 0 ? (
								<Table>
									<TableCaption className="sr-only">
										<Trans>Preview of the first days</Trans>
									</TableCaption>
									<TableBody>
										{parsed.rows.slice(0, PREVIEW_ROWS).map((row) => (
											<TableRow key={row.date}>
												<TableCell>
													{formatDateLabel(row.date, locale)}
												</TableCell>
												<TableCell className="text-end tabular-nums">
													{formatMoneyMinor(
														row.netSalesMinor,
														currency,
														locale,
													)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : null}
							{parsed.errors.length > 0 ? (
								<ul className="text-destructive flex flex-col gap-1 text-sm">
									{parsed.errors.slice(0, SHOWN_ERRORS).map((error, index) => (
										<li key={`${error.line}:${index}`}>
											{error.line > 0 ? <LineLabel line={error.line} /> : null}
											{_(CSV_ERROR_MESSAGES[error.code])}
										</li>
									))}
									{parsed.errors.length > SHOWN_ERRORS ? (
										<li className="text-muted-foreground">
											{plural(parsed.errors.length - SHOWN_ERRORS, {
												one: 'and # more line',
												other: 'and # more lines',
											})}
										</li>
									) : null}
								</ul>
							) : null}
						</div>
					) : null}
					{action.error ? <FieldError>{action.error}</FieldError> : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={action.pending}
						onClick={onClose}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={action.pending || !parsed || parsed.rows.length === 0}
						onClick={() => void submit()}
					>
						{action.pending ? <Trans>Importing…</Trans> : <Trans>Import</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function LineLabel({ line }: { line: number }) {
	return <Trans>Line {line}: </Trans>
}
