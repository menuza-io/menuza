import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type PosServer,
	type PosServersResponse,
} from '@repo/common/pos-orders'
import { useEffect, useId, useState } from 'react'
import { type SectionAssignmentInput } from './api.ts'
import { OfflineNote } from './OfflineStrip.tsx'
import { type FloorSection } from './sections.ts'
import { SectionDot } from './SectionStrip.tsx'
import { Button, Chip, cn, Input, Modal } from '~/ui/primitives.tsx'

/** A person's name as the floor shows it: "Maya S.". */
export const serverName = (
	person: Pick<PosServer, 'firstName' | 'lastInitial'>,
) =>
	person.lastInitial
		? `${person.firstName} ${person.lastInitial}.`
		: person.firstName

type Choice = { staffId: string | null; label: string }

/**
 * Who works which section this service, set by the host at the start of a
 * shift. Each section offers the people clocked in or scheduled (from the
 * staff module), or a typed name, or nobody. Saving replaces the service's
 * assignments as a whole.
 */
export function SectionsSheet({
	open,
	serviceName,
	sections,
	tableLabel,
	loadServers,
	busy,
	formatTime,
	onSave,
	onClose,
	offlineReason = null,
}: {
	open: boolean
	serviceName: string
	sections: FloorSection[]
	tableLabel: (id: string) => string
	/** Who is working: asked each time the sheet opens. */
	loadServers: () => Promise<PosServersResponse>
	busy: boolean
	formatTime: (epochMs: number) => string
	onSave: (assignments: SectionAssignmentInput[]) => void
	onClose: () => void
	offlineReason?: string | null
}) {
	const { _ } = useLingui()
	const [choices, setChoices] = useState<Record<string, Choice>>({})
	const [typing, setTyping] = useState<Record<string, boolean>>({})
	// Each section's name field, to type into as soon as it opens.
	const fieldId = useId()
	const nameField = (sectionId: string) =>
		`${fieldId}-${sections.findIndex((section) => section.id === sectionId)}`
	const [staff, setStaff] = useState<
		| { status: 'loading' }
		| { status: 'ready'; data: PosServersResponse }
		| { status: 'failed' }
	>({ status: 'loading' })

	// Each opening starts from what is saved, and asks again who is working.
	const [wasOpen, setWasOpen] = useState(false)
	if (open !== wasOpen) {
		setWasOpen(open)
		if (open) {
			setTyping({})
			setChoices(
				Object.fromEntries(
					sections.map((section) => [
						section.id,
						{
							staffId: section.server?.staffId ?? null,
							label: section.server?.name ?? '',
						},
					]),
				),
			)
			setStaff({ status: 'loading' })
		}
	}
	useEffect(() => {
		if (!open) return
		let live = true
		loadServers().then(
			(data) => live && setStaff({ status: 'ready', data }),
			() => live && setStaff({ status: 'failed' }),
		)
		return () => {
			live = false
		}
		// Asked once per opening; the list does not change while the sheet is up.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open])

	const people = staff.status === 'ready' ? staff.data.servers : []
	const choose = (sectionId: string, choice: Choice) =>
		setChoices((previous) => ({ ...previous, [sectionId]: choice }))
	const save = () =>
		onSave(
			sections.flatMap((section) => {
				const choice = choices[section.id]
				const label = choice?.label.trim() ?? ''
				return choice && (choice.staffId || label)
					? [
							{
								sectionId: section.id,
								staffId: choice.staffId,
								serverLabel: label,
							},
						]
					: []
			}),
		)

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(msg`Servers · ${serviceName}`)}
			size="lg"
			footer={
				<div className="grid gap-3 sm:grid-cols-2">
					<Button variant="outline" size="lg" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						variant="primary"
						size="lg"
						disabled={busy || offlineReason !== null}
						title={offlineReason ?? undefined}
						onClick={save}
					>
						<Trans>Save servers</Trans>
					</Button>
				</div>
			}
		>
			<div className="space-y-5 p-4 sm:p-5">
				<p className="text-muted-foreground text-sm" role="status">
					{staff.status === 'loading' ? (
						<Trans>Checking who is working…</Trans>
					) : staff.status === 'failed' ? (
						<Trans>
							Could not load who is working. Type each server’s name.
						</Trans>
					) : !staff.data.available ? (
						<Trans>
							Type each server’s name. With the time clock or schedules on in
							Staff, the people working show here to pick from.
						</Trans>
					) : people.length === 0 ? (
						<Trans>
							Nobody is clocked in or scheduled now. Type each server’s name.
						</Trans>
					) : (
						<Trans>
							Pick who works each section. A dot marks people on the clock.
						</Trans>
					)}
				</p>
				<ul className="divide-border divide-y">
					{sections.map((section) => {
						const choice = choices[section.id] ?? { staffId: null, label: '' }
						const tables = section.tableIds.map(tableLabel).join(', ')
						// A typed name (someone not on the list), or the field opened for one.
						const typed =
							!choice.staffId &&
							(Boolean(choice.label.trim()) || typing[section.id] === true)
						return (
							<li key={section.id} className="space-y-3 py-4 first:pt-0">
								<div className="flex items-baseline gap-2">
									<SectionDot color={section.color} />
									<h3 className="text-base font-semibold">{section.name}</h3>
									<p className="text-muted-foreground min-w-0 truncate text-sm">
										{tables ? (
											<Trans>Tables {tables}</Trans>
										) : (
											<Trans>No tables</Trans>
										)}
									</p>
								</div>
								<div
									role="group"
									aria-label={_(msg`Server for ${section.name}`)}
									className="flex flex-wrap gap-2"
								>
									{people.map((person) => {
										const name = serverName(person)
										const shift = person.shift
											? _(
													msg`${formatTime(person.shift.startAt)} to ${formatTime(person.shift.endAt)}`,
												)
											: null
										return (
											<Chip
												key={person.staffId}
												look="outlined"
												selected={choice.staffId === person.staffId}
												aria-pressed={choice.staffId === person.staffId}
												title={
													person.onClock
														? _(msg`${name}, on the clock`)
														: shift
															? _(msg`${name}, scheduled ${shift}`)
															: name
												}
												onClick={() =>
													choose(section.id, {
														staffId: person.staffId,
														label: name,
													})
												}
											>
												{person.onClock ? (
													<span
														aria-hidden
														className="bg-success size-2 shrink-0 rounded-full"
													/>
												) : null}
												{name}
												{!person.onClock && person.shift ? (
													<span className="text-muted-foreground text-xs">
														{formatTime(person.shift.startAt)}
													</span>
												) : null}
											</Chip>
										)
									})}
									{people.length > 0 ? (
										<Chip
											look="outlined"
											selected={typed}
											aria-pressed={typed}
											onClick={() => {
												setTyping((previous) => ({
													...previous,
													[section.id]: true,
												}))
												if (choice.staffId)
													choose(section.id, { staffId: null, label: '' })
												requestAnimationFrame(() =>
													document
														.getElementById(nameField(section.id))
														?.focus(),
												)
											}}
										>
											<Trans>Someone else</Trans>
										</Chip>
									) : null}
									<Chip
										look="outlined"
										selected={!choice.staffId && !typed}
										aria-pressed={!choice.staffId && !typed}
										onClick={() => {
											setTyping((previous) => ({
												...previous,
												[section.id]: false,
											}))
											choose(section.id, { staffId: null, label: '' })
										}}
									>
										<Trans>Nobody</Trans>
									</Chip>
								</div>
								<label
									className={cn(
										'block',
										!typed && people.length > 0 && 'hidden',
									)}
								>
									<span className="sr-only">
										<Trans>Or type a name for {section.name}</Trans>
									</span>
									<Input
										id={nameField(section.id)}
										value={choice.staffId ? '' : choice.label}
										placeholder={
											people.length > 0
												? _(msg`Their name`)
												: _(msg`Server’s name`)
										}
										maxLength={60}
										autoComplete="off"
										onChange={(event) =>
											choose(section.id, {
												staffId: null,
												label: event.target.value,
											})
										}
									/>
								</label>
							</li>
						)
					})}
				</ul>
				<OfflineNote reason={offlineReason} />
			</div>
		</Modal>
	)
}
