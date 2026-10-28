# Sign-in and email domains

This guide is for the platform operator and for the customer's IT team. It explains how the one sign-in page of the MSCD SaaS service finds a person's organisation, what the customer adds to DNS to prove that it owns its email domain, and what happens after that. It belongs to work package M2-S11 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s11-organisation-discovery-at-sign-in).

## One sign-in page for every organisation

Every customer organisation signs in at the same address, `https://app.<domain>/login` (decision D-S3). The page shows the "Work email" field and the password field from the start, so a person who signs in with a password fills in both and presses Continue, as before.

The page finds the person's organisation in three ways:

| Way | What the person sees |
|---|---|
| The link names the organisation: `https://app.<domain>/login?org=<slug>` | The organisation's company sign-in buttons (for example "Sign in with Microsoft") at once. Use this link in emails and on the customer's intranet |
| The browser remembers it | After a sign-in, the browser keeps the organisation's slug. The next time the sign-in page opens on that browser, it shows that organisation's buttons at once, with the link "Use a different organisation" to forget it |
| The email address | While the person types, the page looks up the part after `@`. When the customer has verified that email domain, the page adds the organisation's company sign-in buttons |

The password field disappears only when the organisation allows company sign-in alone (its Tenant Administrator set local sign-in to "disabled"). The person then uses the company sign-in button. When that organisation came from the link (`?org=<slug>`), the page also shows "Use a different organisation": a person of another organisation who got the link clicks it and signs in with email and password.

The sign-in page never tells a stranger which organisations use MSCD. An unknown slug, an email domain that no organisation verified, and an organisation without company sign-in all get the same answer: the email and password form, with no buttons. The server also answers at most 20 lookups a minute from one network address; after that the page shows no new buttons for a minute, and signing in with email and password still works.

The footer of the page links to the privacy notice and the terms of service. The server profile keys `legal.privacy_url` and `legal.terms_url` hold their addresses (as environment settings: `MSCD__LEGAL__PRIVACY_URL` and `MSCD__LEGAL__TERMS_URL`), and each link is hidden while its key is empty. The GitHub variables `LEGAL_PRIVACY_URL` and `LEGAL_TERMS_URL` of [owner-inputs.md](owner-inputs.md) hold the same addresses, but the deploy does not pass them to the server yet; until it does, the SaaS sign-in page shows no footer links.

## Why an email domain is verified

An organisation's email domain is the part of its staff's addresses after `@`, for example `nusantaradigital.co.id`. The service uses a verified domain for two things:

- **Sign-in by email:** the sign-in page shows the organisation's company sign-in buttons to anyone who types an address of that domain.
- **Accounts made at first sign-in:** when the Tenant Administrator allows it for a company sign-in provider, a person of a verified domain who signs in with that provider for the first time gets an MSCD account in the organisation at once (just-in-time provisioning). Without a verified domain, every person needs an invitation first.

Because of this, a domain is verified only when the customer proves that it controls the domain's DNS, and a verified domain belongs to one organisation only. Domains of free mail services, such as `gmail.com`, `yahoo.com`, `yahoo.co.id`, `outlook.com` and `hotmail.com`, can never be verified: anyone can get an address there.

Inviting people does not need a verified domain. A customer that never verifies a domain can still use MSCD fully.

## Steps

### 1. The operator adds the domain

In the operator console, open the organisation, then **Domains**, then **Add domain**, and type the domain, for example `nusantaradigital.co.id`. (The console screens for domains come with work package M2-S12; until then the same steps are the operator routes `POST /api/v1/ops/organizations/<slug>/domains`, `POST .../domains/<domain>/verify` and `DELETE .../domains/<domain>`.) International names are accepted and stored in their DNS form (punycode). The console shows the DNS record to add, once:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name (host) | `_mscd-verify.nusantaradigital.co.id` |
| Value | `mscd-verify=` followed by a code of 43 letters, digits, `-` and `_` |

Copy the value at once and send it to the customer's IT team. MSCD keeps only a fingerprint of the code, so it cannot show the value again. If the value is lost, add the domain again: that gives a new value and a new 7-day period, and the old value no longer counts.

The console refuses the domain when another organisation has already verified it ("already verified for another organisation"). Remove it there first if it moved to this customer.

### 2. The customer's IT team adds the record

The IT team adds the TXT record in the DNS of the domain, where the domain's other records are kept (their DNS host or registrar). Some DNS consoles want only `_mscd-verify` in the Name field and add the domain themselves. The record can stay next to other TXT records such as SPF.

A change in DNS can take from a few minutes to a few hours to be visible everywhere.

### 3. MSCD checks the record

- **Every hour**, MSCD looks for the record of every domain that waits for verification. When it finds the value, the domain is verified.
- **Verify now** in the console checks at once and says whether the record was found.
- **After 7 days** without the record, the domain is marked **failed**. Add it again for a new value and 7 more days.

### 4. After verification

- The domain shows **verified** in the console, and the sign-in page offers the organisation's company sign-in buttons for addresses of that domain.
- The Tenant Administrator can now allow accounts at first sign-in for a company sign-in provider that lists the domain.
- **Once a month**, MSCD checks that the record is still there. If it is gone, the domain **stays verified**, so nobody is locked out, and every platform operator gets the email "the DNS record of <domain> is gone". Ask the customer's IT team whether the record was removed on purpose. If it was removed by mistake, the customer puts the same value back. If nobody has the value any more, or the customer no longer owns the domain, remove the domain in the console; add it again to get a new value.

Keep the record in DNS for as long as the customer uses MSCD.

### Removing a domain

**Remove** in the console deletes the domain at once. The sign-in page stops showing the organisation's buttons for that domain, and no new account is made at first sign-in for it. People who already have accounts keep them.

## Statuses

| Status | Meaning |
|---|---|
| pending | Added; MSCD looks for the record every hour until the date shown |
| verified | The record was found (method `dns`), or the operator verified it by hand (method `manual`) |
| failed | The record was not found within 7 days, or another organisation verified the domain first. Add it again to start over |

## Verifying a domain by hand

On-premise installations have no operator console for domains: the operator verifies a domain with the command below after checking ownership in another way.

```bash
mscd-server tenant verify-domain --org <slug> --domain <domain> --by "<who checked it, or a ticket>"
```

On SaaS, the same command needs a reason, because a domain is normally verified by its DNS record. Use it only when the customer cannot add a TXT record, and keep the proof in the ticket:

```bash
mscd-server tenant verify-domain --org <slug> --domain <domain> --by "<operator name>" --manual-reason "<why, and where the proof is>"
```

The domain then shows method `manual`, and the audit trail keeps the reason. A domain verified by hand has no DNS record, so it is not checked monthly.

## What is recorded

Every change is written to the platform audit trail with the operator who made it:

| Action | When |
|---|---|
| `ops.domain_added` | A domain was added or added again (never the value of the record) |
| `ops.domain_verified` | The record was found, or the operator verified the domain by hand |
| `ops.domain_verification_failed` | "Verify now" did not find the record, the 7 days ended, or the monthly check found the record gone |
| `ops.domain_removed` | A domain was removed |

## For the operator: DNS settings of the service

MSCD looks up the records through the DNS servers of the server's system. The profile key `network.dns_resolvers` can name other DNS servers, for example `["1.1.1.1", "8.8.8.8"]`. When no DNS server answers, "Verify now" says so and nothing changes; the hourly check tries again the next hour.
