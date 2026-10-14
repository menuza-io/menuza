import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Spinner } from '@repo/ui/spinner'
import {
	useEffect,
	useId,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
	type RefObject,
} from 'react'
import { useFetcher } from 'react-router'
import {
	type DashboardActionErrorCode,
	type DashboardActionResult,
} from '#app/utils/dashboards/actions.server.ts'
import {
	DASHBOARD_NAME_MAX_LENGTH,
	MAX_CUSTOM_DASHBOARDS,
	validateDashboardName,
} from '#app/utils/dashboards/config.ts'

const NAME_ERROR_CODES: readonly DashboardActionErrorCode[] = [
	'name-required',
	'name-too-long',
]

function errorMessage(code: DashboardActionErrorCode): MessageDescriptor {
	switch (code) {
		case 'name-required':
			return msg`Enter a dashboard name.`
		case 'name-too-long':
			return msg`Use ${DASHBOARD_NAME_MAX_LENGTH} characters or fewer.`
		case 'limit-reached':
			return msg`You already have ${MAX_CUSTOM_DASHBOARDS} dashboards in this organization, the most you can have. Delete one to create another.`
		case 'forbidden':
			return msg`Only the owner can rename this dashboard.`
		default:
			return msg`The dashboard could not be saved. Please try again.`
	}
}

type DashboardNameFormProps = {
	/** Where the name is posted to, with `intent`. */
	action: string
	intent: 'create' | 'rename'
	defaultName?: string
	title: ReactNode
	description: ReactNode
	submitLabel: ReactNode
}

/**
 * Lives inside the dialog, so it starts over, with its own fetcher, each time
 * the dialog opens.
 */
function DashboardNameForm({
	action,
	intent,
	defaultName = '',
	title,
	description,
	submitLabel,
	onSaved,
}: DashboardNameFormProps & { onSaved: () => void }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<DashboardActionResult>()
	const inputId = useId()
	const errorId = useId()
	const [name, setName] = useState(defaultName)
	const [error, setError] = useState<DashboardActionErrorCode | null>(null)
	const handledRef = useRef(fetcher.data)
	const busy = fetcher.state !== 'idle'

	useEffect(() => {
		const result = fetcher.data
		if (fetcher.state !== 'idle' || !result || result === handledRef.current) {
			return
		}
		handledRef.current = result
		if (result.ok) onSaved()
		else setError(result.error.code)
	}, [fetcher.data, fetcher.state, onSaved])

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const validated = validateDashboardName(name)
		if (!validated.success) {
			setError(validated.code)
			return
		}
		setError(null)
		void fetcher.submit(
			{ intent, name: validated.name },
			{ method: 'POST', action },
		)
	}

	const nameError = error && NAME_ERROR_CODES.includes(error) ? error : null
	const formError = error && !nameError ? error : null

	return (
		<form noValidate onSubmit={submit} className="grid gap-4">
			<DialogHeader>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
			</DialogHeader>
			<Field data-invalid={nameError ? true : undefined}>
				<FieldLabel htmlFor={inputId}>
					<Trans>Name</Trans>
				</FieldLabel>
				<Input
					id={inputId}
					name="name"
					value={name}
					autoComplete="off"
					onChange={(event) => {
						setName(event.target.value)
						setError(null)
					}}
					aria-invalid={nameError ? true : undefined}
					aria-describedby={nameError ? errorId : undefined}
				/>
				<FieldError id={errorId}>
					{nameError ? _(errorMessage(nameError)) : null}
				</FieldError>
			</Field>
			{formError ? (
				<p role="alert" className="text-destructive text-sm">
					{_(errorMessage(formError))}
				</p>
			) : null}
			<DialogFooter>
				<DialogClose render={<Button type="button" variant="outline" />}>
					<Trans>Cancel</Trans>
				</DialogClose>
				<Button type="submit" disabled={busy}>
					{busy ? <Spinner /> : null}
					{submitLabel}
				</Button>
			</DialogFooter>
		</form>
	)
}

/** Asks for a dashboard name, to create a dashboard or rename one. */
export function DashboardNameDialog({
	open,
	onOpenChange,
	finalFocus,
	...form
}: DashboardNameFormProps & {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Gets focus once the dialog closes, such as the control that opened it. */
	finalFocus?: RefObject<HTMLElement | null>
}) {
	const close = () => onOpenChange(false)
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" finalFocus={finalFocus}>
				<DashboardNameForm {...form} onSaved={close} />
			</DialogContent>
		</Dialog>
	)
}
