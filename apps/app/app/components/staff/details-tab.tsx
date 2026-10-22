import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Skeleton } from '@repo/ui/skeleton'
import { useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useSaveBar } from '#app/components/save-bar.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	defaultDialCode,
	normalizePhone,
} from '#app/utils/staffing/staff-format.ts'
import {
	staffPrivateSchema,
	staffResultSchema,
	type StaffDetail,
	type StaffMemberRow,
} from '#app/utils/staffing/staff-types.ts'
import {
	hasErrors,
	validatePerson,
	type PersonErrors,
} from '#app/utils/staffing/staff-validation.ts'
import { SelectField, TextField } from './controls.tsx'
import { RevealGate } from './reveal-gate.tsx'
import { useTeamContext } from './team-context.ts'

const blankToNull = (value: string) =>
	value.trim() === '' ? null : value.trim()

/**
 * Name, contact and employment basics, then the personal details. Saves only
 * what changed. The two forms are independent: saving the first reloads the
 * person, and the first form remounts on that (see the key) without touching
 * unsaved edits in the second.
 */
export function DetailsTab({
	detail,
	onChanged,
}: {
	detail: StaffDetail
	onChanged: () => void
}) {
	const { can } = useStaffClient('staff')
	const person = detail.staff
	return (
		<div className="flex flex-col gap-6">
			<PersonForm
				key={`${person.id}:${person.updatedAt ?? ''}`}
				detail={detail}
				onChanged={onChanged}
			/>
			{can(P.READ_STAFF_PRIVATE) ? (
				<RevealGate
					title={<Trans>Personal details</Trans>}
					description={
						<Trans>
							Date of birth, address and emergency contact. Each time you view
							these, it is recorded.
						</Trans>
					}
				>
					<PrivateDetails key={person.id} staffId={person.id} />
				</RevealGate>
			) : null}
		</div>
	)
}

function PersonForm({
	detail,
	onChanged,
}: {
	detail: StaffDetail
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const { client, can } = useStaffClient('staff')
	const { scopes, reloadRoster } = useTeamContext()
	const dialCode = defaultDialCode(scopes.map((scope) => scope.currency))
	const person = detail.staff
	const action = useStaffAction()
	const canWrite = can(P.UPDATE_STAFF)

	const initial = {
		firstName: person.firstName,
		lastName: person.lastName,
		email: person.email ?? '',
		phone: person.phone ?? '',
		employeeNumber: person.employeeNumber ?? '',
		hiredDate: person.hiredDate ?? '',
		workerType: person.workerType,
		status: person.status === 'invited' ? 'active' : person.status,
	}
	const [values, setValues] = useState(initial)
	const [errors, setErrors] = useState<PersonErrors>({})
	const set = <K extends keyof typeof initial>(
		key: K,
		value: (typeof initial)[K],
	) => setValues((current) => ({ ...current, [key]: value }))

	// What the last successful save sent. Until the reload remounts this form
	// with the new person, those values are saved even though `initial` is old.
	const [saved, setSaved] = useState<typeof initial | null>(null)
	const baseline = saved ?? initial
	const dirty = (Object.keys(initial) as Array<keyof typeof initial>).some(
		(key) => values[key] !== baseline[key],
	)
	const terminated = person.status === 'terminated'
	const formRef = useRef<HTMLFormElement>(null)

	useSaveBar({
		dirty: canWrite && dirty,
		saving: action.pending,
		onSave: () => formRef.current?.requestSubmit(),
		onDiscard: () => {
			setValues(baseline)
			setErrors({})
			action.reset()
		},
	})

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!dirty || action.pending) return
		const found = validatePerson(values, _, { dialCode })
		setErrors(found)
		if (hasErrors(found)) return

		const patch: Record<string, unknown> = {}
		const changed = (key: keyof typeof initial) => values[key] !== baseline[key]
		if (changed('firstName')) patch.firstName = values.firstName.trim()
		if (changed('lastName')) patch.lastName = values.lastName.trim()
		if (changed('email')) patch.email = blankToNull(values.email)
		if (changed('phone')) {
			patch.phone = values.phone.trim()
				? normalizePhone(values.phone, dialCode)
				: null
		}
		if (changed('employeeNumber')) {
			patch.employeeNumber = blankToNull(values.employeeNumber)
		}
		if (changed('hiredDate')) patch.hiredDate = blankToNull(values.hiredDate)
		if (changed('workerType')) patch.workerType = values.workerType
		if (changed('status') && !terminated) patch.status = values.status

		const result = await action.run(async () =>
			staffResultSchema.parse(
				await client.request(`/${person.id}`, { method: 'PATCH', json: patch }),
			),
		)
		if (result.ok) {
			setSaved(values)
			toast.success(_(t`Details saved.`))
			reloadRoster()
			onChanged()
		}
	}

	return (
		<form
			ref={formRef}
			onSubmit={(event) => void save(event)}
			noValidate
			aria-label={_(t`Details`)}
		>
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle>
						<Trans>Details</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>Name, contact and payroll information.</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							label={<Trans>First name</Trans>}
							value={values.firstName}
							onChange={(event) => set('firstName', event.target.value)}
							error={errors.firstName}
							disabled={!canWrite}
							required
						/>
						<TextField
							label={<Trans>Last name</Trans>}
							value={values.lastName}
							onChange={(event) => set('lastName', event.target.value)}
							error={errors.lastName}
							disabled={!canWrite}
							required
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							label={<Trans>Phone</Trans>}
							type="tel"
							inputMode="tel"
							dir="ltr"
							value={values.phone}
							onChange={(event) => set('phone', event.target.value)}
							error={errors.phone}
							disabled={!canWrite}
							optional
						/>
						<TextField
							label={<Trans>Email</Trans>}
							type="email"
							inputMode="email"
							dir="ltr"
							value={values.email}
							onChange={(event) => set('email', event.target.value)}
							error={errors.email}
							disabled={!canWrite}
							optional
						/>
						<TextField
							label={<Trans>Payroll ID</Trans>}
							value={values.employeeNumber}
							onChange={(event) => set('employeeNumber', event.target.value)}
							disabled={!canWrite}
							optional
						/>
						<TextField
							label={<Trans>Hire date</Trans>}
							type="date"
							dir="ltr"
							value={values.hiredDate}
							onChange={(event) => set('hiredDate', event.target.value)}
							disabled={!canWrite}
							optional
						/>
						<SelectField
							label={<Trans>Worker type</Trans>}
							value={values.workerType}
							onValueChange={(value) =>
								set('workerType', value as StaffMemberRow['workerType'])
							}
							options={[
								{ value: 'employee', label: _(t`Employee`) },
								{ value: 'contractor', label: _(t`Contractor`) },
							]}
							disabled={!canWrite}
						/>
						{!terminated ? (
							<SelectField
								label={<Trans>Status</Trans>}
								value={values.status}
								onValueChange={(value) =>
									set('status', value as 'active' | 'on_leave')
								}
								options={[
									{ value: 'active', label: _(t`Active`) },
									{ value: 'on_leave', label: _(t`On leave`) },
								]}
								disabled={!canWrite}
							/>
						) : null}
					</div>
					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
				</FramePanel>
			</Frame>
		</form>
	)
}

const privateResponse = z.object({ private: staffPrivateSchema.partial() })

const PRIVATE_FIELDS = [
	'dateOfBirth',
	'addressLine1',
	'addressLine2',
	'city',
	'region',
	'postalCode',
	'country',
	'emergencyContactName',
	'emergencyContactPhone',
	'emergencyContactRelation',
] as const
type PrivateField = (typeof PRIVATE_FIELDS)[number]

function PrivateDetails({ staffId }: { staffId: string }) {
	const { _ } = useLingui()
	const { client, can } = useStaffClient('staff')
	const query = useStaffQuery(client, `/${staffId}/private`, privateResponse)
	const canWrite = can(P.UPDATE_STAFF_PRIVATE)

	if (query.loading) {
		return (
			<div role="status" className="flex flex-col gap-3">
				<span className="sr-only">
					<Trans>Loading personal details</Trans>
				</span>
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
			</div>
		)
	}
	if (query.error || !query.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{describeStaffError(query.error, _)}
				</AlertDescription>
			</Alert>
		)
	}
	return (
		<PrivateForm
			staffId={staffId}
			initial={query.data.private}
			canWrite={canWrite}
		/>
	)
}

function PrivateForm({
	staffId,
	initial,
	canWrite,
}: {
	staffId: string
	initial: Partial<Record<PrivateField, string | null>>
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('staff')
	const action = useStaffAction()
	const start = Object.fromEntries(
		PRIVATE_FIELDS.map((field) => [field, initial[field] ?? '']),
	) as Record<PrivateField, string>
	const [saved, setSaved] = useState(start)
	const [values, setValues] = useState(start)
	const dirty = PRIVATE_FIELDS.some((field) => values[field] !== saved[field])
	const set = (field: PrivateField, value: string) =>
		setValues((current) => ({ ...current, [field]: value }))
	const formRef = useRef<HTMLFormElement>(null)

	useSaveBar({
		dirty: canWrite && dirty,
		saving: action.pending,
		onSave: () => formRef.current?.requestSubmit(),
		onDiscard: () => {
			setValues(saved)
			action.reset()
		},
	})

	const text = (field: PrivateField, label: string, extra = {}) => (
		<TextField
			label={label}
			value={values[field]}
			onChange={(event) => set(field, event.target.value)}
			disabled={!canWrite}
			error={action.issues[field] ? _(t`Check this field.`) : null}
			{...extra}
		/>
	)

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!dirty) return
		const patch: Record<string, string | null> = {}
		for (const field of PRIVATE_FIELDS) {
			if (values[field] !== saved[field])
				patch[field] = blankToNull(values[field])
		}
		const result = await action.run(() =>
			client.request(`/${staffId}/private`, { method: 'PUT', json: patch }),
		)
		if (result.ok) {
			setSaved(values)
			toast.success(_(t`Personal details saved.`))
		}
	}

	return (
		<form
			ref={formRef}
			onSubmit={(event) => void save(event)}
			noValidate
			className="flex flex-col gap-4"
			aria-label={_(t`Personal details`)}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				{text('dateOfBirth', _(t`Date of birth`), { type: 'date', dir: 'ltr' })}
				{text('country', _(t`Country code`), {
					placeholder: 'US',
					maxLength: 2,
					dir: 'ltr',
				})}
				{text('addressLine1', _(t`Address`))}
				{text('addressLine2', _(t`Address line 2`), { optional: true })}
				{text('city', _(t`City`))}
				{text('region', _(t`State or region`))}
				{text('postalCode', _(t`Postal code`), { dir: 'ltr' })}
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				{text('emergencyContactName', _(t`Emergency contact`))}
				{text('emergencyContactRelation', _(t`Relationship`))}
				{text('emergencyContactPhone', _(t`Emergency contact phone`), {
					type: 'tel',
					dir: 'ltr',
				})}
			</div>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
		</form>
	)
}
