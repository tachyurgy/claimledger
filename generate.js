// Deterministic claim generator. Seeded PRNG so the board is identical on every
// load — a demo that reshuffles on refresh is impossible to talk through.

import { CPT, PAYERS, PROVIDERS, ICD10, DENIAL_PLAYBOOK } from './data.js';
import { apply, scrub, nextSeq } from './engine.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const money = (n) => Math.round(n * 100) / 100;

const TODAY = '2026-07-24';

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Denial mix weighted to what a behavioral-health book of business actually sees.
const DENIAL_MIX = [
  ['CO-16', 0.17], ['CO-197', 0.14], ['CO-45', 0.13], ['PR-2', 0.11],
  ['PR-1', 0.09], ['CO-97', 0.08], ['CO-50', 0.07], ['CO-109', 0.06],
  ['PR-3', 0.05], ['CO-B7', 0.04], ['CO-18', 0.03], ['CO-29', 0.02], ['CO-96', 0.01],
];

function weightedCarc(rng) {
  let r = rng();
  for (const [carc, w] of DENIAL_MIX) {
    if (r < w) return carc;
    r -= w;
  }
  return 'CO-16';
}

export function generateClaims(n = 240, seed = 20260724) {
  const rng = mulberry32(seed);
  const payerKeys = Object.keys(PAYERS);
  const cptKeys = Object.keys(CPT);
  const dxKeys = Object.keys(ICD10);
  const out = [];

  for (let i = 0; i < n; i++) {
    const payerKey = pick(rng, payerKeys);
    const payer = PAYERS[payerKey];
    const cptCode = pick(rng, cptKeys);
    const cpt = CPT[cptCode];
    const provider = pick(rng, PROVIDERS);
    const dos = addDays(TODAY, -Math.floor(rng() * 95) - 3);

    // Charge is the allowed amount inflated by a billing multiplier.
    const charged = money(cpt.allowed * (1.35 + rng() * 0.55));
    const telehealth = rng() < 0.62;
    const mods = telehealth ? ['95'] : [];
    if (provider.license === 'LCSW' && rng() < 0.3) mods.push('AJ');

    // Seed a few claims with genuine data defects so the scrubber has real work.
    const defect = rng();
    const claimBase = {
      id: `CLM-${(100000 + i).toString()}`,
      patient: `PT-${(4000 + Math.floor(rng() * 3000)).toString()}`,
      payer: payerKey,
      payerName: payer.name,
      cpt: cptCode,
      cptDesc: cpt.desc,
      icd10: defect < 0.04 ? [] : [pick(rng, dxKeys)],
      npi: defect >= 0.04 && defect < 0.07 ? '18412' : provider.npi,
      provider: provider.name,
      license: provider.license,
      dos,
      today: TODAY,
      pos: telehealth ? '10' : '11',
      modifiers: defect >= 0.07 && defect < 0.11 && telehealth ? [] : mods,
      charged,
      units: 1,
      events: [],
      state: 'drafted',
    };

    let claim = { ...claimBase };
    const ev = (type, payload, at) => {
      claim = apply(claim, { seq: nextSeq(), type, at, payload });
    };

    ev('ClaimDrafted', { charged }, dos);

    const findings = scrub(claim);
    ev('ClaimScrubbed', { findings }, addDays(dos, 1));

    // A claim with a blocking scrub error stops here — that is the point of the
    // scrubber, and these show up as the "needs repair" pre-submission bucket.
    const blocked = findings.some((f) => f.severity === 'error');
    if (blocked) {
      out.push(claim);
      continue;
    }

    const subAt = addDays(dos, 1 + Math.floor(rng() * 3));
    ev('ClaimSubmitted', { controlNumber: `8371${(500000 + i).toString()}`, frequencyCode: '1' }, subAt);

    const ackAt = addDays(subAt, 1 + Math.floor(rng() * 2));
    if (new Date(ackAt) > new Date(TODAY)) { out.push(claim); continue; }
    ev('ClaimAcknowledged', {}, ackAt);

    const remitAt = addDays(subAt, payer.avgDaysToPay + Math.floor(rng() * 12) - 5);
    if (new Date(remitAt) > new Date(TODAY)) { out.push(claim); continue; }

    // Adjudicate. ~72% of acknowledged claims land clean.
    const clean = rng() < 0.72;
    const contractual = money(Math.max(0, charged - cpt.allowed));

    if (clean) {
      const patientShare = rng();
      const adjustments = [{ carc: 'CO-45', amount: contractual, note: 'Contractual adjustment' }];
      let paid = cpt.allowed;

      if (patientShare < 0.34) {
        const prCarc = patientShare < 0.12 ? 'PR-1' : patientShare < 0.26 ? 'PR-2' : 'PR-3';
        const prAmt = money(cpt.allowed * (prCarc === 'PR-1' ? 0.55 : prCarc === 'PR-2' ? 0.2 : 0.15));
        adjustments.push({ carc: prCarc, amount: prAmt, note: DENIAL_PLAYBOOK[prCarc].label });
        paid = money(cpt.allowed - prAmt);
      }
      ev('RemittanceReceived', { paid: money(paid), adjustments, traceNumber: `ERA${900000 + i}` }, remitAt);
    } else {
      const carc = weightedCarc(rng);
      const play = DENIAL_PLAYBOOK[carc];
      const rarcPool = play.rarcHints ? Object.keys(play.rarcHints) : ['N130', 'MA130', 'N19'];
      const rarc = pick(rng, rarcPool);

      if (carc === 'CO-45') {
        // Pure contractual: paid, not denied.
        ev('RemittanceReceived', { paid: money(cpt.allowed), adjustments: [{ carc: 'CO-45', amount: contractual, note: 'Contractual adjustment' }], traceNumber: `ERA${900000 + i}` }, remitAt);
      } else if (carc.startsWith('PR-')) {
        const prAmt = money(cpt.allowed * 0.4);
        ev('RemittanceReceived', {
          paid: money(cpt.allowed - prAmt),
          adjustments: [
            { carc: 'CO-45', amount: contractual, note: 'Contractual adjustment' },
            { carc, amount: prAmt, rarc, note: play.label },
          ],
          traceNumber: `ERA${900000 + i}`,
        }, remitAt);
      } else {
        ev('RemittanceReceived', {
          paid: 0,
          adjustments: [{ carc, amount: charged, rarc, note: play.label }],
          traceNumber: `ERA${900000 + i}`,
        }, remitAt);

        // Some denials have already been worked.
        const worked = rng();
        if (worked < 0.22) {
          ev('AppealFiled', { basis: play.action }, addDays(remitAt, 2 + Math.floor(rng() * 9)));
        } else if (worked < 0.3 && play.recoveryRate < 0.25) {
          ev('ClaimWrittenOff', { reason: `${carc} — non-recoverable per playbook` }, addDays(remitAt, 5));
        }
      }
    }
    out.push(claim);
  }
  return out;
}

export { TODAY };
