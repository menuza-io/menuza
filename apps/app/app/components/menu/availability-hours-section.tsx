import { Trans } from '@lingui/macro'
import {
	DEFAULT_WEEKLY_SCHEDULE,
	type WeeklySchedule,
	WeeklyScheduleSchema,
} from '@repo/common/location-types'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { AvailabilityScheduleEditor } from '#app/components/locations/availability-picker.tsx'

interface AvailabilityHoursSectionProps {
	value?: string | null
	onChange: (value: string) => void
}

function getSchedule(value?: string | null): WeeklySchedule {
	if (value) {
		try {
			const parsed = WeeklyScheduleSchema.safeParse(JSON.parse(value))
			if (parsed.success) return parsed.data
		} catch {}
	}

	return structuredClone(DEFAULT_WEEKLY_SCHEDULE)
}

export function AvailabilityHoursSection({
	value,
	onChange,
}: AvailabilityHoursSectionProps) {
	const [hasCustomHours, setHasCustomHours] = useState(Boolean(value))
	const [schedule, setSchedule] = useState(() => getSchedule(value))

	const handleScheduleChange = (nextSchedule: WeeklySchedule) => {
		setSchedule(nextSchedule)
		onChange(JSON.stringify(nextSchedule))
	}

	const handleCustomHoursChange = (enabled: boolean) => {
		setHasCustomHours(enabled)
		onChange(enabled ? JSON.stringify(schedule) : '')
	}

	return (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Custom Availability Hours</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Restrict when this is available to guests, such as lunch from 11:00
						AM to 3:00 PM.
					</Trans>
				</FrameDescription>
				<FrameAction>
					<Switch
						checked={hasCustomHours}
						onCheckedChange={handleCustomHoursChange}
						aria-label="Enable custom availability hours"
					/>
				</FrameAction>
			</FrameHeader>
			{hasCustomHours && (
				<FramePanel className="space-y-3">
					<p className="text-muted-foreground text-xs">
						<Trans>
							These hours override the location's normal online ordering hours.
						</Trans>
					</p>
					<AvailabilityScheduleEditor
						schedule={schedule}
						onChange={handleScheduleChange}
					/>
				</FramePanel>
			)}
		</Frame>
	)
}
