import { type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Item, ItemGroup } from '@repo/ui/item'
import {
	type DraftRow,
	type ImportProblem,
	type ReviewedRow,
} from '#app/utils/staffing/staff-import.ts'

const PROBLEM_MESSAGES: Record<ImportProblem, MessageDescriptor> = {
	name_required: msg`Add a first name.`,
	last_name_required: msg`Add a last name.`,
	name_too_long: msg`Use 80 characters or fewer.`,
	bad_email: msg`That email does not look right.`,
	bad_phone: msg`Use the country code, like +14155550123.`,
	contact_required: msg`Add a phone number or an email.`,
	duplicate: msg`Same phone or email as an earlier row.`,
}

export function problemText(
	row: ReviewedRow,
	translate: (descriptor: MessageDescriptor) => string,
): string[] {
	return row.problems.map((problem) => translate(PROBLEM_MESSAGES[problem]))
}

type Editable = 'name' | 'contact'

/**
 * The review step of Bulk add and Import: one block per row with its fields
 * editable and its problems written out underneath. Nothing here is saved.
 */
export function ReviewRows({
	rows,
	editable,
	onChange,
	onRemove,
}: {
	rows: readonly ReviewedRow[]
	/** Which fields the manager may fix in place. */
	editable: readonly Editable[]
	onChange: (id: string, patch: Partial<Omit<DraftRow, 'id'>>) => void
	onRemove: (id: string) => void
}) {
	const { _ } = useLingui()
	const editName = editable.includes('name')
	const editContact = editable.includes('contact')
	return (
		<ItemGroup>
			{rows.map((row) => {
				const problems = problemText(row, _)
				const invalid = problems.length > 0
				const rowNumber = row.row
				const rowLabel = _(t`Row ${rowNumber}`)
				return (
					<Item key={row.id} variant="outline" render={<li />}>
						<div className="flex w-full flex-col gap-2">
							<div className="flex items-start gap-2">
								<span className="text-muted-foreground w-7 shrink-0 pt-3 text-xs tabular-nums md:pt-2">
									{row.row}
								</span>
								<div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
									<Input
										aria-label={`${rowLabel}: ${_(t`First name`)}`}
										aria-invalid={invalid ? true : undefined}
										aria-describedby={
											invalid ? `${row.id}-problems` : undefined
										}

										placeholder={_(t`First name`)}
										value={row.firstName}
										readOnly={!editName}
										onChange={(event) =>
											onChange(row.id, { firstName: event.target.value })
										}
									/>
									<Input
										aria-label={`${rowLabel}: ${_(t`Last name`)}`}
										aria-invalid={invalid ? true : undefined}
										aria-describedby={
											invalid ? `${row.id}-problems` : undefined
										}

										placeholder={_(t`Last name`)}
										value={row.lastName}
										readOnly={!editName}
										onChange={(event) =>
											onChange(row.id, { lastName: event.target.value })
										}
									/>
									<Input
										aria-label={`${rowLabel}: ${_(t`Phone`)}`}
										aria-invalid={invalid ? true : undefined}
										aria-describedby={
											invalid ? `${row.id}-problems` : undefined
										}

										dir="ltr"
										inputMode="tel"
										placeholder={_(t`Phone`)}
										value={row.phone}
										readOnly={!editContact}
										onChange={(event) =>
											onChange(row.id, { phone: event.target.value })
										}
									/>
									<Input
										aria-label={`${rowLabel}: ${_(t`Email`)}`}
										aria-invalid={invalid ? true : undefined}
										aria-describedby={
											invalid ? `${row.id}-problems` : undefined
										}

										dir="ltr"
										inputMode="email"
										placeholder={_(t`Email`)}
										value={row.email}
										readOnly={!editContact}
										onChange={(event) =>
											onChange(row.id, { email: event.target.value })
										}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-11 shrink-0 md:size-9"
									aria-label={_(t`Remove ${rowLabel}`)}
									onClick={() => onRemove(row.id)}
								>
									<Icon name="x" />
								</Button>
							</div>
							{invalid ? (
								<p
									id={`${row.id}-problems`}
									className="text-destructive ps-9 text-sm"
								>
									{problems.join(' ')}
								</p>
							) : null}
						</div>
					</Item>
				)
			})}
		</ItemGroup>
	)
}
