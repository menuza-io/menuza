import { Trans, plural, t } from '@lingui/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldTitle,
} from '@repo/ui/field'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'

export type MemberLocationOption = { id: string; name: string }

export type MemberLocationTagOption = {
	id: string
	name: string
	locationCount: number
}

export type MemberLocationAccess = {
	scope: 'all' | 'selected'
	locationIds: string[]
	/** Tags granted as a group; their locations are read when the person is used. */
	tagIds: string[]
}

/**
 * The "Locations" control on a member row: which locations this person's
 * access covers, chosen one by one or by tag (a tag includes the locations
 * added to it later). Only admins see it. It limits location data (staff,
 * reservations, loyalty, discounts, orders and reports); every other
 * permission stays organization-wide.
 */
export function MemberLocationScopeEditor({
	userId,
	memberName,
	access,
	locations,
	tags = [],
}: {
	userId: string
	memberName: string
	access: MemberLocationAccess
	locations: MemberLocationOption[]
	tags?: MemberLocationTagOption[]
}) {
	const fetcher = useFetcher<{ success?: boolean; error?: string }>()
	const idPrefix = useId()
	const [open, setOpen] = useState(false)
	const [scope, setScope] = useState(access.scope)
	const [selected, setSelected] = useState(() => new Set(access.locationIds))
	const [selectedTags, setSelectedTags] = useState(() => new Set(access.tagIds))
	const saving = fetcher.state !== 'idle'

	// Start from what is stored each time the dialog opens, so an abandoned edit
	// never leaks into the next one.
	useEffect(() => {
		if (!open) return
		setScope(access.scope)
		setSelected(new Set(access.locationIds))
		setSelectedTags(new Set(access.tagIds))
	}, [open, access.scope, access.locationIds, access.tagIds])

	// Close once the save lands.
	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.success) setOpen(false)
	}, [fetcher.state, fetcher.data])

	function toggle(locationId: string, checked: boolean) {
		setSelected((current) => {
			const next = new Set(current)
			if (checked) next.add(locationId)
			else next.delete(locationId)
			return next
		})
	}

	function toggleTag(tagId: string, checked: boolean) {
		setSelectedTags((current) => {
			const next = new Set(current)
			if (checked) next.add(tagId)
			else next.delete(tagId)
			return next
		})
	}

	const known = new Set(locations.map((location) => location.id))
	const knownTags = new Set(tags.map((tag) => tag.id))
	const count = access.locationIds.filter((id) => known.has(id)).length
	const tagCount = access.tagIds.filter((id) => knownTags.has(id)).length
	const summary =
		access.scope === 'all'
			? t`All locations`
			: count === 0 && tagCount === 0
				? t`No locations`
				: tagCount > 0 && count === 0
					? plural(tagCount, { one: '# tag', other: '# tags' })
					: plural(count + tagCount, {
							one: '# location or tag',
							other: '# locations or tags',
						})

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-label={t`Locations for ${memberName}: ${summary}`}
					/>
				}
			>
				{summary}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Locations</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose which locations {memberName} can see and manage: staff,
							reservations, loyalty, discounts, orders and reports. Their other
							permissions do not change.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<fetcher.Form method="POST" className="grid gap-4">
					<input type="hidden" name="intent" value="update-member-locations" />
					<input type="hidden" name="userId" value={userId} />
					<input type="hidden" name="scope" value={scope} />

					<RadioGroup
						value={scope}
						onValueChange={(value) => setScope(value as 'all' | 'selected')}
						aria-label={t`Location access`}
					>
						<FieldLabel htmlFor={`${idPrefix}-all`}>
							<Field orientation="horizontal">
								<FieldContent>
									<FieldTitle>
										<Trans>All locations</Trans>
									</FieldTitle>
									<FieldDescription>
										<Trans>Including locations you add later.</Trans>
									</FieldDescription>
								</FieldContent>
								<RadioGroupItem value="all" id={`${idPrefix}-all`} />
							</Field>
						</FieldLabel>
						<FieldLabel htmlFor={`${idPrefix}-selected`}>
							<Field orientation="horizontal">
								<FieldContent>
									<FieldTitle>
										<Trans>Selected locations</Trans>
									</FieldTitle>
									<FieldDescription>
										<Trans>Choosing none gives no access to locations.</Trans>
									</FieldDescription>
								</FieldContent>
								<RadioGroupItem value="selected" id={`${idPrefix}-selected`} />
							</Field>
						</FieldLabel>
					</RadioGroup>

					{scope === 'selected' && tags.length > 0 ? (
						<FieldSet>
							<FieldLegend variant="label">
								<Trans>Tags</Trans>
							</FieldLegend>
							<FieldDescription>
								<Trans>
									A tag gives access to every location that has it, including
									locations added to it later.
								</Trans>
							</FieldDescription>
							<FieldGroup>
								{tags.map((tag) => {
									const checked = selectedTags.has(tag.id)
									const id = `${idPrefix}-tag-${tag.id}`
									return (
										<Field key={tag.id} orientation="horizontal">
											<Checkbox
												id={id}
												checked={checked}
												onCheckedChange={(value) =>
													toggleTag(tag.id, value === true)
												}
											/>
											<FieldLabel htmlFor={id}>
												{tag.name} (
												{plural(tag.locationCount, {
													one: '# location',
													other: '# locations',
												})}
												)
											</FieldLabel>
											{checked ? (
												<input type="hidden" name="tagIds" value={tag.id} />
											) : null}
										</Field>
									)
								})}
							</FieldGroup>
						</FieldSet>
					) : null}

					{scope === 'selected' ? (
						<FieldSet>
							<FieldLegend variant="label" className="sr-only">
								<Trans>Locations</Trans>
							</FieldLegend>
							{locations.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>This restaurant has no active locations yet.</Trans>
								</p>
							) : (
								<FieldGroup>
									{locations.map((location) => {
										const checked = selected.has(location.id)
										const id = `${idPrefix}-${location.id}`
										return (
											<Field key={location.id} orientation="horizontal">
												<Checkbox
													id={id}
													checked={checked}
													onCheckedChange={(value) =>
														toggle(location.id, value === true)
													}
												/>
												<FieldLabel htmlFor={id}>{location.name}</FieldLabel>
												{checked ? (
													<input
														type="hidden"
														name="locationIds"
														value={location.id}
													/>
												) : null}
											</Field>
										)
									})}
								</FieldGroup>
							)}
						</FieldSet>
					) : null}

					<p className="text-muted-foreground text-xs">
						<Trans>
							A change applies the next time their session refreshes, within 15
							minutes.
						</Trans>
					</p>

					{fetcher.data?.error ? (
						<Alert variant="destructive">
							<AlertDescription>{fetcher.data.error}</AlertDescription>
						</Alert>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={saving}>
							{saving ? <Spinner /> : null}
							<Trans>Save</Trans>
						</Button>
					</DialogFooter>
				</fetcher.Form>
			</DialogContent>
		</Dialog>
	)
}
