# Mailbox

The App sidebar links to `/:orgSlug/mailbox`. Forms is the first mailbox source;
the source registry in the route supports adding other inbox sources later.
Operators can search all submissions, filter unread entries, page through older
submissions, and review a submission alongside the list. Mobile switches between
the list and details with a Back button.

## Authorization and regional data

Mailbox requires `READ_WEBSITE_ANY`. App's `/:orgSlug/mailbox-token` resource
returns a 15-minute operator JWT scoped to `mailbox`, with the authenticated
user ID as its subject, and the organization's regional API URL. The browser
calls `/operator/mailbox/*` directly. App never proxies submission values or
reply bodies. Mailbox tokens cannot authorize the other operator endpoints.

Tenant-api checks active organization metadata and the node's `DATA_REGION`
before opening the tenant database. With `APP_URL` configured, it obtains that
metadata from App's internal `/resources/tenant-organization` endpoint, using
`INTERNAL_COMMAND_TOKEN`, rather than relying on a node-local control-plane
SQLite copy. The lookup works for unpublished organizations. Missing metadata
returns `Organization not found`; a genuine region mismatch returns
`Mailbox is not available in this region`.

Unread counts are per operator, across all forms. Opening a submission writes a
regional `mailbox_read_receipts` row keyed by submission and operator. Mark
unread removes that operator's receipt. Counts refresh after mutations, on
window focus, and every minute while the page is visible. Deleting submissions,
form deletion, and retention purges cascade to their read receipts.

Tenant migration `0010_mailbox_read_receipts` applies through the existing lazy
tenant migration runner; no control-plane migration is needed.

## Replies

The composer uses the first valid, populated email field in the form definition.
Without an email field, details remain available and the page explains why an
email reply is unavailable. Reply drafts stay in page memory independently for
each submission. Leaving with a message prompts before discarding drafts.

“Open in email app” creates an encoded `mailto:` link containing recipient,
subject, and plain-text message. The operator reviews and sends the email in
their email app. The mailbox does not send email or claim that a reply was sent.
The operator needs a configured email handler; mail clients may limit the length
of messages accepted through `mailto:`.

## Optional AI drafting

Configure these on the **regional tenant-api node**, never on App or Sites:

| Variable                 | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `MAILBOX_AI_BASE_URL`    | OpenAI-compatible API base URL, including `/v1`    |
| `MAILBOX_AI_API_KEY`     | Provider credential                                |
| `MAILBOX_AI_MODEL`       | Model identifier supported by that endpoint        |
| `MAILBOX_AI_DATA_REGION` | `us` or `ksa`; must match the node's `DATA_REGION` |

The administrator must verify that the endpoint's processing and storage stay
within the declared data region. Setting the region is an explicit deployment
attestation, not a geographic guarantee inferred from the endpoint URL. There is
no default provider, cross-region fallback, or redirect following. Incomplete or
mismatched configuration disables AI drafting. Requests use the
[Chat Completions protocol](https://developers.openai.com/api/reference/resources/chat).

The regional API reads the selected submission itself, omits typed name, email,
and phone fields from the prompt, and passes bounded answers and optional
operator notes as untrusted context. Free-text answers can still contain PII,
which is why the regional provider requirement applies. Generation is rate
limited, times out after 30 seconds, and validates the returned plain-text
draft.

AI fills the editable message only. It never sends a reply. A nonempty message
must be cleared explicitly before generating another draft, so AI does not
silently replace operator edits.
