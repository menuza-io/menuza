import {
	ACCOUNT_CHECK_KINDS,
	CUSTOMER_APP_CREDENTIAL_KINDS,
	CUSTOMER_APP_PLATFORMS,
	CUSTOMER_APP_PUBLISHERS,
	CUSTOMER_APP_STORES,
} from '@repo/common/customer-app'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkStoredCredential,
	removeCredential,
	storeCredential,
} from '#app/utils/customer-apps/credentials.server.ts'
import {
	archiveCustomerApp,
	createCustomerApp,
	deleteCustomerApp,
	refreshStoreHealth,
	retryFailedBuilds,
	saveAccountSnapshot,
	startAppBuild,
	startRelease,
	updateCustomerApp,
} from '#app/utils/customer-apps/service.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const id = z.string().min(1).max(64)
const listing = z
	.object({
		subtitle: z.string().max(80).optional(),
		description: z.string().max(4000).optional(),
	})
	.optional()

const CommandSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('create'),
		actorId: id.nullable(),
		organizationId: id,
		displayName: z.string().max(100).optional(),
		iosBundleId: z.string().max(155).optional(),
		androidPackage: z.string().max(155).optional(),
		slug: z.string().max(63).optional(),
		iconBackground: z.string().max(7).optional(),
		publisher: z.enum(CUSTOMER_APP_PUBLISHERS).optional(),
		listingText: listing,
	}),
	z.object({
		intent: z.literal('update'),
		appId: id,
		displayName: z.string().max(100).optional(),
		iosBundleId: z.string().max(155).optional(),
		androidPackage: z.string().max(155).optional(),
		marketingVersion: z.string().max(20).optional(),
		iconBackground: z.string().max(7).optional(),
		publisher: z.enum(CUSTOMER_APP_PUBLISHERS).optional(),
		appleTeamId: z.string().max(10).nullable().optional(),
		androidSha256: z.array(z.string().max(100)).max(5).optional(),
		listingText: listing,
		storeUrls: z
			.object(
				Object.fromEntries(
					CUSTOMER_APP_STORES.map((store) => [
						store,
						z.string().max(500).nullable().optional(),
					]),
				) as Record<
					(typeof CUSTOMER_APP_STORES)[number],
					z.ZodOptional<z.ZodNullable<z.ZodString>>
				>,
			)
			.optional(),
	}),
	z.object({ intent: z.literal('delete'), appId: id }),
	z.object({ intent: z.literal('archive'), appId: id, archived: z.boolean() }),
	z.object({
		intent: z.literal('credential'),
		appId: id,
		kind: z.enum(CUSTOMER_APP_CREDENTIAL_KINDS),
		actorId: id.nullable(),
		payload: z.unknown(),
	}),
	z.object({
		intent: z.literal('credential-remove'),
		appId: id,
		kind: z.enum(CUSTOMER_APP_CREDENTIAL_KINDS),
	}),
	z.object({
		intent: z.literal('credential-check'),
		appId: id,
		kind: z.enum(CUSTOMER_APP_CREDENTIAL_KINDS),
	}),
	z.object({
		intent: z.literal('build'),
		appId: id,
		release: z.string().max(40),
		platforms: z.array(z.enum(CUSTOMER_APP_PLATFORMS)).max(2).optional(),
		actorId: id.nullable(),
	}),
	z.object({
		intent: z.literal('release'),
		appIds: z.array(id).min(1).max(200),
		release: z.string().max(40),
		actorId: id.nullable(),
	}),
	z.object({
		intent: z.literal('retry'),
		release: z.string().max(40),
		appIds: z.array(id).max(200).optional(),
		actorId: id.nullable(),
	}),
	z.object({ intent: z.literal('refresh-health'), appId: id }),
	z.object({
		intent: z.literal('account'),
		appId: id,
		developerAccountExpiresAt: z.number().int().nullable(),
		termsAccepted: z.boolean().nullable(),
		paymentTermsAccepted: z.boolean().nullable(),
		accessOk: z.boolean().nullable(),
	}),
])

void ACCOUNT_CHECK_KINDS

/**
 * Admin's commands on the customer app registry (#156). Admin owns the screens
 * and the permission check (`update:customer_app:any`); the App owns the
 * credential encryption key and the adapters, so Admin reaches it here with
 * the internal command token, like the print shop. Answers never carry a
 * credential value: only whether one is set.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const parsed = CommandSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ ok: false, code: 'invalid', message: 'Invalid command.' },
			{ status: 400 },
		)
	}
	const command = parsed.data
	const answer = (result: object, status = 200) =>
		Response.json(result, { status, headers: { 'Cache-Control': 'no-store' } })
	const respond = (result: { ok: boolean }) =>
		answer(result, result.ok ? 200 : 422)

	switch (command.intent) {
		case 'create': {
			const { intent: _intent, ...input } = command
			return respond(await createCustomerApp(input))
		}
		case 'update': {
			const { intent: _intent, ...input } = command
			return respond(await updateCustomerApp(input))
		}
		case 'delete':
			return respond(await deleteCustomerApp(command.appId))
		case 'archive':
			return respond(await archiveCustomerApp(command.appId, command.archived))
		case 'credential': {
			const result = await storeCredential({
				appId: command.appId,
				kind: command.kind,
				payload: command.payload,
				uploadedById: command.actorId,
			})
			return respond(result)
		}
		case 'credential-remove':
			await removeCredential(command.appId, command.kind)
			return answer({ ok: true })
		case 'credential-check':
			return answer({
				ok: true,
				valid: await checkStoredCredential(command.appId, command.kind),
			})
		case 'build':
			return respond(
				await startAppBuild({
					appId: command.appId,
					release: command.release,
					platforms: command.platforms,
					actorId: command.actorId,
				}),
			)
		case 'release':
			return answer({
				ok: true,
				...(await startRelease({
					appIds: command.appIds,
					release: command.release,
					actorId: command.actorId,
				})),
			})
		case 'retry':
			return answer({
				ok: true,
				...(await retryFailedBuilds({
					release: command.release,
					appIds: command.appIds,
					actorId: command.actorId,
				})),
			})
		case 'refresh-health':
			return respond(await refreshStoreHealth(command.appId, { force: true }))
		case 'account':
			await saveAccountSnapshot(command.appId, {
				developerAccountExpiresAt: command.developerAccountExpiresAt,
				termsAccepted: command.termsAccepted,
				paymentTermsAccepted: command.paymentTermsAccepted,
				accessOk: command.accessOk,
			})
			return answer({ ok: true })
	}
}
