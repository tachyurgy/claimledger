// Event-sourced claim lifecycle.
//
// Every mutation to a claim is an immutable event appended to a log; claim state
// is a left fold over that log. Nothing mutates a claim record in place, which is
// what makes the audit trail free and replay-debugging possible: given the same
// event log you always land on the same state.

import { CPT, PAYERS, DENIAL_PLAYBOOK } from './data.js';

export const STATES = [
  'drafted',
  'scrubbed',
  'submitted',
  'acknowledged',
  'adjudicated',
  'denied',
  'appealing',
  'paid',
  'written_off',
  'patient_balance',
];

// Legal transitions. Anything not listed is rejected by `apply`, so an out-of-order
// 835 can't silently move a claim backwards.
const TRANSITIONS = {
  drafted: ['scrubbed', 'written_off'],
  scrubbed: ['submitted', 'drafted'],
  submitted: ['acknowledged', 'denied'],
  // The 835 remittance *is* the adjudication, so an acknowledged claim can settle
  // straight to a terminal money state without passing through `adjudicated`.
  acknowledged: ['adjudicated', 'paid', 'denied', 'patient_balance'],
  adjudicated: ['paid', 'patient_balance', 'denied'],
  denied: ['appealing', 'written_off', 'scrubbed', 'patient_balance'],
  appealing: ['paid', 'denied', 'written_off'],
  paid: [],
  written_off: [],
  patient_balance: ['paid', 'written_off'],
};

export class InvalidTransition extends Error {
  constructor(from, to) {
    super(`illegal claim transition ${from} -> ${to}`);
    this.name = 'InvalidTransition';
    this.from = from;
    this.to = to;
  }
}

let seq = 0;
export function nextSeq() {
  return ++seq;
}

/**
 * Fold a single event into claim state. Pure: (state, event) -> state.
 */
export function apply(claim, event) {
  const next = { ...claim, events: [...claim.events, event] };

  switch (event.type) {
    case 'ClaimDrafted':
      next.state = 'drafted';
      next.charged = event.payload.charged;
      break;

    case 'ClaimScrubbed':
      assertTransition(claim.state, 'scrubbed');
      next.state = 'scrubbed';
      next.scrubFindings = event.payload.findings;
      break;

    case 'ClaimSubmitted': // outbound X12 837P
      assertTransition(claim.state, 'submitted');
      next.state = 'submitted';
      next.submittedAt = event.at;
      next.controlNumber = event.payload.controlNumber;
      next.frequencyCode = event.payload.frequencyCode;
      break;

    case 'ClaimAcknowledged': // inbound X12 277CA
      assertTransition(claim.state, 'acknowledged');
      next.state = 'acknowledged';
      next.ackAt = event.at;
      break;

    case 'RemittanceReceived': { // inbound X12 835
      const { paid, adjustments } = event.payload;
      next.paid = paid;
      next.adjustments = adjustments;
      const patientResp = adjustments
        .filter((a) => a.carc.startsWith('PR-'))
        .reduce((s, a) => s + a.amount, 0);

      if (paid > 0 && patientResp > 0) {
        assertTransition(claim.state, 'patient_balance');
        next.state = 'patient_balance';
        next.patientBalance = patientResp;
      } else if (paid > 0) {
        assertTransition(claim.state, 'paid');
        next.state = 'paid';
      } else {
        assertTransition(claim.state, 'denied');
        next.state = 'denied';
        next.deniedAt = event.at;
      }
      break;
    }

    case 'AppealFiled':
      assertTransition(claim.state, 'appealing');
      next.state = 'appealing';
      next.appealFiledAt = event.at;
      next.appealBasis = event.payload.basis;
      break;

    case 'ClaimWrittenOff':
      assertTransition(claim.state, 'written_off');
      next.state = 'written_off';
      next.writeOffReason = event.payload.reason;
      break;

    case 'BalanceTransferred':
      next.patientBalance = event.payload.amount;
      break;

    default:
      throw new Error(`unknown event type ${event.type}`);
  }
  return next;
}

function assertTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw new InvalidTransition(from, to);
}

/** Rebuild a claim purely from its event log. */
export function replay(seedClaim, events) {
  return events.reduce(apply, { ...seedClaim, events: [], state: 'drafted' });
}

// ---------------------------------------------------------------------------
// Claim scrubber: pre-submission edits. Catching these before the 837 goes out
// is the single cheapest thing an RCM system does — a clean claim costs nothing,
// a denied one costs a human touch.
// ---------------------------------------------------------------------------

export function scrub(claim) {
  const findings = [];
  const cpt = CPT[claim.cpt];

  if (!cpt) findings.push({ severity: 'error', code: 'SCRUB-CPT', msg: `Unknown CPT ${claim.cpt}` });
  if (!claim.icd10 || claim.icd10.length === 0)
    findings.push({ severity: 'error', code: 'SCRUB-DX', msg: 'No diagnosis pointer on the service line' });
  if (!claim.npi || claim.npi.length !== 10)
    findings.push({ severity: 'error', code: 'SCRUB-NPI', msg: 'Rendering provider NPI missing or malformed' });

  // Telehealth place-of-service must carry a telehealth modifier, or payers
  // reject it as a POS/modifier mismatch.
  if (claim.pos === '10' && !(claim.modifiers || []).some((m) => m === '95' || m === 'GT')) {
    findings.push({
      severity: 'error',
      code: 'SCRUB-TELE',
      msg: 'POS 10 (telehealth, patient home) requires modifier 95 or GT',
    });
  }

  // Timely filing: warn well before the cliff so the work is still recoverable.
  const payer = PAYERS[claim.payer];
  if (payer) {
    const age = daysBetween(claim.dos, claim.today);
    const remaining = payer.timelyFilingDays - age;
    if (remaining <= 0)
      findings.push({ severity: 'error', code: 'SCRUB-TFL', msg: `Past ${payer.name} timely filing (${payer.timelyFilingDays}d)` });
    else if (remaining <= 14)
      findings.push({ severity: 'warn', code: 'SCRUB-TFL', msg: `${remaining}d left in timely filing window` });
  }

  // 90837 (60-min) draws payer scrutiny at high volume; flag for documentation.
  if (claim.cpt === '90837')
    findings.push({ severity: 'info', code: 'SCRUB-UTIL', msg: '90837 is a utilization-review magnet; ensure note supports 53+ minutes' });

  return findings;
}

// ---------------------------------------------------------------------------
// Denial triage. The queue is ordered by *expected recoverable dollars*, not raw
// balance — working a $400 denial with a 5% recovery rate is worse than working a
// $90 one at 92%. Age decays the score because appeal windows are hard deadlines.
// ---------------------------------------------------------------------------

export function triageScore(claim, today) {
  const primary = primaryDenial(claim);
  if (!primary) return null;

  const play = DENIAL_PLAYBOOK[primary.carc];
  if (!play) return null;

  const balance = claim.charged - (claim.paid || 0);
  const expected = balance * play.recoveryRate;

  const payer = PAYERS[claim.payer];
  const daysSinceDenial = daysBetween(claim.deniedAt || claim.dos, today);
  const windowLeft = Math.max(0, (payer?.appealWindowDays ?? 180) - daysSinceDenial);

  // Urgency ramps as the appeal window closes: full weight inside 30 days left.
  const urgency = windowLeft <= 0 ? 0 : windowLeft <= 30 ? 1.6 : windowLeft <= 60 ? 1.25 : 1.0;

  return {
    carc: primary.carc,
    rarc: primary.rarc,
    play,
    balance,
    expected,
    windowLeft,
    urgency,
    score: expected * urgency,
    lane: play.autoRemediable ? 'auto' : 'human',
  };
}

export function primaryDenial(claim) {
  const adj = (claim.adjustments || []).filter((a) => !a.carc.startsWith('PR-'));
  if (adj.length === 0) return null;
  // The largest non-patient-responsibility adjustment drives the work.
  return adj.reduce((a, b) => (b.amount > a.amount ? b : a));
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ---------------------------------------------------------------------------
// Portfolio metrics — the numbers an RCM leader actually runs the business on.
// ---------------------------------------------------------------------------

export function metrics(claims, today) {
  const submitted = claims.filter((c) => c.submittedAt);

  // Rate metrics are only meaningful over claims the payer has actually
  // adjudicated. Including claims still in flight would drag every ratio down
  // and make a healthy book look broken.
  const adjudicated = claims.filter((c) => c.events.some((e) => e.type === 'RemittanceReceived'));
  const denied = adjudicated.filter((c) => c.events.some((e) => e.type === 'RemittanceReceived' && e.payload.paid === 0));

  const charged = claims.reduce((s, c) => s + c.charged, 0);
  const collected = claims.reduce((s, c) => s + (c.paid || 0), 0);

  const adjCharged = adjudicated.reduce((s, c) => s + c.charged, 0);
  const adjContractual = adjudicated.reduce(
    (s, c) => s + (c.adjustments || []).filter((a) => a.carc === 'CO-45').reduce((t, a) => t + a.amount, 0),
    0
  );

  // First-pass yield: settled on the first submission, never denied or appealed.
  const firstPass = adjudicated.filter(
    (c) => ['paid', 'patient_balance'].includes(c.state) && !c.events.some((e) => e.type === 'AppealFiled')
  );

  const openAR = claims.filter((c) => !['paid', 'written_off'].includes(c.state));
  const arDays = openAR.length
    ? openAR.reduce((s, c) => s + daysBetween(c.dos, today), 0) / openAR.length
    : 0;

  // Net collection rate = collected / (charged - contractual adjustments), i.e.
  // of the money we were ever contractually entitled to, how much did we get.
  const netCollectible = adjCharged - adjContractual;

  return {
    claims: claims.length,
    submitted: submitted.length,
    adjudicated: adjudicated.length,
    charged,
    collected,
    denialRate: adjudicated.length ? denied.length / adjudicated.length : 0,
    firstPassYield: adjudicated.length ? firstPass.length / adjudicated.length : 0,
    netCollectionRate: netCollectible > 0 ? collected / netCollectible : 0,
    daysInAR: arDays,
    openAR: openAR.reduce((s, c) => s + (c.charged - (c.paid || 0)), 0),
    openCount: openAR.length,
  };
}
