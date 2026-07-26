// Reference data for behavioral-health revenue cycle management.
// CARC = Claim Adjustment Reason Code (X12 835 CAS segment)
// RARC = Remittance Advice Remark Code (X12 835 LQ segment)

export const CPT = {
  '90791': { desc: 'Psychiatric diagnostic evaluation', allowed: 185.0, minutes: 60 },
  '90792': { desc: 'Psych diagnostic eval with medical services', allowed: 215.0, minutes: 60 },
  '90832': { desc: 'Psychotherapy, 30 minutes', allowed: 78.5, minutes: 30 },
  '90834': { desc: 'Psychotherapy, 45 minutes', allowed: 105.0, minutes: 45 },
  '90837': { desc: 'Psychotherapy, 60 minutes', allowed: 152.0, minutes: 60 },
  '90846': { desc: 'Family psychotherapy without patient', allowed: 118.0, minutes: 50 },
  '90847': { desc: 'Family psychotherapy with patient', allowed: 132.0, minutes: 50 },
  '90853': { desc: 'Group psychotherapy', allowed: 42.0, minutes: 60 },
  '99213': { desc: 'Office visit, established patient, low', allowed: 96.0, minutes: 20 },
  '99214': { desc: 'Office visit, established patient, moderate', allowed: 138.0, minutes: 30 },
};

export const MODIFIERS = {
  '95': 'Synchronous telemedicine via real-time A/V',
  GT: 'Via interactive audio and video',
  HO: "Master's degree level clinician",
  HN: "Bachelor's degree level clinician",
  AJ: 'Clinical social worker',
  '59': 'Distinct procedural service',
};

export const PAYERS = {
  AETNA: { name: 'Aetna Behavioral Health', timelyFilingDays: 90, appealWindowDays: 180, avgDaysToPay: 18, epayer: '60054' },
  ANTHEM: { name: 'Anthem BCBS', timelyFilingDays: 90, appealWindowDays: 180, avgDaysToPay: 24, epayer: '00040' },
  CIGNA: { name: 'Cigna Behavioral', timelyFilingDays: 90, appealWindowDays: 180, avgDaysToPay: 21, epayer: '62308' },
  OPTUM: { name: 'Optum / UHC Behavioral', timelyFilingDays: 90, appealWindowDays: 12 * 30, avgDaysToPay: 26, epayer: '87726' },
  CARELON: { name: 'Carelon Behavioral Health', timelyFilingDays: 60, appealWindowDays: 90, avgDaysToPay: 31, epayer: '47198' },
  MAGELLAN: { name: 'Magellan Health', timelyFilingDays: 60, appealWindowDays: 90, avgDaysToPay: 29, epayer: '01260' },
};

// The denial playbook. Each entry maps a CARC (optionally + RARC) to a
// deterministic remediation path. `autoRemediable` drives the bot-vs-human split.
export const DENIAL_PLAYBOOK = {
  'CO-16': {
    label: 'Claim lacks information or has submission/billing error',
    category: 'Data integrity',
    autoRemediable: true,
    recoveryRate: 0.92,
    action: 'Repair claim from EHR source of truth, resubmit as corrected claim (837P freq code 7).',
    rarcHints: {
      N290: 'Missing/incomplete/invalid rendering provider primary identifier (NPI).',
      M76: 'Missing/incomplete/invalid diagnosis or condition.',
      N480: 'Incomplete/invalid patient medical record.',
    },
  },
  'CO-97': {
    label: 'Benefit included in payment for another service already adjudicated',
    category: 'Bundling',
    autoRemediable: true,
    recoveryRate: 0.61,
    action: 'Check NCCI edits. If services are distinct, append modifier 59 and resubmit corrected.',
  },
  'CO-18': {
    label: 'Exact duplicate claim or service',
    category: 'Duplicate',
    autoRemediable: true,
    recoveryRate: 0.08,
    action: 'Verify against prior 835. If genuine duplicate, close as non-recoverable; do not resubmit.',
  },
  'CO-29': {
    label: 'Time limit for filing has expired',
    category: 'Timely filing',
    autoRemediable: false,
    recoveryRate: 0.22,
    action: 'Appeal only with proof of timely submission (277CA acknowledgment). Otherwise write off.',
  },
  'CO-50': {
    label: 'Non-covered — not deemed a medical necessity by the payer',
    category: 'Medical necessity',
    autoRemediable: false,
    recoveryRate: 0.48,
    action: 'Route to clinical appeals. Requires provider notes and letter of medical necessity.',
  },
  'CO-197': {
    label: 'Precertification/authorization absent',
    category: 'Authorization',
    autoRemediable: false,
    recoveryRate: 0.55,
    action: 'Retro-auth request to payer. Escalate to intake to fix the auth gap at scheduling.',
  },
  'CO-45': {
    label: 'Charge exceeds fee schedule / maximum allowable',
    category: 'Contractual',
    autoRemediable: true,
    recoveryRate: 0.0,
    action: 'Contractual adjustment. Post write-off automatically; no appeal path.',
  },
  'PR-1': {
    label: 'Deductible amount',
    category: 'Patient responsibility',
    autoRemediable: true,
    recoveryRate: 0.74,
    action: 'Transfer balance to patient ledger, trigger statement cadence.',
  },
  'PR-2': {
    label: 'Coinsurance amount',
    category: 'Patient responsibility',
    autoRemediable: true,
    recoveryRate: 0.79,
    action: 'Transfer balance to patient ledger, trigger statement cadence.',
  },
  'PR-3': {
    label: 'Copayment amount',
    category: 'Patient responsibility',
    autoRemediable: true,
    recoveryRate: 0.86,
    action: 'Transfer balance to patient ledger; reconcile against point-of-service collection.',
  },
  'CO-109': {
    label: 'Claim not covered by this payer/contractor',
    category: 'Coordination of benefits',
    autoRemediable: true,
    recoveryRate: 0.67,
    action: 'Re-run 270/271 eligibility, rebill to the correct payer on file.',
  },
  'CO-B7': {
    label: 'Provider not certified/eligible for this procedure on this date',
    category: 'Credentialing',
    autoRemediable: false,
    recoveryRate: 0.51,
    action: 'Route to credentialing. Check roster effective date vs date of service.',
  },
  'CO-96': {
    label: 'Non-covered charge(s)',
    category: 'Benefit design',
    autoRemediable: false,
    recoveryRate: 0.31,
    action: 'Verify benefit carve-out. If plan excludes the service, transfer to patient with ABN.',
  },
};

export const RARC = {
  N130: 'Consult plan benefit documents for information about restrictions.',
  M76: 'Missing/incomplete/invalid diagnosis or condition.',
  N290: 'Missing/incomplete/invalid rendering provider primary identifier.',
  N480: 'Incomplete/invalid patient medical record for this service.',
  MA130: 'Claim contains incomplete/invalid information; no appeal rights.',
  N19: 'Procedure code incidental to primary procedure.',
  N56: 'Procedure code billed is inconsistent with the date of service.',
  N448: 'This drug/service/supply is not included in the fee schedule.',
};

export const PROVIDERS = [
  { npi: '1841298374', name: 'A. Okonkwo, LCSW', license: 'LCSW', states: ['CA', 'NV'] },
  { npi: '1730294857', name: 'R. Vasquez, LMFT', license: 'LMFT', states: ['CA', 'AZ'] },
  { npi: '1992847361', name: 'S. Bhattacharya, PsyD', license: 'PsyD', states: ['NY', 'NJ'] },
  { npi: '1558473920', name: 'M. Lindqvist, PMHNP', license: 'PMHNP', states: ['WA', 'OR'] },
  { npi: '1667382910', name: 'D. Achterberg, LPC', license: 'LPC', states: ['TX'] },
  { npi: '1445029183', name: 'J. Moreau, LCSW', license: 'LCSW', states: ['IL', 'WI'] },
];

export const ICD10 = {
  'F41.1': 'Generalized anxiety disorder',
  'F33.1': 'Major depressive disorder, recurrent, moderate',
  'F43.12': 'Post-traumatic stress disorder, chronic',
  'F90.2': 'ADHD, combined type',
  'F31.81': 'Bipolar II disorder',
  'F42.2': 'Mixed obsessional thoughts and acts',
  'F50.02': 'Anorexia nervosa, binge eating/purging type',
};
