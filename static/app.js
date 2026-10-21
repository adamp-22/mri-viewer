/* Local DICOM viewer front-end.
 *
 * The server hands us raw *stored* 16-bit pixels; everything visual — the
 * modality rescale, the VOI window, zoom, pan and measurement — happens here,
 * so the full 12 bits of the acquisition stay available while you drag the
 * window around.
 */
'use strict';

const $ = (s) => document.querySelector(s);

const S = {
  study: null,
  series: null, si: -1, idx: 0,
  wc: 0, ww: 1, preset: 'scanner',
  invert: false, smooth: true,
  zoom: 1, panx: 0, pany: 0,
  measuring: false, lines: [], pending: null,
  drag: null, probe: null,
  cache: new Map(), inflight: new Map(), gen: 0,
  playing: false, timer: null,
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  grounding: null,
  activeFindingId: null, activeEvidenceIndex: 0,
  findingFilter: 'findings', labels: true, groundingOpen: false,
};

const CACHE_MAX = 90;
const cv = $('#cv');
const ctx = cv.getContext('2d', { alpha: false });
const off = document.createElement('canvas');
const offctx = off.getContext('2d', { alpha: false });

/* ---------------------------------------------------------------- loading */

async function boot() {
  const [studyResult, groundingResult] = await Promise.all([
    fetch('/api/study'),
    fetch('/api/grounding').then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!studyResult.ok) { document.body.textContent = 'Could not load study: ' + studyResult.status; return; }
  S.study = await studyResult.json();
  S.grounding = groundingResult;
  renderStudyHeader();
  renderSeriesList();
  if (!S.study.hasReport) $('#btn-report').disabled = true;

  // Localisers are rarely what you want to look at first.
  const first = S.study.series.findIndex((s) => !/survey|scout|localis/i.test(s.desc));
  selectSeries(first >= 0 ? first : 0);

  if (S.grounding && Array.isArray(S.grounding.findings) && S.grounding.findings.length) {
    initGrounding();
  } else {
    const labels = document.querySelector('[data-act="annotations"]');
    if (labels) labels.disabled = true;
  }
}

function renderStudyHeader() {
  const p = S.study.patient || {};
  $('#pname').textContent = p.name || 'Unknown patient';
  const bits = [];
  if (p.id) bits.push('ID ' + p.id);
  if (p.sex) bits.push(p.sex);
  const parts = [];
  if (bits.length) parts.push(bits.join(' · '));
  if (p.studyDesc) parts.push(p.studyDesc);
  const when = fmtDate(p.studyDate) + (p.studyTime ? ' ' + fmtTime(p.studyTime) : '');
  if (when.trim()) parts.push(when);
  const dev = [p.manufacturer, p.fieldStrength ? p.fieldStrength + ' T' : ''].filter(Boolean).join(' · ');
  if (dev) parts.push(dev);
  if (p.institution) parts.push(p.institution);
  $('#pmeta').innerHTML = parts.map((t) => '<span>' + esc(t) + '</span>').join('');
}

function renderSeriesList() {
  const ul = $('#serieslist');
  ul.innerHTML = '';
  S.study.series.forEach((s, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    const linked = S.grounding
      ? S.grounding.findings.filter((f) => (f.evidence || []).some((e) => +e.series === +s.number)).length
      : 0;
    const meta = [s.count + ' img', s.orientation, s.thickness ? s.thickness + ' mm' : '',
      linked ? linked + ' report links' : '']
      .filter(Boolean).join(' · ');
    li.innerHTML = '<div class="k">' + (i < 9 ? i + 1 : '·') + '</div>' +
      '<div class="b"><div class="d" title="' + esc(s.desc) + '">' + esc(s.desc) + '</div>' +
      '<div class="m">' + esc(meta) + '</div></div>';
    li.onclick = () => selectSeries(i);
    ul.appendChild(li);
  });
}

function selectSeries(i, targetIndex = null) {
  if (i < 0 || i >= S.study.series.length) return;
  stopCine();
  S.si = i;
  S.series = S.study.series[i];
  S.idx = targetIndex == null
    ? Math.floor(S.series.count / 2)
    : Math.max(0, Math.min(S.series.count - 1, targetIndex));
  S.lines = []; S.pending = null;
  S.gen++;
  S.cache.clear(); S.inflight.clear();
  applyPreset('scanner');
  buildPresets();

  document.querySelectorAll('#serieslist li').forEach((li, k) => li.classList.toggle('sel', k === i));
  const sl = $('#slider');
  sl.max = String(S.series.count - 1);
  sl.value = String(S.idx);

  off.width = S.series.cols; off.height = S.series.rows;
  resize(true);
  fetch('/api/prefetch?series=' + encodeURIComponent(S.series.uid) + '&i=' + S.idx).catch(() => {});
  show(S.idx);
}

/* ---------------------------------------------------------------- pixels */

function keyOf(i) { return S.series.uid + ':' + i; }

function getSlice(i) {
  if (i < 0 || i >= S.series.count) return Promise.resolve(null);
  const k = keyOf(i);
  const hit = S.cache.get(k);
  if (hit) { S.cache.delete(k); S.cache.set(k, hit); return Promise.resolve(hit); }
  const busy = S.inflight.get(k);
  if (busy) return busy;

  const gen = S.gen;
  const p = fetch('/api/slice?series=' + encodeURIComponent(S.series.uid) + '&i=' + i)
    .then((r) => { if (!r.ok) throw new Error('slice ' + i + ': ' + r.status); return r.arrayBuffer(); })
    .then((buf) => {
      const arr = new Uint16Array(buf);
      S.inflight.delete(k);
      if (gen !== S.gen) return arr;            // series changed underneath us
      S.cache.set(k, arr);
      while (S.cache.size > CACHE_MAX) S.cache.delete(S.cache.keys().next().value);
      return arr;
    })
    .catch((e) => { S.inflight.delete(k); console.warn(e); return null; });

  S.inflight.set(k, p);
  return p;
}

function prefetchAround(i) {
  const want = [];
  for (let d = 1; d <= 6; d++) { want.push(i + d); want.push(i - d); }
  for (const j of want) {
    if (j < 0 || j >= S.series.count) continue;
    if (S.cache.has(keyOf(j)) || S.inflight.has(keyOf(j))) continue;
    if (S.inflight.size >= 5) break;
    getSlice(j);
  }
}

let showToken = 0;
async function show(i) {
  i = Math.max(0, Math.min(S.series.count - 1, i));
  S.idx = i;
  $('#slider').value = String(i);
  const token = ++showToken;
  const gen = S.gen;

  const cached = S.cache.get(keyOf(i));
  if (!cached) {
    const t = setTimeout(() => { if (token === showToken) $('#loading').classList.add('on'); }, 90);
    const arr = await getSlice(i);
    clearTimeout(t);
    if (token !== showToken || gen !== S.gen) return;
    $('#loading').classList.remove('on');
    if (!arr) return;
  }
  if (S.preset === 'auto') autoWindow();
  paint();
  prefetchAround(i);
}

/* ------------------------------------------------------------- rendering */

function lutFor(slice) {
  // DICOM linear VOI LUT over modality-rescaled values.
  const bits = S.series.bitsStored || 16;
  const n = 1 << Math.min(bits, 16);
  const lut = new Uint8ClampedArray(n);
  const m = slice.slope, b = slice.intercept;
  const lo = S.wc - 0.5 - (S.ww - 1) / 2, span = Math.max(S.ww - 1, 1e-6);
  for (let v = 0; v < n; v++) {
    let y = ((v * m + b - lo) / span) * 255;
    lut[v] = S.invert ? 255 - y : y;
  }
  return lut;
}

function paint() {
  const arr = S.cache.get(keyOf(S.idx));
  if (!arr) return;
  const sl = S.series.slices[S.idx];
  const lut = lutFor(sl), n = lut.length - 1;
  const img = offctx.createImageData(S.series.cols, S.series.rows);
  const d = img.data;
  for (let p = 0, q = 0; p < arr.length; p++, q += 4) {
    const g = lut[arr[p] > n ? n : arr[p]];
    d[q] = g; d[q + 1] = g; d[q + 2] = g; d[q + 3] = 255;
  }
  offctx.putImageData(img, 0, 0);
  draw();
  overlays();
}

function draw() {
  const dpr = S.dpr, W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!S.series) return;

  ctx.imageSmoothingEnabled = S.smooth;
  ctx.imageSmoothingQuality = 'high';
  const s = S.zoom * dpr;
  ctx.translate(W / 2 + S.panx * dpr, H / 2 + S.pany * dpr);
  ctx.scale(s, s);
  ctx.drawImage(off, -S.series.cols / 2, -S.series.rows / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGroundingAnnotation();
  drawMeasurements();
}

function drawMeasurements() {
  const all = S.pending ? S.lines.concat([S.pending]) : S.lines;
  if (!all.length) return;
  ctx.save();
  ctx.lineWidth = 1.4 * S.dpr;
  ctx.strokeStyle = '#9fe08a';
  ctx.fillStyle = '#9fe08a';
  ctx.font = (11.5 * S.dpr) + 'px ui-monospace, Menlo, monospace';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 3 * S.dpr;
  for (const L of all) {
    const a = imgToDev(L.x1, L.y1), b = imgToDev(L.x2, L.y2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const p of [a, b]) {
      ctx.beginPath(); ctx.moveTo(p.x - 4 * S.dpr, p.y); ctx.lineTo(p.x + 4 * S.dpr, p.y);
      ctx.moveTo(p.x, p.y - 4 * S.dpr); ctx.lineTo(p.x, p.y + 4 * S.dpr); ctx.stroke();
    }
    ctx.fillText(mmLabel(L), (a.x + b.x) / 2 + 8 * S.dpr, (a.y + b.y) / 2 - 6 * S.dpr);
  }
  ctx.restore();
}

function mmLabel(L) {
  const sp = S.series.spacing;
  const dx = L.x2 - L.x1, dy = L.y2 - L.y1;
  if (!sp) return Math.hypot(dx, dy).toFixed(1) + ' px';
  return Math.hypot(dx * sp[1], dy * sp[0]).toFixed(1) + ' mm';
}

function overlays() {
  const s = S.series, sl = s.slices[S.idx], p = S.study.patient || {};
  $('#ov-tl').innerHTML =
    hi(p.name || '') + '\n' +
    lo([p.id ? 'ID ' + p.id : '', p.sex, fmtDate(p.studyDate)].filter(Boolean).join('  ')) + '\n' +
    lo(esc(p.institution || ''));

  const seq = [];
  if (s.tr) seq.push('TR ' + round(s.tr));
  if (s.te != null) seq.push('TE ' + round(s.te));
  if (s.thickness) seq.push('THK ' + round(s.thickness) + 'mm');
  $('#ov-tr').innerHTML =
    hi(esc(s.desc)) + '\n' +
    lo('Series ' + s.number + '  ·  ' + s.orientation) + '\n' +
    lo(seq.join('  '));

  const fov = s.spacing ? (s.cols * s.spacing[1] / 10).toFixed(1) + ' cm FOV' : '';
  $('#ov-bl').innerHTML =
    hi('Im ' + (S.idx + 1) + ' / ' + s.count) + '\n' +
    lo(s.cols + '×' + s.rows + (fov ? '  ·  ' + fov : '')) + '\n' +
    lo(sl.loc != null ? 'Loc ' + sl.loc.toFixed(1) + ' mm' : '');

  const probe = S.probe
    ? 'px ' + S.probe.x + ',' + S.probe.y + '  =  ' + S.probe.v
    : '';
  $('#ov-br').innerHTML =
    hi('WL ' + Math.round(S.wc) + '  WW ' + Math.round(S.ww)) + '\n' +
    lo('zoom ' + (S.zoom * 100).toFixed(0) + '%' + (S.invert ? '  ·  inverted' : '')) + '\n' +
    lo(probe);

  $('#slicelabel').textContent = (S.idx + 1) + ' / ' + s.count;
  updateFindingBanner();
}

const hi = (t) => '<span class="hi">' + t + '</span>';
const lo = (t) => '<span class="lo">' + t + '</span>';

/* ------------------------------------------------------ report grounding */

function initGrounding() {
  $('#btn-grounding').hidden = false;
  $('#btn-original-report').hidden = !S.study.hasFindingsReportImage;

  const c = S.grounding.coverage || {};
  const total = c.findings_total == null ? S.grounding.findings.length : c.findings_total;
  $('#grounding-summary').textContent = total + ' atomic report statements · ' +
    (c.confirmed || 0) + ' pixel-supported · ' +
    (c.located_not_verified || 0) + ' reported-location only';

  const reportFindings = S.grounding.findings.filter((f) => !f.is_normal).length;
  const filters = document.querySelectorAll('.finding-filters button');
  filters.forEach((b) => {
    b.textContent = b.dataset.filter === 'findings'
      ? 'Report findings (' + reportFindings + ')'
      : 'All statements (' + total + ')';
    b.onclick = () => {
      S.findingFilter = b.dataset.filter;
      filters.forEach((x) => {
        const on = x.dataset.filter === S.findingFilter;
        x.classList.toggle('on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      renderFindingList();
    };
  });

  setGroundingOpen(true);
  const params = new URLSearchParams(window.location.search);
  const requested = S.grounding.findings.find((f) => f.id === params.get('finding'));
  const first = requested || S.grounding.findings.find((f) => f.id === 'f5') ||
    S.grounding.findings.find((f) => !f.is_normal) || S.grounding.findings[0];
  const requestedEvidence = Math.max(0, (parseInt(params.get('evidence'), 10) || 1) - 1);
  selectFinding(first.id, requestedEvidence, true);
}

function setGroundingOpen(open) {
  if (!S.grounding) return;
  S.groundingOpen = !!open;
  $('#grounding-panel').hidden = !S.groundingOpen;
  $('#btn-grounding').classList.toggle('on', S.groundingOpen);
  requestAnimationFrame(() => resize(true));
}

function findingById(id) {
  return S.grounding && S.grounding.findings.find((f) => f.id === id);
}

function visibleFindings() {
  if (!S.grounding) return [];
  return S.findingFilter === 'all'
    ? S.grounding.findings
    : S.grounding.findings.filter((f) => !f.is_normal);
}

function verificationLabel(value, long = false) {
  if (value === 'confirmed') return long ? 'Pixel-supported on this rendering' : 'pixel-supported';
  if (value === 'not_located') return long ? 'Could not locate the reported structure/finding' : 'not located';
  return long ? 'Reported location—not independently verified' : 'location only';
}

function certaintyLabel(value) {
  if (value === 'cannot_be_excluded') return 'cannot be excluded';
  if (value === 'suspected') return 'suspected / probably';
  if (value === 'negative') return 'negative statement';
  return '';
}

function rangeText(e) {
  if (!e || !Array.isArray(e.slices) || !e.slices.length) return 'slice not specified';
  const a = e.slices[0], b = e.slices[e.slices.length - 1];
  return a === b ? 'slice ' + a : 'slices ' + a + '–' + b;
}

function renderFindingList() {
  const list = $('#finding-list');
  list.innerHTML = '';
  for (const f of visibleFindings()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'finding-card ' + f.verification +
      (f.id === S.activeFindingId ? ' selected' : '');
    const certainty = certaintyLabel(f.certainty);
    card.innerHTML =
      '<span class="card-top"><span class="fid">' + esc(f.id) + '</span>' +
      '<span class="structure">' + esc(f.structure) + '</span></span>' +
      '<span class="card-text">' + esc(f.translation) + '</span>' +
      '<span class="badges"><span class="badge ' + esc(f.verification) + '">' +
      esc(verificationLabel(f.verification)) + '</span>' +
      (certainty ? '<span class="badge ' + esc(f.certainty) + '">' + esc(certainty) + '</span>' : '') +
      '</span>';
    card.onclick = () => selectFinding(f.id, 0, true);
    list.appendChild(card);
  }
  const selected = list.querySelector('.finding-card.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function renderFindingDetail() {
  const detail = $('#finding-detail');
  const f = findingById(S.activeFindingId);
  if (!f) { detail.innerHTML = ''; return; }
  const certainty = certaintyLabel(f.certainty);
  const unverifiable = f.certainty === 'suspected' && Array.isArray(S.grounding.not_verifiable)
    ? S.grounding.not_verifiable.join(' ')
    : '';

  detail.innerHTML =
    '<div class="detail-title"><h3>' + esc(f.id.toUpperCase() + ' · ' + f.structure) + '</h3></div>' +
    '<div class="badges"><span class="badge ' + esc(f.verification) + '">' +
      esc(verificationLabel(f.verification)) + '</span>' +
      (certainty ? '<span class="badge ' + esc(f.certainty) + '">' + esc(certainty) + '</span>' : '') +
    '</div>' +
    '<div class="detail-block"><div class="detail-label">Radiologist’s statement · English</div>' +
      '<p>' + esc(f.translation) + '</p></div>' +
    '<div class="detail-block"><div class="detail-label">Original Hungarian</div>' +
      '<p class="original" lang="hu">' + esc(f.original) + '</p></div>' +
    '<div class="detail-block"><div class="detail-label">Plain language</div>' +
      '<p>' + esc(f.plain_language) + '</p></div>' +
    '<div class="detail-block verification-note ' + esc(f.verification) + '">' +
      '<div class="detail-label">Grounding verification</div><p>' + esc(f.verification_note) + '</p></div>' +
    (unverifiable ? '<div class="detail-block"><div class="detail-label">Not verifiable here</div><p>' + esc(unverifiable) + '</p></div>' : '') +
    '<div class="detail-block"><div class="detail-label">Cited image ranges</div><div class="evidence-list"></div></div>';

  const evidenceList = detail.querySelector('.evidence-list');
  (f.evidence || []).forEach((e, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'evidence-chip' + (i === S.activeEvidenceIndex ? ' active' : '');
    chip.innerHTML = '<strong>Series ' + esc(e.series) + ' · ' + esc(rangeText(e)) +
      ' · best ' + esc(e.best_slice) + '</strong>' +
      '<span>' + esc(e.series_desc) + '</span>' +
      '<span>' + esc(e.landmark) + '</span>' +
      '<span>Why: ' + esc(e.why_this_series) + '</span>';
    chip.onclick = () => selectFinding(f.id, i, true);
    evidenceList.appendChild(chip);
  });
}

function selectFinding(id, evidenceIndex = 0, jump = true) {
  const f = findingById(id);
  if (!f) return;
  S.activeFindingId = id;
  S.activeEvidenceIndex = Math.max(0, Math.min((f.evidence || []).length - 1, evidenceIndex));
  setGroundingOpen(true);
  renderFindingList();
  renderFindingDetail();

  if (!jump || !f.evidence || !f.evidence.length) {
    draw(); overlays(); return;
  }
  const e = f.evidence[S.activeEvidenceIndex];
  const si = S.study.series.findIndex((s) => +s.number === +e.series);
  if (si < 0) { draw(); overlays(); return; }
  selectSeries(si, Math.max(0, +e.best_slice - 1));
}

function currentGroundingContext() {
  if (!S.labels || !S.grounding || !S.series || !S.activeFindingId) return null;
  const f = findingById(S.activeFindingId);
  if (!f) return null;
  const slice = S.idx + 1;
  const evidenceIndex = (f.evidence || []).findIndex((e) => {
    if (+e.series !== +S.series.number || !Array.isArray(e.slices)) return false;
    const a = +e.slices[0], b = +e.slices[e.slices.length - 1];
    return slice >= Math.min(a, b) && slice <= Math.max(a, b);
  });
  if (evidenceIndex < 0) return null;
  const e = f.evidence[evidenceIndex];
  const annotations = S.grounding.viewer_annotations && S.grounding.viewer_annotations.annotations;
  const annotation = annotations && (annotations[f.id] || []).find((a) => +a.series === +S.series.number);
  return { f, e, evidenceIndex, annotation };
}

function drawGroundingAnnotation() {
  const item = currentGroundingContext();
  if (!item || !item.annotation || !Array.isArray(item.annotation.roi)) return;
  const { f } = item;
  const [nx, ny, nw, nh] = item.annotation.roi;
  const a = imgToDev(nx * S.series.cols, ny * S.series.rows);
  const b = imgToDev((nx + nw) * S.series.cols, (ny + nh) * S.series.rows);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  const rgb = f.verification === 'confirmed' ? [84, 217, 139]
    : f.verification === 'not_located' ? [255, 107, 107] : [240, 180, 77];
  const color = 'rgb(' + rgb.join(',') + ')';
  const dpr = S.dpr;

  ctx.save();
  ctx.lineWidth = 2.2 * dpr;
  ctx.strokeStyle = color;
  ctx.fillStyle = 'rgba(' + rgb.join(',') + ',0.10)';
  if (f.verification !== 'confirmed') ctx.setLineDash([8 * dpr, 5 * dpr]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  const raw = f.id.toUpperCase() + ' · ' + f.structure;
  const label = raw.length > 48 ? raw.slice(0, 47) + '…' : raw;
  ctx.font = '600 ' + (11 * dpr) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
  const padX = 7 * dpr, padY = 5 * dpr;
  const tw = Math.min(ctx.measureText(label).width + padX * 2, cv.width - 12 * dpr);
  const th = 22 * dpr;
  const tx = Math.max(6 * dpr, Math.min(x, cv.width - tw - 6 * dpr));
  const ty = Math.max(6 * dpr, y - th - 4 * dpr);
  ctx.fillStyle = 'rgba(10,14,18,0.92)';
  ctx.fillRect(tx, ty, tw, th);
  ctx.strokeStyle = color;
  ctx.strokeRect(tx, ty, tw, th);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tx + padX, ty + th / 2, tw - padX * 2);
  ctx.restore();
}

function updateFindingBanner() {
  const banner = $('#finding-banner');
  const item = currentGroundingContext();
  if (!item) { banner.hidden = true; return; }
  const { f, e } = item;
  const hedge = f.certainty === 'suspected' ? 'Report wording: suspected / probably · '
    : f.certainty === 'cannot_be_excluded' ? 'Report wording: cannot be excluded · ' : '';
  banner.className = f.verification;
  banner.innerHTML = '<div class="banner-title">' + esc(f.id.toUpperCase() + ' · ' + f.structure) + '</div>' +
    '<div class="banner-status">' + esc(hedge + verificationLabel(f.verification, true)) +
    '<span class="banner-slice">Series ' + esc(e.series) + ' · ' + esc(rangeText(e)) + '</span></div>';
  banner.hidden = false;
}

/* ------------------------------------------------------------- windowing */

function buildPresets() {
  const box = $('#presets');
  box.innerHTML = '';
  [['scanner', 'Scanner'], ['auto', 'Auto'], ['full', 'Full range']].forEach(([id, label]) => {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.preset = id;
    b.className = S.preset === id ? 'on' : '';
    b.onclick = () => { applyPreset(id); paint(); };
    box.appendChild(b);
  });
}

function markPreset(id) {
  S.preset = id;
  document.querySelectorAll('#presets button')
    .forEach((b) => b.classList.toggle('on', b.dataset.preset === id));
}

function applyPreset(id) {
  const s = S.series;
  if (id === 'scanner' && s.ww) { S.wc = s.wc; S.ww = s.ww; markPreset('scanner'); return; }
  if (id === 'full') {
    const sl = s.slices[S.idx], top = ((1 << (s.bitsStored || 12)) - 1) * sl.slope + sl.intercept;
    S.wc = top / 2; S.ww = Math.max(top, 1); markPreset('full'); return;
  }
  if (id === 'auto') { markPreset('auto'); autoWindow(); return; }
  S.wc = s.wc || 500; S.ww = s.ww || 1000; markPreset('scanner');
}

function autoWindow() {
  const arr = S.cache.get(keyOf(S.idx));
  if (!arr) return;
  const sl = S.series.slices[S.idx];
  const bins = 4096, hist = new Uint32Array(bins);
  let max = 0;
  for (let i = 0; i < arr.length; i += 3) { if (arr[i] > max) max = arr[i]; }
  if (max < 1) max = 1;
  const scale = (bins - 1) / max;
  let total = 0;
  for (let i = 0; i < arr.length; i += 3) {
    const v = arr[i];
    if (v === 0) continue;                       // background dominates otherwise
    hist[(v * scale) | 0]++; total++;
  }
  if (!total) return;
  const pick = (frac) => {
    let acc = 0, target = total * frac;
    for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= target) return b / scale; }
    return max;
  };
  const lo0 = pick(0.02) * sl.slope + sl.intercept;
  const hi0 = pick(0.995) * sl.slope + sl.intercept;
  S.ww = Math.max(hi0 - lo0, 1);
  S.wc = lo0 + S.ww / 2;
}

/* ------------------------------------------------------ geometry helpers */

function resize(refit) {
  const st = $('#stage');
  cv.width = Math.max(1, Math.round(st.clientWidth * S.dpr));
  cv.height = Math.max(1, Math.round(st.clientHeight * S.dpr));
  if (refit) fit(); else draw();
}

function fit() {
  if (!S.series) return;
  const st = $('#stage');
  S.zoom = Math.min(st.clientWidth / S.series.cols, st.clientHeight / S.series.rows) * 0.98;
  S.panx = 0; S.pany = 0;
  draw(); overlays();
}

function imgToDev(x, y) {
  return {
    x: cv.width / 2 + S.panx * S.dpr + (x - S.series.cols / 2) * S.zoom * S.dpr,
    y: cv.height / 2 + S.pany * S.dpr + (y - S.series.rows / 2) * S.zoom * S.dpr,
  };
}

function evToImg(e) {
  const r = cv.getBoundingClientRect();
  const dx = (e.clientX - r.left) * S.dpr, dy = (e.clientY - r.top) * S.dpr;
  return {
    x: (dx - cv.width / 2 - S.panx * S.dpr) / (S.zoom * S.dpr) + S.series.cols / 2,
    y: (dy - cv.height / 2 - S.pany * S.dpr) / (S.zoom * S.dpr) + S.series.rows / 2,
  };
}

function zoomAt(e, factor) {
  const before = evToImg(e);
  S.zoom = Math.max(0.05, Math.min(40, S.zoom * factor));
  const after = evToImg(e);
  S.panx += (after.x - before.x) * S.zoom;
  S.pany += (after.y - before.y) * S.zoom;
  draw(); overlays();
}

/* ------------------------------------------------------------ interaction */

cv.addEventListener('contextmenu', (e) => e.preventDefault());

cv.addEventListener('mousedown', (e) => {
  if (!S.series) return;
  e.preventDefault();
  const pan = e.button === 1 || e.button === 2 || e.shiftKey;
  const zoom = e.metaKey || e.ctrlKey;
  if (S.measuring && e.button === 0 && !pan && !zoom) {
    const p = evToImg(e);
    S.pending = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    S.drag = { mode: 'measure' };
  } else {
    S.drag = {
      mode: pan ? 'pan' : zoom ? 'zoom' : 'wl',
      x: e.clientX, y: e.clientY,
      wc: S.wc, ww: S.ww, panx: S.panx, pany: S.pany, zoom: S.zoom, ev: e,
    };
  }
  cv.classList.toggle('panning', S.drag.mode === 'pan');
});

window.addEventListener('mousemove', (e) => {
  if (S.series && !S.drag) {
    const p = evToImg(e);
    const arr = S.cache.get(keyOf(S.idx));
    if (arr && p.x >= 0 && p.y >= 0 && p.x < S.series.cols && p.y < S.series.rows) {
      const sl = S.series.slices[S.idx];
      const raw = arr[(p.y | 0) * S.series.cols + (p.x | 0)];
      S.probe = { x: p.x | 0, y: p.y | 0, v: round(raw * sl.slope + sl.intercept) };
    } else S.probe = null;
    overlays();
    return;
  }
  if (!S.drag) return;
  const d = S.drag;

  if (d.mode === 'measure') {
    const p = evToImg(e);
    S.pending.x2 = p.x; S.pending.y2 = p.y;
    draw();
    return;
  }
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (d.mode === 'pan') {
    S.panx = d.panx + dx; S.pany = d.pany + dy;
    draw(); overlays();
  } else if (d.mode === 'zoom') {
    S.zoom = Math.max(0.05, Math.min(40, d.zoom * Math.exp(-dy / 180)));
    draw(); overlays();
  } else {
    const k = Math.max(d.ww / 180, 0.5);
    S.ww = Math.max(1, d.ww + dx * k);
    S.wc = d.wc + dy * k;
    markPreset('manual');
    paint();
  }
});

window.addEventListener('mouseup', () => {
  if (S.drag && S.drag.mode === 'measure' && S.pending) {
    const L = S.pending;
    if (Math.hypot(L.x2 - L.x1, L.y2 - L.y1) > 2) S.lines.push(L);
    S.pending = null;
    draw();
  }
  S.drag = null;
  cv.classList.remove('panning');
});

cv.addEventListener('wheel', (e) => {
  if (!S.series) return;
  e.preventDefault();
  if (e.altKey || e.metaKey || e.ctrlKey) {
    zoomAt(e, Math.exp(-e.deltaY / 300));
  } else {
    stopCine();
    show(S.idx + (e.deltaY > 0 ? 1 : -1));
  }
}, { passive: false });

cv.addEventListener('dblclick', () => fit());

$('#slider').addEventListener('input', (e) => { stopCine(); show(+e.target.value); });

$('#toolbar').addEventListener('click', (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  act === 'annotations' ? toggleAnnotations()
    : act === 'invert' ? toggleInvert()
    : act === 'smooth' ? toggleSmooth()
    : act === 'measure' ? toggleMeasure()
    : act === 'clear' ? clearLines()
    : act === 'fit' ? fit()
    : resetAll();
});

$('#btn-play').onclick = () => (S.playing ? stopCine() : startCine());
$('#btn-report').onclick = () => window.open('/report.pdf', '_blank');
$('#btn-grounding').onclick = () => setGroundingOpen(!S.groundingOpen);
$('#btn-close-grounding').onclick = () => setGroundingOpen(false);
$('#btn-original-report').onclick = () => window.open('/grounding/report.png', '_blank');
$('#btn-help').onclick = () => $('#help').hidden = false;
$('#btn-closehelp').onclick = () => $('#help').hidden = true;
$('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').hidden = true; };

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === 'Escape') {
    const helpWasOpen = !$('#help').hidden;
    $('#help').hidden = true;
    if (!helpWasOpen && S.groundingOpen) setGroundingOpen(false);
    S.pending = null; draw(); return;
  }
  if (!S.series) return;
  if (k >= '1' && k <= '9') { selectSeries(+k - 1); return; }
  const step = (n) => { stopCine(); show(S.idx + n); };
  switch (k) {
    case 'ArrowDown': case 'ArrowRight': e.preventDefault(); step(1); break;
    case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); step(-1); break;
    case 'PageDown': e.preventDefault(); step(10); break;
    case 'PageUp': e.preventDefault(); step(-10); break;
    case 'Home': e.preventDefault(); stopCine(); show(0); break;
    case 'End': e.preventDefault(); stopCine(); show(S.series.count - 1); break;
    case ' ': e.preventDefault(); S.playing ? stopCine() : startCine(); break;
    case 'i': toggleInvert(); break;
    case 's': toggleSmooth(); break;
    case 'm': toggleMeasure(); break;
    case 'c': clearLines(); break;
    case 'f': fit(); break;
    case 'r': resetAll(); break;
    case 'a': applyPreset('auto'); paint(); break;
    case 'l': toggleAnnotations(); break;
    case 'g': if (S.grounding) setGroundingOpen(!S.groundingOpen); break;
  }
});

function toggleAnnotations() {
  if (!S.grounding) return;
  S.labels = !S.labels;
  flag('annotations', S.labels);
  draw(); overlays();
}
function toggleInvert() { S.invert = !S.invert; flag('invert', S.invert); paint(); }
function toggleSmooth() { S.smooth = !S.smooth; flag('smooth', S.smooth); draw(); }
function toggleMeasure() {
  S.measuring = !S.measuring; flag('measure', S.measuring);
  cv.classList.toggle('measuring', S.measuring);
}
function clearLines() { S.lines = []; S.pending = null; draw(); }
function resetAll() {
  S.invert = false; S.smooth = true; S.measuring = false;
  flag('invert', false); flag('smooth', true); flag('measure', false);
  cv.classList.remove('measuring');
  clearLines(); applyPreset('scanner'); fit(); paint();
}
function flag(act, on) {
  const b = document.querySelector('#toolbar button[data-act="' + act + '"]');
  if (b) b.classList.toggle('on', on);
}

function startCine() {
  if (!S.series || S.series.count < 2) return;
  S.playing = true; $('#btn-play').textContent = '❚❚';
  S.timer = setInterval(() => show((S.idx + 1) % S.series.count), 70);
}
function stopCine() {
  S.playing = false; $('#btn-play').textContent = '▶';
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
}

let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => resize(false), 90); });

/* ------------------------------------------------------------- utilities */

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function round(v) { return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10; }
function fmtDate(d) {
  return d && d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : (d || '');
}
function fmtTime(t) {
  return t && t.length >= 4 ? t.slice(0, 2) + ':' + t.slice(2, 4) : '';
}

flag('smooth', true);
flag('annotations', true);
boot();
