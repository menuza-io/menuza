import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { useEffect, useMemo, useState } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { getTimezoneOptions } from '#app/components/staff/timezone-options.ts'

/**
 * The one time zone every shift, time card and labor day is computed in.
 * Saved on the organization (control plane), not in the staff data: the
 * regional time clock reads it back as the scope's time zone.
 */
export function TimeZoneCard({
	orgSlug,
	timeZone,
	canEdit,
}: {
	orgSlug: string
	timeZone: string
	canEdit: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok?: true; error?: string }>()
	const [value, setValue] = useState(timeZone)
	const options = useMemo(() => getTimezoneOptions(timeZone), [timeZone])
	const pending = fetcher.state !== 'idle'

	useEffect(() => {
		if (fetcher.data?.ok) toast.success(_(t`Time zone saved.`))
	}, [fetcher.data, _])

	return (
		<Frame className="w-full" aria-labelledby="time-zone-heading">
			<FrameHeader>
				<FrameTitle id="time-zone-heading">
					<Trans>Time zone</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Shifts, time cards and each labor day follow this time zone.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<form
					className="flex max-w-md flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault()
						void fetcher.submit(
							{ timeZone: value },
							{ method: 'post', action: `/${orgSlug}/staff/timeclock/rules` },
						)
					}}
				>
					<SelectField
						label={<Trans>Time zone</Trans>}
						value={value}
						onValueChange={setValue}
						options={options}
						disabled={!canEdit || pending}
						error={
							fetcher.data?.error
								? _(t`We could not save the time zone. Try again.`)
								: undefined
						}
					/>
					{canEdit ? (
						<div>
							<Button type="submit" disabled={pending || value === timeZone}>
								{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
							</Button>
						</div>
					) : null}
				</form>
			</FramePanel>
		</Frame>
	)
}
