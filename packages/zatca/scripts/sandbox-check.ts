/**
 * Checks this package against ZATCA's developer-portal sandbox, end to end:
 * CSR -> compliance CSID -> the three compliance samples -> production CSID.
 * It also writes the signed sample documents to a folder, so they can be run
 * through ZATCA's SDK validator (`fatoora -validate -invoice <file>`).
 *
 *   npm run sandbox-check -w @repo/zatca -- [output-dir]
 *
 * The developer portal accepts the published test OTP 123345 and test seller
 * data; nothing here is a real taxpayer. This sends requests to ZATCA, so it is
 * never run by tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fatooraClient } from '../src/api.ts'
import { readCertificate } from '../src/cert.ts'
import { generatePrivateKey } from '../src/crypto.ts'
import { buildCsr } from '../src/csr.ts'
import {
	riyadhDateTime,
	signDocument,
	ZATCA_GENESIS_PIH,
} from '../src/document.ts'
import { fromRefund, fromSale } from '../src/from-sale.ts'

const out = path.resolve(process.argv[2] ?? 'zatca-sandbox-output')
fs.mkdirSync(out, { recursive: true })

const seller = {
	name: 'Maximum Speed Tech Supply LTD',
	vatNumber: '399999999900003',
	crNumber: '1010010000',
	street: 'Prince Sultan',
	buildingNumber: '2322',
	district: 'Al-Murabba',
	city: 'Riyadh',
	postalCode: '23333',
}
const key = generatePrivateKey()
const csr = buildCsr(
	{
		environment: 'sandbox',
		organizationName: seller.name,
		organizationUnit: 'Riyadh Branch',
		commonName: 'TST-886431145-399999999900003',
		serialNumber: '1-Menuza|2-POS|3-sandbox-check',
		vatNumber: seller.vatNumber,
		invoiceTypes: '0100',
		address: 'RRRD2929',
		businessCategory: 'Supply activities',
	},
	key,
)
fs.writeFileSync(path.join(out, 'csr.pem'), csr.pem)

const client = fatooraClient('sandbox')
const compliance = await client.complianceCsid(csr.base64Pem, '123345')
if (!compliance.ok) {
	console.error(
		'Compliance CSID refused:',
		compliance.status,
		compliance.error,
		JSON.stringify(compliance.body),
	)
	process.exit(1)
}
console.log('Compliance CSID issued, request', compliance.value.requestId)
const certificate = readCertificate(compliance.value.binarySecurityToken)
const now = new Date()
const meta = (counter: number, previousHash: string, id: string) => ({
	id,
	uuid: crypto.randomUUID(),
	issuedAt: now,
	counter,
	previousHash,
	seller,
})
const invoice = signDocument(
	fromSale(
		{
			lines: [
				{
					name: 'Sample item',
					variantLabel: null,
					quantity: 2,
					baseCents: 1000,
					options: [],
				},
			],
			taxRatePercent: 15,
			taxInclusive: false,
			totals: {
				adjustmentCents: 0,
				taxCents: 300,
				tipCents: 0,
				totalCents: 2300,
			},
			payments: [{ method: 'cash' }],
		},
		meta(1, ZATCA_GENESIS_PIH, 'SME00001'),
	),
	key,
	certificate,
)
const reference = { id: 'SME00001', issueDate: riyadhDateTime(now).date }
const credit = signDocument(
	fromRefund(
		{ amountCents: 1150, method: 'cash', reason: 'Returned item' },
		{ taxRatePercent: 15, totalCents: 2300, outOfScopeCents: 0, taxCents: 300 },
		{
			...meta(2, invoice.invoiceHash, 'SME00002'),
			billingReference: reference,
		},
	),
	key,
	certificate,
)
const debit = signDocument(
	fromRefund(
		{
			amountCents: 230,
			method: 'cash',
			reason: 'Price correction',
			kind: 'debit_note',
		},
		{ taxRatePercent: 15, totalCents: 2300, outOfScopeCents: 0, taxCents: 300 },
		{ ...meta(3, credit.invoiceHash, 'SME00003'), billingReference: reference },
	),
	key,
	certificate,
)
// VAT-inclusive prices whose per-unit net does not add up (50 x 1.00: 43.48 net,
// not 50 x 0.87), so the document-level allowance and the payable rounding
// amount are checked by ZATCA too.
const inclusive = signDocument(
	fromSale(
		{
			lines: [
				{
					name: 'Water',
					variantLabel: null,
					quantity: 50,
					baseCents: 100,
					options: [],
				},
			],
			taxRatePercent: 15,
			taxInclusive: true,
			totals: {
				adjustmentCents: 0,
				taxCents: 652,
				tipCents: 0,
				totalCents: 5000,
			},
			payments: [{ method: 'cash' }],
		},
		meta(4, debit.invoiceHash, 'SME00004'),
	),
	key,
	certificate,
)

let failed = false
for (const [name, document] of [
	['invoice', invoice],
	['credit-note', credit],
	['debit-note', debit],
	['invoice-tax-inclusive', inclusive],
] as const) {
	fs.writeFileSync(path.join(out, `${name}.xml`), document.xml)
	const result = await client.complianceCheck(compliance.value, document)
	console.log(
		`${name}:`,
		result.ok
			? JSON.stringify(result.value)
			: `${result.status} ${result.error} ${JSON.stringify(result.body)}`,
	)
	failed ||= !result.ok
}
if (failed) process.exit(1)
const production = await client.productionCsid(compliance.value)
console.log(
	'Production CSID:',
	production.ok
		? `issued, request ${production.value.requestId}`
		: `${production.status} ${production.error}`,
)
console.log(`Signed samples written to ${out}`)
process.exit(production.ok ? 0 : 1)
