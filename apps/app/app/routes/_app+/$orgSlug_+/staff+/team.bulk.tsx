import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { SelectField, TextAreaField } from '#app/components/staff/controls.tsx'
import { ReviewRows } from '#app/components/staff/review-rows.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { useTeamContext } from '#app/components/staff/team-context.ts'
import { useStaffClient } from '#app/hooks/use-staff-client.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { defaultDialCode } from '#app/utils/staffing/staff-format.ts'
import {
	draftsFromRows,
	IMPORT_MAX_ROWS,
	parseStaffText,
	reviewDrafts,
	toCreatePayload,
	type DraftRow,
} from '#app/utils/staffing/staff-import.ts'
import {
	bulkResultSchema,
	type BulkResult,
} from '#app/utils/staffing/staff-types.ts'
import { type Route } from './+types/team.bulk.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, STAFF_WRITE_REQUIREMENT)
	return null
}

const MAX_FILE_BYTES = 1_000_000

type Step = 'input' | 'review' | 'done'

export default function BulkAddRoute() {
	const { _ } = useLingui()
	const { client } = useStaffClient('staff')
	const { scopes, reloadRoster, close } = useTeamContext()
	const dialCode = defaultDialCode(scopes.map((scope) => scope.currency))
	const fileInput = useRef<HTMLInputElement>(null)

	const [step, setStep] = useState<Step>('input')
	const [text, setText] = useState('')
	const [fileError, setFileError] = useState<string | null>(null)
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	const [drafts, setDrafts] = useState<DraftRow[]>([])
	const [truncated, setTruncated] = useState(false)
	const [inputError, setInputError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	const [submitError, setSubmitError] = useState<string | null>(null)
	const [result, setResult] = useState<{
		data: BulkResult
		failed: Array<{ name: string; reason: string }>
	} | null>(null)

	const reviewed = useMemo(
		() => reviewDrafts(drafts, dialCode),
		[drafts, dialCode],
	)
	const ready = reviewed.filter((row) => row.problems.length === 0)
	const needFix = reviewed.length - ready.length
	const readyCount = ready.length

	async function onFile(file: File | undefined) {
		setFileError(null)
		if (!file) return
		if (file.size > MAX_FILE_BYTES) {
			setFileError(_(t`That file is too large. Use a file under 1 MB.`))
			return
		}
		try {
			setText(await file.text())
		} catch {
			setFileError(_(t`We could not read that file.`))
		}
	}

	function review(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const parsed = parseStaffText(text, { defaultDialCode: dialCode })
		if (parsed.rows.length === 0) {
			setInputError(_(t`Add at least one person to continue.`))
			return
		}
		setInputError(null)
		setTruncated(parsed.truncated)
		setDrafts(draftsFromRows(parsed.rows))
		setStep('review')
	}

	async function confirm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending || ready.length === 0) return
		setPending(true)
		setSubmitError(null)
		try {
			const sent = ready.map((row) => ({
				row,
				payload: toCreatePayload(row, scopeId || null, dialCode)!,
			}))
			const data = bulkResultSchema.parse(
				await client.request('/bulk', {
					method: 'POST',
					json: { members: sent.map((item) => item.payload) },
				}),
			)
			const failed = data.results.flatMap((item) => {
				if (item.status !== 'invalid' && item.status !== 'conflict') return []
				const source = sent[item.index]?.row
				return [
					{
						name: source ? `${source.firstName} ${source.lastName}` : '',
						reason:
							item.status === 'conflict'
								? _(t`Already exists.`)
								: _(t`The service could not accept this row.`),
					},
				]
			})
			setResult({ data, failed })
			setStep('done')
			reloadRoster()
			const created = data.summary.created
			toast.success(
				plural(created, {
					one: '# person added',
					other: '# people added',
				}),
			)
		} catch (error) {
			setSubmitError(describeStaffError(error, _))
		} finally {
			setPending(false)
		}
	}

	if (step === 'done' && result) {
		const { created: addedCount, existing: existingCount } = result.data.summary
		const notAddedCount = result.failed.length
		return (
			<SheetForm
				title={_(t`Bulk add finished`)}
				onSubmit={(event) => {
					event.preventDefault()
					close()
				}}
				footer={
					<Button type="submit">
						<Trans>Done</Trans>
					</Button>
				}
			>
				<p role="status" className="text-sm">
					<Trans>
						{addedCount} added, {existingCount} already on your team,{' '}
						{notAddedCount} not added.
					</Trans>
				</p>
				{result.failed.length > 0 ? (
					<ul className="text-sm">
						{result.failed.map((item, index) => (
							<li key={index} className="text-destructive">
								{item.name}: {item.reason}
							</li>
						))}
					</ul>
				) : null}
			</SheetForm>
		)
	}

	if (step === 'review') {
		return (
			<SheetForm
				title={_(t`Review before adding`)}
				description={_(
					t`Nothing is saved until you confirm. Fix a row here or remove it.`,
				)}
				onSubmit={(event) => void confirm(event)}
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => setStep('input')}
						>
							<Trans>Back</Trans>
						</Button>
						<Button type="submit" disabled={pending || ready.length === 0}>
							{pending
								? _(t`Adding…`)
								: plural(readyCount, {
										one: 'Add # person',
										other: 'Add # people',
									})}
						</Button>
					</>
				}
			>
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						{readyCount} ready, {needFix} need a fix. Rows with a problem are
						skipped.
					</Trans>
				</p>
				{truncated ? (
					<p className="text-sm">
						<Trans>
							Only the first {IMPORT_MAX_ROWS} rows were read. Add the rest in a
							second batch.
						</Trans>
					</p>
				) : null}
				<ReviewRows
					rows={reviewed}
					editable={['name', 'contact']}
					onChange={(id, patch) =>
						setDrafts((current) =>
							current.map((draft) =>
								draft.id === id ? { ...draft, ...patch } : draft,
							),
						)
					}
					onRemove={(id) =>
						setDrafts((current) => current.filter((draft) => draft.id !== id))
					}
				/>
				{submitError ? (
					<Alert variant="destructive">
						<AlertDescription>{submitError}</AlertDescription>
					</Alert>
				) : null}
			</SheetForm>
		)
	}

	return (
		<SheetForm
			title={_(t`Bulk add`)}
			description={_(t`Paste a list or choose a CSV file. You review it next.`)}
			onSubmit={review}
			footer={
				<>
					<Button type="button" variant="outline" onClick={close}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit">
						<Trans>Review list</Trans>
					</Button>
				</>
			}
		>
			<TextAreaField
				label={<Trans>People</Trans>}
				value={text}
				onChange={(event) => setText(event.target.value)}
				rows={9}
				dir="auto"
				placeholder={'Dana Lee, +14155550123\nSam Cook, sam@example.com'}
				hint={_(
					t`One person per line: name, then phone or email. A header row with Name, Phone and Email also works.`,
				)}
				error={inputError}
			/>
			<div className="flex flex-col items-start gap-2">
				<input
					ref={fileInput}
					type="file"
					accept=".csv,.tsv,.txt,text/csv,text/plain"
					className="sr-only"
					tabIndex={-1}
					aria-hidden="true"
					onChange={(event) => {
						void onFile(event.target.files?.[0])
						event.target.value = ''
					}}
				/>
				<Button
					type="button"
					variant="outline"
					onClick={() => fileInput.current?.click()}
				>
					<Trans>Choose a CSV file</Trans>
				</Button>
				{fileError ? (
					<Alert variant="destructive">
						<AlertDescription>{fileError}</AlertDescription>
					</Alert>
				) : null}
			</div>
			{scopes.length > 1 ? (
				<SelectField
					label={<Trans>Workplace</Trans>}
					value={scopeId}
					onValueChange={setScopeId}
					options={scopes.map((item) => ({
						value: item.id,
						label: item.name,
					}))}
					hint={_(t`Everyone in this batch is added to this workplace.`)}
				/>
			) : null}
		</SheetForm>
	)
}
