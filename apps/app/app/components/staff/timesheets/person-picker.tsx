import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@repo/ui/command'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { useEffect, useId, useState } from 'react'
import { useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import {
	staffListSchema,
	type StaffListRow,
} from '#app/utils/staffing/staff-types.ts'

export type PickedPerson = Pick<
	StaffListRow,
	'id' | 'firstName' | 'lastName' | 'firstNameAr' | 'lastNameAr'
>

/**
 * Finds one person who works at a scope: a search box over the regional
 * roster (the server does the searching, so a big team stays fast). Only people
 * who can still be clocked in are listed: a person who has left is not.
 */
export function PersonPicker({
	client,
	scopeId,
	value,
	onChange,
	error,
	locale,
	disabled,
}: {
	client: StaffClient
	scopeId: string
	value: PickedPerson | null
	onChange: (person: PickedPerson) => void
	error?: string
	locale: string
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const id = useId()
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')
	const [debounced, setDebounced] = useState('')
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(search.trim()), 200)
		return () => clearTimeout(timer)
	}, [search])

	const params = new URLSearchParams()
	if (debounced) params.set('q', debounced)
	if (scopeId) params.set('scopeId', scopeId)
	params.set('limit', '20')
	const query = useStaffQuery(
		client,
		open ? `/?${params.toString()}` : null,
		staffListSchema,
	)
	const people = query.data?.staff ?? []

	return (
		<Field data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={id}>
				<Trans>Who worked</Trans>
			</FieldLabel>
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next)
					if (!next) setSearch('')
				}}
			>
				<PopoverTrigger
					render={
						<Button
							id={id}
							type="button"
							variant="outline"
							disabled={disabled}
							aria-invalid={error ? true : undefined}
							aria-label={`${_(t`Who worked`)}: ${value ? staffDisplayName(value, locale) : _(t`Search by name`)}`}
							className="h-11 w-full justify-between font-normal"
						>
							<span className={value ? '' : 'text-muted-foreground'}>
								{value ? staffDisplayName(value, locale) : _(t`Search by name`)}
							</span>
							<Icon name="chevron-down" />
						</Button>
					}
				/>
				<PopoverContent
					align="start"
					className="w-(--anchor-width) min-w-64 p-0"
				>
					<Command shouldFilter={false}>
						<CommandInput
							value={search}
							onValueChange={setSearch}
							placeholder={_(t`Search by name`)}
							aria-label={_(t`Search by name`)}
						/>
						<CommandList>
							{query.loading ? (
								<p role="status" className="text-muted-foreground p-3 text-sm">
									<Trans>Looking…</Trans>
								</p>
							) : query.error ? (
								<div className="p-3">
									<FieldError>
										<Trans>We could not load the team. Try again.</Trans>
									</FieldError>
								</div>
							) : (
								<>
									<CommandEmpty>
										<Trans>No one found at this workplace.</Trans>
									</CommandEmpty>
									<CommandGroup>
										{people.map((person) => (
											<CommandItem
												key={person.id}
												value={person.id}
												onSelect={() => {
													onChange(person)
													setOpen(false)
													setSearch('')
												}}
												className=""
											>
												<span className="truncate">
													{staffDisplayName(person, locale)}
												</span>
												{person.employeeNumber ? (
													<span className="text-muted-foreground ms-auto text-xs tabular-nums">
														{person.employeeNumber}
													</span>
												) : null}
											</CommandItem>
										))}
									</CommandGroup>
								</>
							)}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{error ? <FieldError>{error}</FieldError> : null}
		</Field>
	)
}
