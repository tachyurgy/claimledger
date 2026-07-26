# Claim Ledger

**Event-sourced denial-management workbench for outpatient behavioral health revenue cycle.**

Live: **https://claimledger.levelbrook.com**

## What this is

Revenue cycle management for a provider org is the place where correctness is money and the
audit trail is regulatory. Claim Ledger models that workflow end to end.

## Engineering notes

### Append-only event log

Every claim is a sequence of events (`ClaimDrafted`, `ClaimScrubbed`,
`ClaimSubmitted` 837P, `ClaimAcknowledged` 277CA, `RemittanceReceived` 835) and current state is a left fold
over that log. The audit trail is therefore free, and any claim can be replayed to a prior state.

### Explicit legal-transition table

State changes are validated against a transition table rather
than assigned. This caught a real bug during development: an out-of-order 835 was walking a claim backwards,
and the guard raised `InvalidTransition` instead of silently corrupting the record.

### Triage by expected recoverable dollars

The work queue is ordered by expected recovery, not raw
balance. Working a $400 denial at a 5 percent recovery rate is worse than working a $90 one at 92 percent.

### Deterministic vs human lanes

Denials split into a lane a machine can clear (CO-16 repair and
resubmit as a corrected claim, CO-45 contractual write-off, PR-1/2/3 balance transfer) and a lane that genuinely
needs a person (CO-197 authorization, CO-50 medical necessity, CO-B7 credentialing).

### Real reference data

CARC and RARC codes drawn from the 835 CAS and LQ segments, behavioral
health CPT codes, and payer-specific timely filing and appeal windows.

## Stack

Vanilla JavaScript (no framework), deterministic engine module, static hosting


## Running it

Static. Open `index.html`, or serve the directory:

```
python3 -m http.server 8000
```

## Honest scope

This is a focused engineering demo, not a production system. The data is synthetic and generated
locally so that the behaviour is reproducible. The reasoning, the arithmetic and the failure modes
are the point; the surface area is deliberately narrow.

## License

MIT
