'use client'

import { Trans } from '@lingui/macro'
import { type SpecialHoursEntry } from '@repo/common/location-hours'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

type SpecialHoursEditorProps = {
	value: SpecialHoursEntry[]
	onChange: (next: SpecialHoursEntry[]) => void
}

export function SpecialHoursEditor({
	value,
	onChange,
}: SpecialHoursEditorProps) {
	return (
		<div className="flex flex-col gap-4">
			{value.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No special hours yet. Add holidays or one-off closures.</Trans>
				</p>
			) : null}
			{value.map((entry, index) => (
				<div
					key={`${entry.date}-${index}`}
					className="grid gap-3 rounded-lg border p-4 md:grid-cols-2"
				>
					<div className="space-y-1">
						<Label>
							<Trans>Date</Trans>
						</Label>
						<Input
							type="date"
							value={entry.date}
							onChange={(event) => {
								const next = [...value]
								next[index] = { ...entry, date: event.target.value }
								onChange(next)
							}}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>
							<Trans>Applies to</Trans>
						</Label>
						<div className="flex gap-4">
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={entry.calendars.includes('store')}
									onCheckedChange={(checked) => {
										const calendars = new Set(entry.calendars)
										if (checked) calendars.add('store')
										else calendars.delete('store')
										const next = [...value]
										next[index] = {
											...entry,
											calendars: [...calendars] as ('store' | 'online')[],
										}
										onChange(next)
									}}
								/>
								<Trans>Store</Trans>
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={entry.calendars.includes('online')}
									onCheckedChange={(checked) => {
										const calendars = new Set(entry.calendars)
										if (checked) calendars.add('online')
										else calendars.delete('online')
										const next = [...value]
										next[index] = {
											...entry,
											calendars: [...calendars] as ('store' | 'online')[],
										}
										onChange(next)
									}}
								/>
								<Trans>Online ordering</Trans>
							</label>
						</div>
					</div>
					<label className="flex items-center gap-2 text-sm md:col-span-2">
						<Checkbox
							checked={entry.closed === true}
							onCheckedChange={(checked) => {
								const next = [...value]
								next[index] = { ...entry, closed: checked === true }
								onChange(next)
							}}
						/>
						<Trans>Closed all day</Trans>
					</label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="w-fit md:col-span-2"
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>
						<Trans>Remove</Trans>
					</Button>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="w-fit"
				onClick={() =>
					onChange([
						...value,
						{
							date: new Date().toISOString().slice(0, 10),
							calendars: ['store', 'online'],
							closed: true,
							recurrence: 'none',
						},
					])
				}
			>
				<Trans>Add special hours</Trans>
			</Button>
		</div>
	)
}
