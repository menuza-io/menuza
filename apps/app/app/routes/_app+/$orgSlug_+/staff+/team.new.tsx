import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { useTeamContext } from '#app/components/staff/team-context.ts'
import { useStaffClient } from '#app/hooks/use-staff-client.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import {
	describeStaffError,
	fieldIssues,
} from '#app/utils/staffing/staff-errors.ts'
import {
	defaultDialCode,
	normalizePhone,
	todayLocalDate,
} from '#app/utils/staffing/staff-format.ts'
import {
	createResultSchema,
	type StaffPositionRow,
} from '#app/utils/staffing/staff-types.ts'
import {
	hasErrors,
	validatePerson,
	type PersonErrors,
} from '#app/utils/staffing/staff-validation.ts'
import { type Route } from './+types/team.new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, STAFF_WRITE_REQUIREMENT)
	return null
}

const NO_POSITION = 'none'

export default function AddStaffRoute() {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const { client } = useStaffClient('staff')
	const { scopes, positions, basePath, reloadRoster } = useTeamContext()
	const dialCode = defaultDialCode(scopes.map((scope) => scope.currency))

	const [firstName, setFirstName] = useState('')
	const [lastName, setLastName] = useState('')
	const [phone, setPhone] = useState('')
	const [email, setEmail] = useState('')
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	const [positionId, setPositionId] = useState(NO_POSITION)
	const [errors, setErrors] = useState<PersonErrors & { form?: string }>({})
	const [pending, setPending] = useState(false)

	const activePositions = positions.filter((position) => !position.archivedAt)
	const scope = scopes.find((item) => item.id === scopeId)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending) return
		const found = validatePerson({ firstName, lastName, email, phone }, _, {
			dialCode,
			requireContact: true,
		})
		setErrors(found)
		if (hasErrors(found)) return

		setPending(true)
		try {
			const created = createResultSchema.parse(
				await client.request('/', {
					method: 'POST',
					json: {
						firstName: firstName.trim(),
						lastName: lastName.trim(),
						...(email.trim() ? { email: email.trim() } : {}),
						...(phone.trim()
							? { phone: normalizePhone(phone, dialCode)! }
							: {}),
						assignments: scopeId ? [{ scopeId, isPrimary: true }] : [],
					},
				}),
			)
			let positionFailed = false
			if (positionId !== NO_POSITION && scope) {
				try {
					await client.request(`/${created.staff.id}/jobs`, {
						method: 'POST',
						json: {
							scopeId: scope.id,
							positionId,
							currency: scope.currency,
							isPrimary: true,
							effectiveFrom: todayLocalDate(),
						},
					})
				} catch {
					positionFailed = true
				}
			}
			reloadRoster()
			const name = `${firstName.trim()} ${lastName.trim()}`
			if (positionFailed) {
				toast.warning(
					_(
						t`${name} was added, but the position was not saved. Add it from their profile.`,
					),
				)
			} else {
				toast.success(_(t`${name} was added.`))
			}
			void navigate(`${basePath}/${created.staff.id}`)
		} catch (error) {
			const issues = fieldIssues(error)
			setErrors({
				...(issues.phone
					? { phone: _(t`That phone number is not valid.`) }
					: {}),
				...(issues.email ? { email: _(t`That email is not valid.`) } : {}),
				form: describeStaffError(error, _),
			})
		} finally {
			setPending(false)
		}
	}

	return (
		<SheetForm
			title={_(t`Add staff`)}
			description={_(
				t`Name, plus a phone number or an email. They do not need a login.`,
			)}
			onSubmit={(event) => void submit(event)}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => void navigate(basePath)}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={pending}>
						{pending ? <Trans>Adding…</Trans> : <Trans>Add staff</Trans>}
					</Button>
				</>
			}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>First name</Trans>}
					value={firstName}
					onChange={(event) => setFirstName(event.target.value)}
					error={errors.firstName}
					autoComplete="off"
					autoFocus
					required
				/>
				<TextField
					label={<Trans>Last name</Trans>}
					value={lastName}
					onChange={(event) => setLastName(event.target.value)}
					error={errors.lastName}
					autoComplete="off"
					required
				/>
			</div>
			<div className="flex flex-col gap-4">
				<TextField
					label={<Trans>Phone</Trans>}
					type="tel"
					inputMode="tel"
					dir="ltr"
					value={phone}
					onChange={(event) => setPhone(event.target.value)}
					error={errors.phone ?? errors.contact}
					hint={
						dialCode
							? undefined
							: _(t`Include the country code, like +14155550123.`)
					}
					autoComplete="off"
				/>
				<TextField
					label={<Trans>Email</Trans>}
					type="email"
					inputMode="email"
					dir="ltr"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					error={errors.email}
					hint={_(t`Add at least one: a phone number, an email, or both.`)}
					autoComplete="off"
				/>
			</div>
			{scopes.length > 1 ? (
				<SelectField
					label={<Trans>Workplace</Trans>}
					value={scopeId}
					onValueChange={setScopeId}
					options={scopes.map((item) => ({
						value: item.id,
						label: item.name,
					}))}
				/>
			) : null}
			{scopes.length > 0 && activePositions.length > 0 ? (
				<SelectField
					label={<Trans>Position</Trans>}
					optional
					value={positionId}
					onValueChange={setPositionId}
					options={[
						{ value: NO_POSITION, label: _(t`No position yet`) },
						...activePositions.map((position: StaffPositionRow) => ({
							value: position.id,
							label: position.name,
						})),
					]}
					hint={_(t`Pay is set from their profile.`)}
				/>
			) : null}
			{errors.form ? (
				<Alert variant="destructive">
					<AlertDescription>{errors.form}</AlertDescription>
				</Alert>
			) : null}
		</SheetForm>
	)
}
