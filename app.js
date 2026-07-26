import { DENIAL_PLAYBOOK, RARC, PAYERS } from './data.js';
import { triageScore, metrics, apply, nextSeq, daysBetween, replay } from './engine.js';
import { generateClaims, TODAY } from './generate.js';

let claims = generateClaims(240);
let selectedId = null;
let filters = { payer: '', lane: '', carc: '', q: '' };

const $ = (s) => document.querySelector(s);
const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => (n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmt(n));
const pct = (n) => (n * 100).toFixed(1) + '%';

// ---------------------------------------------------------------- metrics
function renderMetrics() {
  const m = metrics(claims, TODAY);
  const tiles = [
    { k: 'Charged', v: fmtK(m.charged), sub: `${m.claims} claims · ${m.adjudicated} adjudicated`, cls: '' },
    { k: 'Net collection', v: pct(m.netCollectionRate), sub: `${fmtK(m.collected)} collected`, cls: m.netCollectionRate > 0.9 ? 'good' : 'warn' },
    { k: 'Denial rate', v: pct(m.denialRate), sub: 'of adjudicated claims', cls: m.denialRate > 0.2 ? 'bad' : 'warn' },
    { k: 'First-pass yield', v: pct(m.firstPassYield), sub: 'settled without rework', cls: m.firstPassYield > 0.7 ? 'good' : 'warn' },
    { k: 'Days in A/R', v: m.daysInAR.toFixed(0), sub: `${m.openCount} claims open`, cls: m.daysInAR > 40 ? 'bad' : '' },
    { k: 'Open A/R', v: fmtK(m.openAR), sub: 'unresolved balance', cls: '' },
  ];
  $('#metrics').innerHTML = tiles
    .map((t) => `<div class="metric ${t.cls}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sub">${t.sub}</div></div>`)
    .join('');
}

// ---------------------------------------------------------------- triage queue
function triaged() {
  return claims
    .filter((c) => c.state === 'denied')
    .map((c) => ({ claim: c, t: triageScore(c, TODAY) }))
    .filter((x) => x.t)
    .filter((x) => {
      if (filters.payer && x.claim.payer !== filters.payer) return false;
      if (filters.lane && x.t.lane !== filters.lane) return false;
      if (filters.carc && x.t.carc !== filters.carc) return false;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        const hay = `${x.claim.id} ${x.claim.patient} ${x.claim.provider} ${x.claim.cpt} ${x.t.carc}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.t.score - a.t.score);
}

function renderQueue() {
  const rows = triaged();
  const totalExp = rows.reduce((s, r) => s + r.t.expected, 0);
  $('#queueCount').textContent = `${rows.length} open · ${fmtK(totalExp)} expected`;

  if (!rows.length) {
    $('#queue').innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-3);font-size:13px">No denials match the current filter.</div>`;
    return;
  }

  $('#queue').innerHTML = rows
    .map(({ claim, t }) => {
      const tight = t.windowLeft <= 30;
      return `<div class="row ${claim.id === selectedId ? 'sel' : ''}" data-id="${claim.id}">
      <div class="carc ${t.lane}">${t.carc}</div>
      <div class="lbl">
        <div class="t">${t.play.label}</div>
        <div class="m">${claim.id} · ${claim.payerName} · CPT ${claim.cpt} · ${claim.provider}</div>
      </div>
      <div class="amt">
        <div class="exp">${fmt(t.expected)}</div>
        <div class="bal">of ${fmt(t.balance)}</div>
      </div>
      <div class="win ${tight ? 'tight' : ''}">${t.windowLeft}d</div>
    </div>`;
    })
    .join('');

  $('#queue').querySelectorAll('.row').forEach((el) =>
    el.addEventListener('click', () => {
      selectedId = el.dataset.id;
      render();
    })
  );
}

// ---------------------------------------------------------------- detail
function renderDetail() {
  const claim = claims.find((c) => c.id === selectedId);
  if (!claim) {
    $('#detail').innerHTML = `<div class="empty">Select a denial from the work queue to inspect its event log, remittance adjustments, and remediation playbook.</div>`;
    return;
  }
  const t = triageScore(claim, TODAY);
  const payer = PAYERS[claim.payer];

  const head = `<div class="dsec">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:11px;flex-wrap:wrap">
      <strong style="font-size:15px;font-family:var(--mono)">${claim.id}</strong>
      <span class="state-pill state-${claim.state}">${claim.state.replace('_', ' ')}</span>
      <span style="flex:1"></span>
      ${t && t.lane === 'auto' ? `<button class="primary" id="btnAuto">Run auto-remediation</button>` : ''}
      ${t && t.lane === 'human' ? `<button id="btnAppeal">File appeal</button>` : ''}
    </div>
    <dl class="kv">
      <dt>Patient</dt><dd>${claim.patient}</dd>
      <dt>Payer</dt><dd>${claim.payerName} <span style="color:var(--ink-3)">(payer id ${payer.epayer})</span></dd>
      <dt>Service</dt><dd>${claim.cpt} — ${claim.cptDesc}</dd>
      <dt>Diagnosis</dt><dd>${claim.icd10.join(', ') || '<span style="color:var(--rose)">none</span>'}</dd>
      <dt>Rendering</dt><dd>${claim.provider} · NPI ${claim.npi}</dd>
      <dt>Date of service</dt><dd>${claim.dos} <span style="color:var(--ink-3)">(${daysBetween(claim.dos, TODAY)}d ago)</span></dd>
      <dt>POS / modifiers</dt><dd>${claim.pos}${claim.modifiers.length ? ' · ' + claim.modifiers.join(', ') : ''}</dd>
      <dt>Charged</dt><dd>${fmt(claim.charged)}</dd>
    </dl>
  </div>`;

  const play = t
    ? `<div class="dsec">
      <h3>Remediation playbook</h3>
      <div class="playbook">
        <span class="cat">${t.play.category}</span>
        <div class="desc">${t.carc} — ${t.play.label}</div>
        ${t.rarc ? `<div class="act" style="margin-bottom:7px"><strong class="mono">${t.rarc}</strong> ${RARC[t.rarc] || ''}</div>` : ''}
        <div class="act">${t.play.action}</div>
        <div class="rate">
          lane=<strong style="color:${t.lane === 'auto' ? 'var(--teal)' : 'var(--amber)'}">${t.lane}</strong>
          · recovery=${pct(t.play.recoveryRate)}
          · expected=${fmt(t.expected)}
          · appeal window=${t.windowLeft}d
        </div>
        <div class="bar">
          <i style="width:${t.play.recoveryRate * 100}%;background:var(--teal)"></i>
          <i style="width:${(1 - t.play.recoveryRate) * 100}%;background:#2a3740"></i>
        </div>
      </div>
    </div>`
    : '';

  const adjs = claim.adjustments && claim.adjustments.length
    ? `<div class="dsec">
      <h3>835 remittance adjustments</h3>
      <table class="adjtable">
        <thead><tr><th>CARC</th><th>RARC</th><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>${claim.adjustments
          .map((a) => `<tr><td style="color:${a.carc.startsWith('PR-') ? 'var(--blue)' : a.carc === 'CO-45' ? 'var(--ink-3)' : 'var(--rose)'}">${a.carc}</td><td>${a.rarc || '—'}</td><td>${a.note}</td><td class="num">${fmt(a.amount)}</td></tr>`)
          .join('')}
        <tr><td colspan="3" style="color:var(--ink-3)">Paid</td><td class="num" style="color:var(--teal)">${fmt(claim.paid || 0)}</td></tr>
        </tbody>
      </table>
    </div>`
    : '';

  const findings = (claim.scrubFindings || []).length
    ? `<div class="dsec"><h3>Pre-submission scrub</h3>${claim.scrubFindings
        .map((f) => `<div class="finding"><span class="sev ${f.severity}">${f.severity}</span><span><span class="mono" style="color:var(--ink-3)">${f.code}</span> ${f.msg}</span></div>`)
        .join('')}</div>`
    : '';

  const tl = `<div class="dsec">
    <h3>Event log <span style="color:var(--ink-3);font-weight:400;text-transform:none;letter-spacing:0">— state is a fold over these ${claim.events.length} events</span></h3>
    <div class="tl">${claim.events
      .map((e) => {
        let extra = '';
        if (e.type === 'ClaimSubmitted') extra = `control #${e.payload.controlNumber} · 837P freq ${e.payload.frequencyCode}`;
        if (e.type === 'RemittanceReceived') extra = `trace ${e.payload.traceNumber} · paid ${fmt(e.payload.paid)}`;
        if (e.type === 'ClaimScrubbed') extra = `${e.payload.findings.length} finding(s)`;
        if (e.type === 'AppealFiled') extra = e.payload.basis;
        if (e.type === 'ClaimWrittenOff') extra = e.payload.reason;
        return `<div class="ev k-${e.type}"><div class="et">${e.type}</div><div class="ed">seq ${e.seq} · ${e.at}</div>${extra ? `<div class="ex">${extra}</div>` : ''}</div>`;
      })
      .join('')}</div>
  </div>`;

  $('#detail').innerHTML = head + play + adjs + findings + tl;

  const auto = $('#btnAuto');
  if (auto) auto.addEventListener('click', () => remediate(claim.id));
  const appeal = $('#btnAppeal');
  if (appeal) appeal.addEventListener('click', () => fileAppeal(claim.id));
}

// ---------------------------------------------------------------- actions
function remediate(id) {
  const i = claims.findIndex((c) => c.id === id);
  const claim = claims[i];
  const t = triageScore(claim, TODAY);
  if (!t || t.lane !== 'auto') return;

  // Auto lane: rebuild and resubmit as a corrected claim (837P frequency code 7),
  // or post the contractual/patient adjustment where there's no appeal path.
  if (t.carc === 'CO-45') {
    claims[i] = apply(claim, { seq: nextSeq(), type: 'ClaimWrittenOff', at: TODAY, payload: { reason: 'CO-45 contractual adjustment posted' } });
  } else if (t.carc.startsWith('PR-')) {
    claims[i] = apply(claim, { seq: nextSeq(), type: 'BalanceTransferred', at: TODAY, payload: { amount: t.balance } });
  } else if (t.carc === 'CO-18') {
    claims[i] = apply(claim, { seq: nextSeq(), type: 'ClaimWrittenOff', at: TODAY, payload: { reason: 'CO-18 verified duplicate — no resubmission' } });
  } else {
    let c = apply(claim, { seq: nextSeq(), type: 'ClaimScrubbed', at: TODAY, payload: { findings: [{ severity: 'info', code: 'AUTO-FIX', msg: t.play.action }] } });
    c = apply(c, { seq: nextSeq(), type: 'ClaimSubmitted', at: TODAY, payload: { controlNumber: `837C${Math.floor(Math.random() * 900000 + 100000)}`, frequencyCode: '7' } });
    claims[i] = c;
  }
  render(true);
}

function fileAppeal(id) {
  const i = claims.findIndex((c) => c.id === id);
  const t = triageScore(claims[i], TODAY);
  claims[i] = apply(claims[i], { seq: nextSeq(), type: 'AppealFiled', at: TODAY, payload: { basis: t.play.action } });
  render(true);
}

function runBatch() {
  const auto = triaged().filter((x) => x.t.lane === 'auto');
  auto.forEach((x) => remediate(x.claim.id));
  const recovered = auto.reduce((s, x) => s + x.t.expected, 0);
  $('#batchNote').innerHTML = `Cleared <strong>${auto.length}</strong> denials through the deterministic lane · <strong style="color:var(--teal)">${fmt(recovered)}</strong> expected recovery, zero human touches.`;
}

// ---------------------------------------------------------------- filters
function renderFilters() {
  const payerOpts = Object.entries(PAYERS).map(([k, v]) => `<option value="${k}" ${filters.payer === k ? 'selected' : ''}>${v.name}</option>`).join('');
  const carcs = [...new Set(claims.filter((c) => c.state === 'denied').map((c) => { const t = triageScore(c, TODAY); return t && t.carc; }).filter(Boolean))].sort();
  const carcOpts = carcs.map((c) => `<option value="${c}" ${filters.carc === c ? 'selected' : ''}>${c} — ${DENIAL_PLAYBOOK[c].category}</option>`).join('');

  $('#controls').innerHTML = `
    <input type="search" id="fq" placeholder="Search claim, patient, provider…" value="${filters.q}">
    <select id="fpayer"><option value="">All payers</option>${payerOpts}</select>
    <select id="fcarc"><option value="">All denial reasons</option>${carcOpts}</select>
    <select id="flane">
      <option value="">Both lanes</option>
      <option value="auto" ${filters.lane === 'auto' ? 'selected' : ''}>Deterministic (auto)</option>
      <option value="human" ${filters.lane === 'human' ? 'selected' : ''}>Needs a human</option>
    </select>
    <button class="primary" id="btnBatch">Clear the auto lane</button>`;

  $('#fq').addEventListener('input', (e) => { filters.q = e.target.value; renderQueue(); });
  $('#fpayer').addEventListener('change', (e) => { filters.payer = e.target.value; renderQueue(); });
  $('#fcarc').addEventListener('change', (e) => { filters.carc = e.target.value; renderQueue(); });
  $('#flane').addEventListener('change', (e) => { filters.lane = e.target.value; renderQueue(); });
  $('#btnBatch').addEventListener('click', runBatch);
}

// ---------------------------------------------------------------- mix chart
function renderMix() {
  const rows = claims.filter((c) => c.state === 'denied').map((c) => triageScore(c, TODAY)).filter(Boolean);
  const by = {};
  rows.forEach((t) => {
    by[t.carc] = by[t.carc] || { n: 0, bal: 0, exp: 0, lane: t.lane, cat: t.play.category, label: t.play.label };
    by[t.carc].n++; by[t.carc].bal += t.balance; by[t.carc].exp += t.expected;
  });
  const list = Object.entries(by).sort((a, b) => b[1].bal - a[1].bal);
  const max = Math.max(...list.map(([, v]) => v.bal), 1);

  $('#mix').innerHTML = list
    .map(([carc, v]) => `<div style="padding:9px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;gap:9px;align-items:baseline;font-size:12.5px">
        <span class="mono" style="font-weight:650;color:${v.lane === 'auto' ? 'var(--teal)' : 'var(--amber)'}">${carc}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)">${v.label}</span>
        <span class="mono" style="color:var(--ink-3)">${v.n}</span>
        <span class="mono" style="width:74px;text-align:right">${fmtK(v.bal)}</span>
      </div>
      <div class="bar"><i style="width:${(v.exp / max) * 100}%;background:var(--teal)"></i><i style="width:${((v.bal - v.exp) / max) * 100}%;background:#3a2229"></i></div>
    </div>`)
    .join('');
}

// ---------------------------------------------------------------- render
function render(flash = false) {
  renderMetrics();
  renderFilters();
  renderQueue();
  renderDetail();
  renderMix();
  if (flash) {
    const m = $('#metrics');
    m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash');
  }
}

$('#today').textContent = TODAY;
render();

// Expose the model for console poking — a reviewer opening devtools should be
// able to replay a claim from its log and land on the same state.
window.ledger = { claims, replay, triageScore, metrics, TODAY };
