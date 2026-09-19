'use client'

import { Trans } from '@lingui/macro'
import {
	formatTimezoneLabel,
	US_FOCUSED_IANA_TIMEZONES,
} from '@repo/common/iana-timezones'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@repo/ui/command'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { useMemo, useState } from 'react'

type TimezoneSelectFieldProps = {
	name: string
	defaultValue?: string
	label?: React.ReactNode
	required?: boolean
}

export function TimezoneSelectField({
	name,
	defaultValue = 'America/Chicago',
	label,
	required,
}: TimezoneSelectFieldProps) {
	const [open, setOpen] = useState(false)
	const [value, setValue] = useState(
		US_FOCUSED_IANA_TIMEZONES.includes(defaultValue)
			? defaultValue
			: 'America/Chicago',
	)

	const options = useMemo(
		() =>
			US_FOCUSED_IANA_TIMEZONES.map((zone) => ({
				value: zone,
				label: formatTimezoneLabel(zone),
			})),
		[],
	)

	const selectedLabel =
		options.find((option) => option.value === value)?.label ?? value

	return (
		<div className="space-y-1">
			<Label>
				{label ?? <Trans>Timezone</Trans>}
				{required ? <span className="text-destructive"> *</span> : null}
			</Label>
			<input type="hidden" name={name} value={value} required={required} />
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							type="button"
							variant="outline"
							role="combobox"
							aria-expanded={open}
							className="w-full justify-between font-normal"
						/>
					}
				>
					<span className="truncate">{selectedLabel}</span>
					<Icon name="chevron-down" className="size-4 shrink-0 opacity-50" />
				</PopoverTrigger>
				<PopoverContent className="w-[var(--anchor-width)] p-0" align="start">
					<Command>
						<CommandInput placeholder="Search timezones…" />
						<CommandList>
							<CommandEmpty>
								<Trans>No timezone found.</Trans>
							</CommandEmpty>
							<CommandGroup>
								{options.map((option) => (
									<CommandItem
										key={option.value}
										value={option.label}
										onSelect={() => {
											setValue(option.value)
											setOpen(false)
										}}
									>
										<Icon
											name="check"
											className={cn(
												'mr-2 size-4',
												value === option.value ? 'opacity-100' : 'opacity-0',
											)}
										/>
										{option.label}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	)
}
