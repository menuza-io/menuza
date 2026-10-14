import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { FieldError } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Separator } from '@repo/ui/separator'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { SheetForm, SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { StaffApiError } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import {
	createCard,
	reviewCard,
	runBatchOp,
	updateCard,
	voidCard,
} from '#app/utils/staffing/timesheet-api.ts'
import { describeTimesheetError } from '#app/utils/staffing/timesheet-errors.ts'
import {
	buildCreateBody,
	buildUpdateBody,
	cardToForm,
	emptyForm,
	validateCardForm,
	type CardForm,
	type FormErrors,
} from '#app/utils/staffing/timesheet-form.ts'
import {
	cardDetailSchema,
	type CardDetail,
} from '#app/utils/staffing/timesheet-types.ts'
import {
	cardActions,
	displayName,
	formatDateLabel,
	isReviewIssue,
	sortIssues,
	type BatchOp,
} from '#app/utils/staffing/timesheet-view.ts'
import { CardFields } from './card-fields.tsx'
import { CardHistory } from './card-history.tsx'
import { IssueChips, StatusBadge, useIssueText } from './card-status.tsx'
import { PersonPicker, type PickedPerson } from './person-picker.tsx'
import { ReasonDialog } from './reason-dialog.tsx'
import { ReasonField } from './reason-field.tsx'
import { useTimesheetsContext } from './timesheets-context.ts'
import { usePositionOptions } from './use-position-options.ts'

const footerButton = ''

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * One time card in a sheet over the list: its figures, an edit form with a
 * required reason, what happened to it so far, and approve, reopen or delete.
 * It fetches the card itself so a link to it works on its own.
 */
export function EditCardSheet({ entryId }: { entryId: string }) {
	const { _ } = useLingui()
	const ctx = useTimesheetsContext()
	const { client, ready, unavailable } = useStaffClient('timeclock')
	const detail = useStaffQuery(
		client,
		ready ? `/timesheets/entries/${encodeURIComponent(entryId)}` : null,
		cardDetailSchema,
	)

	if (detail.data) {
		return (
			<EditCardBody
				// A new version (after approve, reopen or a save) starts the form over.
				key={`${detail.data.card.id}:${detail.data.card.version}`}
				detail={detail.data}
				reloadDetail={detail.reload}
			/>
		)
	}
	if (unavailable || detail.error) {
		return (
			<SheetPanel title={_(t`Time card`)}>
				<Alert variant="destructive">
					<AlertDescription>
						{unavailable
							? _(t`We could not confirm your access. Reload the page.`)
							: describeTimesheetError(detail.error, _)}
					</AlertDescription>
				</Alert>
				<Button variant="outline" className={footerButton} onClick={ctx.close}>
					<Trans>Back to the list</Trans>
				</Button>
			</SheetPanel>
		)
	}
	return (
		<SheetPanel title={_(t`Time card`)}>
			<div role="status" className="flex flex-col gap-3">
				<span className="sr-only">
					<Trans>Loading the time card</Trans>
				</span>
				<Skeleton className="h-6 w-2/3" />
				<Skeleton className="h-11 w-full" />
				<Skeleton className="h-11 w-full" />
				<Skeleton className="h-24 w-full" />
			</div>
		</SheetPanel>
	)
}

type Dialog = null | 'void' | 'reopen' | 'unlock'

function EditCardBody({
	detail,
	reloadDetail,
}: {
	detail: CardDetail
	reloadDetail: () => void
}) {
	const { _, i18n } = useLingui()
	const ctx = useTimesheetsContext()
	const text = useIssueText()
	const { client } = useStaffClient('timeclock')
	const { card, person } = detail
	const locale = i18n.locale
	const mode = ctx.approvalMode(card.scopeId)
	const actions = cardActions(card, mode, ctx.can)
	const locked = card.status === 'approved' || card.status === 'locked'
	const name = displayName(person, locale)
	const place = ctx.scopes.find((item) => item.id === card.scopeId)?.name
	const positionMap = useMemo(
		() => new Map(ctx.positions.map((item) => [item.id, item])),
		[ctx.positions],
	)

	const [form, setForm] = useState<CardForm>(() => cardToForm(card))
	const [errors, setErrors] = useState<FormErrors>({})
	const [dialog, setDialog] = useState<Dialog>(null)
	const save = useStaffAction(describeTimesheetError)
	const side = useStaffAction(describeTimesheetError)
	const positions = usePositionOptions(
		person.staffId,
		card.scopeId,
		ctx.positions,
		locale,
	)

	const dirty = useMemo(
		() => buildUpdateBody(card, form, ctx.can.money).changed,
		[card, form, ctx.can.money],
	)
	const reviewIssues = sortIssues(card.issues).filter(isReviewIssue)

	function patch(next: Partial<CardForm>) {
		setForm((current) => ({ ...current, ...next }))
		setErrors({})
		save.reset()
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (save.pending || !actions.edit) return
		const found = validateCardForm(
			form,
			{
				mode: 'edit',
				timeZone: card.timeZone,
				now: ctx.now(),
				original: card,
				moneyVisible: ctx.can.money,
			},
			_,
		)
		const { changed, body } = buildUpdateBody(card, form, ctx.can.money)
		if (!found.reason && !changed) {
			found.form = _(t`Nothing about this card has changed yet.`)
		}
		setErrors(found)
		if (Object.keys(found).length > 0) return
		const result = await save.run(() => updateCard(client, card.id, body))
		if (result.ok) {
			toast.success(_(t`Time card for ${name} saved.`))
			ctx.reload()
			ctx.close()
		}
	}

	async function batch(op: BatchOp, reason?: string): Promise<boolean> {
		const result = await side.run(async () => {
			const answer = await runBatchOp(
				client,
				op,
				[{ id: card.id, version: card.version }],
				reason,
			)
			const first = answer.results[0]
			if (!first?.ok) {
				throw new StaffApiError(409, first?.code ?? 'not_found')
			}
			return answer
		})
		if (result.ok) {
			ctx.reload()
			reloadDetail()
		}
		return result.ok
	}

	async function markReviewed() {
		const result = await side.run(() =>
			reviewCard(client, card.id, { expectedVersion: card.version }),
		)
		if (result.ok) {
			toast.success(_(t`Marked as reviewed.`))
			ctx.reload()
			ctx.close()
		}
	}

	async function approve() {
		if (await batch('approve')) toast.success(_(t`Approved.`))
	}

	async function remove(reason: string): Promise<boolean> {
		const result = await side.run(() =>
			voidCard(client, card.id, { expectedVersion: card.version, reason }),
		)
		if (result.ok) {
			toast.success(_(t`Time card deleted.`))
			ctx.reload()
			ctx.close()
		}
		return result.ok
	}

	const description = [formatDateLabel(card.localDate, locale), place]
		.filter(Boolean)
		.join(' · ')

	return (
		<>
			<SheetForm
				title={name}
				description={description}
				onSubmit={(event) => void submit(event)}
				footer={
					<>
						{actions.edit && ctx.can.update ? (
							<Button
								type="button"
								variant="ghost"
								className={`${footerButton} text-destructive hover:text-destructive sm:me-auto`}
								disabled={save.pending}
								onClick={() => {
									side.reset()
									setDialog('void')
								}}
							>
								<Icon name="trash-2" />
								<Trans>Delete card</Trans>
							</Button>
						) : null}
						<Button
							type="button"
							variant="outline"
							className={footerButton}
							onClick={ctx.close}
						>
							{actions.edit ? <Trans>Cancel</Trans> : <Trans>Close</Trans>}
						</Button>
						{actions.review && !dirty ? (
							<Button
								type="button"
								variant="outline"
								className={footerButton}
								disabled={side.pending}
								onClick={() => void markReviewed()}
							>
								<Icon name="check" />
								<Trans>Looks right</Trans>
							</Button>
						) : null}
						{actions.approve && !dirty ? (
							<Button
								type="button"
								variant="outline"
								className={footerButton}
								disabled={side.pending}
								onClick={() => void approve()}
							>
								<Icon name="circle-check" />
								<Trans>Approve</Trans>
							</Button>
						) : null}
						{actions.edit ? (
							<Button
								type="submit"
								className={footerButton}
								disabled={save.pending}
							>
								{save.pending ? (
									<Trans>Saving…</Trans>
								) : (
									<Trans>Save changes</Trans>
								)}
							</Button>
						) : null}
					</>
				}
			>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<StatusBadge status={card.status} />
						<IssueChips issues={card.issues} max={4} />
					</div>
					{reviewIssues.length > 0 && !locked ? (
						<ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
							{reviewIssues.map((code) => (
								<li key={code}>
									<span className="text-foreground font-medium">
										{text.label(code)}.
									</span>{' '}
									{text.help(code)}
								</li>
							))}
						</ul>
					) : null}
					{card.figuresChanged ? (
						<p className="text-sm">
							<Trans>
								Overtime moved after this card was approved. Reopen it and check
								the new figures before you pay.
							</Trans>
						</p>
					) : null}
				</div>

				{locked ? (
					<div className="bg-muted/50 flex flex-col gap-3 rounded-lg p-3 text-sm">
						<p>
							{card.status === 'locked' ? (
								<Trans>
									This card is locked. Unlock it to change it, and say why.
								</Trans>
							) : (
								<Trans>
									This card is approved. Reopen it to change it, and say why.
								</Trans>
							)}
						</p>
						{actions.unlock || actions.reopen ? (
							<div>
								<Button
									type="button"
									variant="outline"
									className={footerButton}
									onClick={() => {
										side.reset()
										setDialog(actions.unlock ? 'unlock' : 'reopen')
									}}
								>
									<Icon name="unlock" />
									{actions.unlock ? (
										<Trans>Unlock card</Trans>
									) : (
										<Trans>Reopen card</Trans>
									)}
								</Button>
							</div>
						) : (
							<p className="text-muted-foreground">
								<Trans>
									Ask someone who can approve time cards to reopen it.
								</Trans>
							</p>
						)}
					</div>
				) : !ctx.can.update ? (
					<p className="bg-muted/50 rounded-lg p-3 text-sm">
						<Trans>You can look at this card but not change it.</Trans>
					</p>
				) : null}

				<CardFields
					form={form}
					onChange={patch}
					errors={errors}
					timeZone={card.timeZone}
					disabled={!actions.edit}
					moneyVisible={ctx.can.money && card.money !== undefined}
					positionOptions={positions.options}
				/>

				{actions.edit ? (
					<ReasonField
						value={form.reason}
						onChange={(reason) => patch({ reason })}
						error={errors.reason}
						label={_(t`Why are you changing this?`)}
					/>
				) : null}

				{errors.form || save.error || side.error ? (
					<FieldError>
						{errors.form ?? save.error ?? (dialog ? null : side.error)}
					</FieldError>
				) : null}

				<Separator />
				<CardHistory
					edits={detail.edits}
					punches={detail.punches}
					timeZone={card.timeZone}
					locale={locale}
					currency={card.money?.currency ?? null}
					positions={positionMap}
				/>
			</SheetForm>

			{dialog === 'void' ? (
				<ReasonDialog
					destructive
					title={<Trans>Delete this time card?</Trans>}
					description={
						<Trans>
							The card is removed from the hours. It stays in the history with
							your reason, and {name} is not paid for it.
						</Trans>
					}
					confirmLabel={<Trans>Delete card</Trans>}
					pendingLabel={<Trans>Deleting…</Trans>}
					pending={side.pending}
					error={side.error}
					onConfirm={remove}
					onClose={() => setDialog(null)}
				/>
			) : null}
			{dialog === 'reopen' || dialog === 'unlock' ? (
				<ReasonDialog
					title={
						dialog === 'unlock' ? (
							<Trans>Unlock this card?</Trans>
						) : (
							<Trans>Reopen this card?</Trans>
						)
					}
					description={
						dialog === 'unlock' ? (
							<Trans>
								It goes back to approved and can be reopened for edits. The
								unlock is logged.
							</Trans>
						) : (
							<Trans>
								It goes back to review so it can be edited, and has to be
								approved again. The change is logged.
							</Trans>
						)
					}
					confirmLabel={
						dialog === 'unlock' ? <Trans>Unlock</Trans> : <Trans>Reopen</Trans>
					}
					pendingLabel={<Trans>Working…</Trans>}
					pending={side.pending}
					error={side.error}
					onConfirm={(reason) => batch(dialog, reason)}
					onClose={() => setDialog(null)}
				/>
			) : null}
		</>
	)
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

/** Add a time card for someone who forgot to punch, or a shift that never went through the tablet. */
export function NewCardSheet() {
	const { _, i18n } = useLingui()
	const ctx = useTimesheetsContext()
	const locale = i18n.locale
	const { client } = useStaffClient('timeclock')
	const { client: staffClient } = useStaffClient('staff')
	const [form, setForm] = useState<CardForm>(() =>
		emptyForm({
			scopeId: ctx.defaultScopeId,
			date: ctx.defaultDate,
		}),
	)
	const [person, setPerson] = useState<PickedPerson | null>(null)
	const [errors, setErrors] = useState<FormErrors>({})
	const save = useStaffAction(describeTimesheetError)
	const positions = usePositionOptions(
		person?.id ?? null,
		form.scopeId,
		ctx.positions,
		locale,
	)
	const scope = ctx.scopes.find((item) => item.id === form.scopeId)

	function patch(next: Partial<CardForm>) {
		setForm((current) => ({ ...current, ...next }))
		setErrors({})
		save.reset()
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (save.pending) return
		const found = validateCardForm(
			form,
			{
				mode: 'create',
				timeZone: scope?.timeZone ?? 'UTC',
				now: ctx.now(),
				moneyVisible: ctx.can.money,
				positionRequired: (positions.options?.length ?? 0) > 1,
			},
			_,
		)
		setErrors(found)
		if (Object.keys(found).length > 0) return
		const result = await save.run(() =>
			createCard(client, buildCreateBody(form, ctx.can.money)),
		)
		if (result.ok) {
			const name = person ? staffDisplayName(person, locale) : ''
			toast.success(_(t`Time card added for ${name}.`))
			ctx.reload()
			ctx.close()
		}
	}

	return (
		<SheetForm
			title={_(t`Add a time card`)}
			description={_(
				t`For a shift that was never punched, or a punch that went missing. It is marked as added by a manager.`,
			)}
			onSubmit={(event) => void submit(event)}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						className={footerButton}
						disabled={save.pending}
						onClick={ctx.close}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="submit"
						className={footerButton}
						disabled={save.pending}
					>
						{save.pending ? (
							<Trans>Adding…</Trans>
						) : (
							<Trans>Add time card</Trans>
						)}
					</Button>
				</>
			}
		>
			{ctx.scopes.length > 1 ? (
				<SelectField
					label={<Trans>Workplace</Trans>}
					value={form.scopeId}
					onValueChange={(scopeId) => {
						setPerson(null)
						patch({ scopeId, staffId: '', positionId: '' })
					}}
					options={ctx.scopes.map((item) => ({
						value: item.id,
						label: item.name,
					}))}
					error={errors.scopeId}
				/>
			) : null}
			<PersonPicker
				client={staffClient}
				scopeId={form.scopeId}
				value={person}
				locale={locale}
				error={errors.staffId}
				onChange={(picked) => {
					setPerson(picked)
					patch({ staffId: picked.id, positionId: '' })
				}}
			/>
			<CardFields
				form={form}
				onChange={patch}
				errors={errors}
				timeZone={scope?.timeZone ?? 'UTC'}
				moneyVisible={ctx.can.money}
				positionOptions={positions.options}
			/>
			<ReasonField
				value={form.reason}
				onChange={(reason) => patch({ reason })}
				error={errors.reason}
				label={_(t`Why are you adding this?`)}
			/>
			{save.error ? <FieldError>{save.error}</FieldError> : null}
		</SheetForm>
	)
}
