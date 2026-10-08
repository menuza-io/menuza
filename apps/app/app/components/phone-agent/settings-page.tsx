import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PhoneAgentSettings } from '@repo/phone-agent'
import { Button } from '@repo/ui/button'
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { type BlockerFunction, useFetcher, useRevalidator } from 'react-router'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'
import {
	parseSettingsError,
	type SettingsVersions,
} from '#app/utils/phone-agent/settings-errors.ts'

export type SettingsSaveResult =
	| { ok: true }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

export function FieldErrorText({ id, error }: { id?: string; error?: string }) {
	if (!error) return null
	return (
		<p id={id} role="alert" className="text-destructive text-xs">
			{error}
		</p>
	)
}

/**
 * Turns an error code from a settings action (see settings-errors.ts) into
 * text in the operator's language. Text without a known code is returned
 * unchanged.
 */
export function useSettingsErrorText() {
	const { _ } = useLingui()
	return useCallback(
		(error: string | undefined): string | undefined => {
			if (!error) return undefined
			const parsed = parseSettingsError(error)
			if (!parsed) return error
			const count = parsed.value ?? 0
			switch (parsed.code) {
				case 'conflict':
					return _(
						msg`These settings changed in another tab or by someone else. Reload to see the latest, then save again.`,
					)
				case 'invalid_fields':
					return _(msg`Check the highlighted fields.`)
				case 'invalid_request':
					return _(msg`Something went wrong. Reload the page and try again.`)
				case 'escalation_phone_required':
					return _(
						msg`Add a staff phone number to turn on automatic transfers.`,
					)
				case 'staff_phone_loop':
					return _(
						msg`A staff or transfer number reaches the AI agent, so transfers would loop back to it. Change it to a number staff answer directly.`,
					)
				case 'rate_limited_send':
					return _(
						plural(count, {
							one: "You've sent several codes recently. Try again in # minute.",
							other:
								"You've sent several codes recently. Try again in # minutes.",
						}),
					)
				case 'rate_limited_check':
					return _(
						plural(count, {
							one: 'Too many tries. Try again in # minute.',
							other: 'Too many tries. Try again in # minutes.',
						}),
					)
				case 'faq_rate_limited':
					return _(
						msg`You've drafted answers many times this hour. Try again later.`,
					)
				case 'faq_unavailable':
					return _(
						msg`Drafting answers is unavailable right now. Try again later.`,
					)
				case 'choose_scope':
					return _(msg`Choose one of the listed options.`)
				case 'alerts_forbidden':
					return _(
						msg`Only people who can view calls can change staff alerts, because alerts include callers' numbers and call summaries.`,
					)
				case 'required':
					return _(msg`Required.`)
				case 'too_short':
					return _(
						plural(count, {
							one: 'Use at least # character.',
							other: 'Use at least # characters.',
						}),
					)
				case 'too_long':
					return _(
						plural(count, {
							one: 'Use at most # character.',
							other: 'Use at most # characters.',
						}),
					)
				case 'too_few':
					return _(
						plural(count, {
							one: 'Add at least # item.',
							other: 'Add at least # items.',
						}),
					)
				case 'too_many':
					return _(
						plural(count, {
							one: 'Use at most # item.',
							other: 'Use at most # items.',
						}),
					)
				case 'too_small':
					return _(msg`Use ${count} or more.`)
				case 'too_big':
					return _(msg`Use ${count} or less.`)
				case 'email':
					return _(msg`Enter a valid email address.`)
				case 'phone':
					return _(msg`Use international format, for example +15551234567.`)
				case 'phone_region':
					return _(msg`Use a US or Canada phone number.`)
				case 'format':
					return _(msg`Check the format of this value.`)
				case 'invalid':
					return _(msg`Choose a valid value.`)
				case 'duplicate_id':
					return _(
						msg`This item duplicates another one. Remove it and add it again.`,
					)
				case 'transfer_loop':
					return _(
						msg`This number reaches the AI agent, so transfers would loop back to it. Use a number staff answer directly.`,
					)
				case 'contact_required':
					return _(msg`Choose a contact.`)
				case 'code_format':
					return _(msg`Enter the 6-digit code.`)
			}
		},
		[_],
	)
}

/** Field errors keyed by path, with each code turned into text. */
export function useSettingsFieldErrors(
	fieldErrors: Record<string, string> | undefined,
) {
	const describe = useSettingsErrorText()
	return useMemo(() => {
		const translated: Record<string, string> = {}
		for (const [key, error] of Object.entries(fieldErrors ?? {})) {
			translated[key] = describe(error) ?? error
		}
		return translated
	}, [describe, fieldErrors])
}

/**
 * Asks before leaving a page with unsaved edits, both for links inside the
 * app and for closing or reloading the tab.
 */
export function useUnsavedChangesWarning(dirty: boolean) {
	const { _ } = useLingui()
	const shouldBlock = useCallback<BlockerFunction>(
		({ currentLocation, nextLocation }) =>
			dirty && currentLocation.pathname !== nextLocation.pathname,
		[dirty],
	)
	useConfirmBlocker(
		shouldBlock,
		_(msg`You have unsaved changes. Leave this page and lose them?`),
	)
	useDirtyBeforeUnload(dirty)
}

type FormBase = {
	savedKey: string
	versions: SettingsVersions
	// JSON of the page's form state right after it was reset to `savedKey`;
	// null until the reset has rendered.
	cleanDraft: string | null
}

/**
 * Form state for a settings page.
 *
 * `saved` is the part of the loader's settings this page edits, `draft` is
 * the page's current form state (anything JSON-serializable), and `reset`
 * puts the form back to a saved value. The form follows the loader while it
 * has no edits. With edits, newer loader data is not applied, so nobody's
 * typing is wiped; the next save then sends the versions the form started
 * from and the server refuses it if those settings changed meanwhile.
 *
 * Also warns before leaving with unsaved edits. A page with several forms
 * must use `useSettingsFormState` for each and call `useUnsavedChangesWarning`
 * once, because React Router only honors one navigation blocker at a time.
 */
export function useSettingsForm<TSaved>(options: SettingsFormOptions<TSaved>) {
	const form = useSettingsFormState(options)
	useUnsavedChangesWarning((options.canUpdate ?? true) && form.dirty)
	return form
}

type SettingsFormOptions<TSaved> = {
	saved: TSaved
	versions: SettingsVersions
	draft: unknown
	reset: (saved: TSaved) => void
	canUpdate?: boolean
	/** The action intent that saves `{ patch, versions }`. */
	intent?: string
	/** Runs once the server accepts a save. */
	onSaved?: () => void
}

/** `useSettingsForm` without the leave warning. */
export function useSettingsFormState<TSaved>({
	saved,
	versions,
	draft,
	reset,
	intent = 'save',
	onSaved,
}: SettingsFormOptions<TSaved>) {
	const fetcher = useFetcher<SettingsSaveResult>()
	const revalidator = useRevalidator()
	const describe = useSettingsErrorText()
	const savedKey = JSON.stringify(saved)
	const draftKey = JSON.stringify(draft)
	const [base, setBase] = useState<FormBase>(() => ({
		savedKey,
		versions,
		cleanDraft: draftKey,
	}))
	const submittedDraft = useRef<string | null>(null)
	const handledResult = useRef<SettingsSaveResult | undefined>(undefined)
	const resetRef = useRef(reset)
	const onSavedRef = useRef(onSaved)
	useLayoutEffect(() => {
		resetRef.current = reset
		onSavedRef.current = onSaved
	})

	const dirty = base.cleanDraft !== null && draftKey !== base.cleanDraft

	const adoptLatest = useCallback(() => {
		resetRef.current(JSON.parse(savedKey) as TSaved)
		setBase({ savedKey, versions, cleanDraft: null })
	}, [savedKey, versions])

	useEffect(() => {
		if (fetcher.state !== 'idle') return
		const result = fetcher.data
		if (result !== handledResult.current) {
			handledResult.current = result
			const sent = submittedDraft.current
			submittedDraft.current = null
			if (result?.ok) {
				onSavedRef.current?.()
				// Edits made while the save was in flight stay in the form.
				if (draftKey === sent) adoptLatest()
				else setBase({ savedKey, versions, cleanDraft: sent })
				return
			}
		}
		if (savedKey !== base.savedKey && !dirty) adoptLatest()
	}, [
		adoptLatest,
		base.savedKey,
		dirty,
		draftKey,
		fetcher.data,
		fetcher.state,
		savedKey,
		versions,
	])

	useEffect(() => {
		if (base.cleanDraft === null) {
			setBase((current) => ({ ...current, cleanDraft: draftKey }))
		}
	}, [base.cleanDraft, draftKey])

	const result = fetcher.state === 'idle' ? fetcher.data : undefined
	const rawFieldErrors = result && !result.ok ? result.fieldErrors : undefined
	const fieldErrors = useSettingsFieldErrors(rawFieldErrors)
	const conflict = Boolean(result && !result.ok && result.error === 'conflict')

	return {
		fetcher,
		pending: fetcher.state !== 'idle',
		result,
		dirty,
		conflict,
		fieldErrors,
		error: result && !result.ok ? describe(result.error) : undefined,
		save(patch: Partial<PhoneAgentSettings>) {
			submittedDraft.current = draftKey
			const keys = Object.keys(patch)
			const body = {
				intent,
				patch,
				versions: Object.fromEntries(
					keys.map((key) => [key, base.versions[key] ?? '']),
				),
			}
			// `settings.vertical` is typed `unknown` but was itself parsed from JSON.
			void fetcher.submit(body as Parameters<typeof fetcher.submit>[0], {
				method: 'POST',
				encType: 'application/json',
			})
		},
		/** Drops unsaved edits and shows the latest saved settings. */
		reload() {
			adoptLatest()
			void revalidator.revalidate()
		},
	}
}

export type SettingsForm = ReturnType<typeof useSettingsForm>

export function SettingsSaveBar({
	canUpdate,
	form,
	disabled,
	label,
}: {
	canUpdate: boolean
	form: Pick<
		SettingsForm,
		'pending' | 'result' | 'error' | 'conflict' | 'reload'
	>
	disabled?: boolean
	label?: React.ReactNode
}) {
	if (!canUpdate) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>You can view these settings but not change them.</Trans>
			</p>
		)
	}
	const { pending, result, error, conflict } = form
	return (
		<div className="flex flex-wrap items-center justify-end gap-3">
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{conflict ? (
				<Button type="button" variant="outline" onClick={form.reload}>
					<Trans>Reload</Trans>
				</Button>
			) : null}
			{result?.ok && !pending ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>Saved</Trans>
				</p>
			) : null}
			<Button type="submit" disabled={pending || disabled}>
				{pending ? <Trans>Saving…</Trans> : (label ?? <Trans>Save</Trans>)}
			</Button>
		</div>
	)
}

/** Short random id for list items the owner creates (`custom_ab12cd`). */
export function localId(prefix: string) {
	const random = Math.random().toString(36).slice(2, 8)
	return `${prefix}_${random}`
}
