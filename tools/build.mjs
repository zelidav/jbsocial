#!/usr/bin/env node
// JB Social Desk build tool. No dependencies; needs Node 20+.
//
// The published site carries no readable data: every report is packed into
// data/site.enc, encrypted with the team passphrase (JBSOCIAL_KEY).
//
//   node tools/build.mjs unpack   restore work/reports from data/site.enc
//   node tools/build.mjs status   list what is already synced
//   node tools/build.mjs ingest   move work/incoming/*.md into work/reports
//   node tools/build.mjs build    write data/site.enc from work/reports
//   node tools/build.mjs check    decrypt data/site.enc and print a summary
//
// work/ is never committed.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'work');
const REPORTS = path.join(WORK, 'reports');
const INCOMING = path.join(WORK, 'incoming');
const SYNC = path.join(WORK, 'sync.json');
const OUT = path.join(ROOT, 'data', 'site.enc');
const ITER = 310000;

const AGENTS = [
  { id: 'analyst', name: 'Analyst', prefix: 'analyst-', cadence: 'Mondays, 7:11 am ET', runs: 'Scheduled', does: 'Pulls the week\'s Instagram and YouTube numbers and gives the Strategist one instruction.' },
  { id: 'scout', name: 'Scout', prefix: 'scout-', cadence: 'Wednesdays, 7:21 am ET', runs: 'Scheduled', does: 'Finds what went big in glass and cannabis culture in the last 14 days, and the hooks worth borrowing.' },
  { id: 'brief', name: 'Strategist + Writer', prefix: 'brief-', cadence: 'Thursdays, 7:31 am ET', runs: 'Scheduled', does: 'Plans next week: slots, clips, hooks, captions, collaborators. A person approves every post.' },
  { id: 'clips', name: 'Clip Factory', prefix: 'clips-', cadence: 'Tuesdays and Fridays, 6:41 am ET', runs: 'Scheduled', does: 'Cuts the next two long-form videos into vertical clips in OpusClip and keeps the best five.' },
  { id: 'librarian', name: 'Librarian', prefix: 'library-', cadence: 'On demand', runs: 'Claude Code (Dopestr)', does: 'Indexes the content library so every other agent can find footage.' },
  { id: 'drop', name: 'Drop Builder', prefix: 'drop-', cadence: 'On demand', runs: 'Claude Code', does: 'Assembles the long-form YouTube drops from clips, narration and Final Cuts.' },
];

// ---------- helpers ----------

function key() {
  const k = process.env.JBSOCIAL_KEY;
  if (!k || k.length < 12) {
    console.error('Set JBSOCIAL_KEY to the team passphrase (12+ characters).');
    process.exit(2);
  }
  return k;
}

function encrypt(obj, pass) {
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const k = crypto.pbkdf2Sync(pass, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function decrypt(box, pass) {
  const salt = Buffer.from(box.salt, 'base64');
  const iv = Buffer.from(box.iv, 'base64');
  const raw = Buffer.from(box.ct, 'base64');
  const k = crypto.pbkdf2Sync(pass, salt, box.iter, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

function readSync() {
  try { return JSON.parse(fs.readFileSync(SYNC, 'utf8')); } catch { return {}; }
}

// Drive's text view escapes Markdown punctuation (\# \_ \[x\]); undo that.
export function unescapeMd(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')
    .replace(/\\([\\!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  let h = esc(s).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  h = h.replace(/\bhttps?:\/\/[^\s<|]+/g, (u) => {
    const m = u.match(/^(.*?)([.,;:)]*)$/);
    return `<a href="${m[1]}" target="_blank" rel="noopener noreferrer">${m[1].replace(/^https?:\/\/(www\.)?/, '')}</a>${m[2]}`;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  return h;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (line) => /^\|?\s*:?-{2,}/.test(line.trim()) && /^[\s|:-]+$/.test(line);
const isSpecial = (l) => /^#{1,4} /.test(l) || l.startsWith('|') || /^- /.test(l) || /^\d+\. /.test(l) || /^-{3,}$/.test(l);

export function mdToHtml(md) {
  const L = md.split('\n');
  const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4}) (.*)$/))) {
      const n = Math.min(m[1].length + 1, 5);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue;
    }
    if (/^-{3,}$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < L.length && L[i].startsWith('|')) { rows.push(L[i]); i++; }
      const head = cells(rows[0]);
      const body = rows.slice(isSep(rows[1] || '') ? 2 : 1).map(cells);
      out.push('<div class="tw"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^- /.test(l)) {
      const items = [];
      while (i < L.length && /^- /.test(L[i])) { items.push(L[i].slice(2)); i++; }
      out.push('<ul>' + items.map((it) => {
        const t = it.match(/^\[( |x|X)\] (.*)$/);
        if (t) return `<li class="task ${t[1] === ' ' ? 'todo' : 'done'}">${inline(t[2])}</li>`;
        return `<li>${inline(it)}</li>`;
      }).join('') + '</ul>');
      continue;
    }
    if (/^\d+\. /.test(l)) {
      const items = [];
      while (i < L.length && /^\d+\. /.test(L[i])) { items.push(L[i].replace(/^\d+\. /, '')); i++; }
      out.push('<ol>' + items.map((it) => `<li>${inline(it)}</li>`).join('') + '</ol>');
      continue;
    }
    const para = [l]; i++;
    while (i < L.length && L[i].trim() && !isSpecial(L[i])) { para.push(L[i]); i++; }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

// Split a report into its "## " sections.
function sections(md) {
  const res = []; let cur = { title: '', lines: [] };
  for (const l of md.split('\n')) {
    const m = l.match(/^## (.*)$/);
    if (m) { res.push(cur); cur = { title: m[1], lines: [] }; } else cur.lines.push(l);
  }
  res.push(cur);
  return res.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

function tablesIn(body) {
  const L = body.split('\n'); const res = []; let i = 0; let lead = '';
  while (i < L.length) {
    if (L[i].startsWith('|')) {
      const rows = [];
      while (i < L.length && L[i].startsWith('|')) { rows.push(L[i]); i++; }
      const head = cells(rows[0]).map((h) => h.toLowerCase());
      const body2 = rows.slice(isSep(rows[1] || '') ? 2 : 1).map(cells);
      res.push({ lead, head, rows: body2 });
    } else { if (L[i].trim()) lead = L[i]; i++; }
  }
  return res;
}

const col = (t, row, ...names) => {
  for (const n of names) { const ix = t.head.findIndex((h) => h.startsWith(n)); if (ix >= 0) return row[ix] || ''; }
  return '';
};
const num = (s) => { const m = String(s).replace(/,/g, '').match(/^[+-]?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// ---------- per-agent parsing ----------

function parseAnalyst(md) {
  const S = sections(md); const r = { kpis: [], youtube: [] };
  for (const s of S) {
    const t = s.title.toLowerCase();
    if (t.startsWith('headline')) r.headline = s.body;
    if (t.startsWith('one instruction')) r.instruction = s.body;
    if (t.startsWith('instagram')) {
      const tb = tablesIn(s.body)[0];
      if (tb) {
        r.igHead = tb.head;
        for (const row of tb.rows) r.kpis.push({ metric: row[0], now: row[1] || '', prev: row[2] || '', base: row[row.length - 1] || '' });
      }
    }
    if (t.startsWith('youtube')) {
      const tb = tablesIn(s.body)[0];
      if (tb) for (const row of tb.rows) r.youtube.push({ metric: row[0], now: row[1] || '', base: row[2] || '', change: row[3] || '' });
    }
  }
  return r;
}

function parseBrief(md, fileDate) {
  const r = { posts: [] };
  const h1 = (md.match(/^# (.*)$/m) || [])[1] || '';
  r.week = (h1.match(/for the week ([^)]*)/) || [])[1] || '';
  const year = Number((r.week.match(/(\d{4})/) || [])[1] || fileDate.slice(0, 4));
  r.theme = ((md.match(/^Theme of the week: (.*)$/m) || [])[1] || '');
  for (const s of sections(md)) {
    if (!/^the week/i.test(s.title)) continue;
    const tb = tablesIn(s.body)[0]; if (!tb) continue;
    for (const row of tb.rows) {
      const when = col(tb, row, 'day');
      const m = when.match(/^(\w{3}) (\w{3}) (\d{1,2}),?\s*([\d:]+\s*[ap]m)?(.*)$/i);
      let iso = '';
      if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
        const d = new Date(Date.UTC(year, MONTHS[m[2].toLowerCase()], Number(m[3])));
        iso = d.toISOString().slice(0, 10);
      }
      const asset = col(tb, row, 'clip');
      r.posts.push({
        when, date: iso, day: m ? `${m[1]} ${m[2]} ${m[3]}` : when, time: m && m[4] ? m[4] : '', note: m ? m[5].replace(/[()]/g, '').trim() : '',
        format: col(tb, row, 'format'), asset, clipId: (asset.match(/^([A-Za-z0-9]{10})\b/) || [])[1] || '',
        hook: col(tb, row, 'hook'), caption: col(tb, row, 'caption').replace(/<br\s*\/?>/gi, '\n'),
        cta: col(tb, row, 'cta'), collaborators: col(tb, row, 'collab'), hashtags: col(tb, row, 'hashtag'), series: col(tb, row, 'series'),
      });
    }
  }
  return r;
}

function parseClips(md, fileDate) {
  const r = { sources: [] };
  for (const s of sections(md)) {
    if (!/^source:/i.test(s.title)) continue;
    const parts = s.title.replace(/^source:\s*/i, '').split(' | ');
    const src = { videoId: parts[0], title: parts[1] || '', project: '', url: '', blocked: /BLOCKED/.test(s.title), note: '', kept: [], alternates: [], run: fileDate };
    for (const p of parts.slice(2)) {
      if (/^project /.test(p)) src.project = p.replace(/^project /, '');
      if (/^https?:/.test(p)) src.url = p;
    }
    const tbs = tablesIn(s.body);
    tbs.forEach((tb, ix) => {
      const alt = ix > 0 || /not kept/i.test(tb.lead);
      for (const row of tb.rows) {
        let id = col(tb, row, 'clip'); let notKept = alt;
        if (/^\(not kept\)/i.test(id)) { notKept = true; id = id.replace(/^\(not kept\)\s*/i, ''); }
        (notKept ? src.alternates : src.kept).push({
          id, timecode: col(tb, row, 'source timecode'), len: col(tb, row, 'len'), score: num(col(tb, row, 'score')),
          what: col(tb, row, 'what'), series: col(tb, row, 'series'), caution: col(tb, row, 'caution'),
        });
      }
    });
    src.note = s.body.split('\n').filter((l) => l.trim() && !l.startsWith('|')).join(' ');
    r.sources.push(src);
  }
  r.usage = (md.match(/^Usage after this run: (.*)$/m) || [])[1] || '';
  return r;
}

function parseQueue(md) {
  const r = { waves: [], total: 0, done: 0, blocked: [] };
  for (const s of sections(md)) {
    const items = [];
    for (const l of s.body.split('\n')) {
      const m = l.match(/^- \[( |x|X)\] (.*)$/); if (!m) continue;
      const p = m[2].split(' | ');
      const it = { done: m[1] !== ' ', videoId: p[0], title: p[1] || '', rest: p.slice(2).join(' | '), blocked: /BLOCKED/.test(m[2]) };
      items.push(it); r.total++; if (it.done) r.done++; if (it.blocked) r.blocked.push(it);
    }
    if (items.length) r.waves.push({ title: s.title, items });
  }
  return r;
}

function parseRunlog(md) {
  const rows = [];
  for (const l of md.split('\n')) {
    if (!/^\d{4}-\d{2}-\d{2} \| /.test(l)) continue;
    const p = l.split(' | ');
    rows.push({ date: p[0], who: p[1] || '', produced: p[2] || '', open: p.slice(3).join(' | ') });
  }
  return rows;
}

function parseScout(md) {
  const r = { outliers: [], parts: {} };
  for (const s of sections(md)) {
    const t = s.title.toLowerCase();
    if (t.includes('outlier')) {
      const tb = tablesIn(s.body)[0];
      if (tb) for (const row of tb.rows) r.outliers.push({
        account: col(tb, row, 'account'), link: col(tb, row, 'link'), format: col(tb, row, 'format'), views: col(tb, row, 'views'),
        multiple: col(tb, row, 'outlier'), first: col(tb, row, 'first'), why: col(tb, row, 'why'),
      });
    }
    if (t.includes('hook')) r.parts.hooks = mdToHtml(s.body);
    if (t.includes('series')) r.parts.series = mdToHtml(s.body);
    if (t.includes('risk')) r.parts.risk = mdToHtml(s.body.split('\n---')[0]);
  }
  return r;
}

// ---------- commands ----------

function skip(name) { return !name.endsWith('.md') || /superseded|^runlog-prev/i.test(name); }

function agentOf(name) {
  if (name === 'runlog.md') return 'runlog';
  if (name === 'clip-queue.md') return 'queue';
  const a = AGENTS.find((x) => name.startsWith(x.prefix));
  return a ? a.id : 'other';
}

function buildSite() {
  const files = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter((f) => !skip(f)).sort() : [];
  const raw = {}; const reports = []; const data = {};
  const analystAll = [];
  for (const f of files) {
    const md = fs.readFileSync(path.join(REPORTS, f), 'utf8');
    raw[f] = md;
    const agent = agentOf(f);
    const date = (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const title = (md.match(/^# (.*)$/m) || [])[1] || f;
    reports.push({ file: f, agent, date, title, html: mdToHtml(md) });
    if (agent === 'analyst') analystAll.push({ date, file: f, ...parseAnalyst(md) });
    if (agent === 'brief') (data.briefs ||= []).push({ date, file: f, ...parseBrief(md, date) });
    if (agent === 'clips') (data.clips ||= []).push({ date, file: f, ...parseClips(md, date) });
    if (agent === 'scout') (data.scouts ||= []).push({ date, file: f, ...parseScout(md) });
    if (agent === 'queue') data.queue = parseQueue(md);
    if (agent === 'runlog') data.runlog = parseRunlog(md);
  }
  const byDate = (a, b) => (a.date < b.date ? 1 : -1);
  reports.sort((a, b) => byDate(a, b) || a.file.localeCompare(b.file));
  for (const k of ['briefs', 'clips', 'scouts']) (data[k] ||= []).sort(byDate);
  analystAll.sort(byDate);
  data.analysts = analystAll;
  data.queue ||= { waves: [], total: 0, done: 0, blocked: [] };
  data.runlog ||= [];
  return { generated: new Date().toISOString(), agents: AGENTS, reports, data, raw, sync: readSync() };
}

const cmd = process.argv[2];

if (cmd === 'unpack') {
  fs.mkdirSync(REPORTS, { recursive: true }); fs.mkdirSync(INCOMING, { recursive: true });
  if (!fs.existsSync(OUT)) { console.log('No data/site.enc yet; starting empty.'); process.exit(0); }
  const site = decrypt(JSON.parse(fs.readFileSync(OUT, 'utf8')), key());
  for (const [f, md] of Object.entries(site.raw || {})) fs.writeFileSync(path.join(REPORTS, path.basename(f)), md);
  fs.writeFileSync(SYNC, JSON.stringify(site.sync || {}, null, 2));
  console.log(`Unpacked ${Object.keys(site.raw || {}).length} reports (bundle built ${site.generated}).`);
} else if (cmd === 'status') {
  const s = readSync();
  const names = Object.keys(s).sort();
  if (!names.length) console.log('Nothing synced yet.');
  for (const n of names) console.log(`${n}\t${s[n].modifiedTime}\t${s[n].size}`);
} else if (cmd === 'ingest') {
  fs.mkdirSync(REPORTS, { recursive: true });
  const sync = readSync();
  let meta = [];
  try { meta = JSON.parse(fs.readFileSync(path.join(INCOMING, 'meta.json'), 'utf8')); } catch { /* optional */ }
  const files = fs.existsSync(INCOMING) ? fs.readdirSync(INCOMING).filter((f) => f.endsWith('.md')) : [];
  let warn = 0;
  for (const f of files) {
    if (skip(f)) { console.log(`skip   ${f}`); continue; }
    const text = unescapeMd(fs.readFileSync(path.join(INCOMING, f), 'utf8'));
    const m = meta.find((x) => x.title === f);
    const bytes = Buffer.byteLength(text);
    let flag = '';
    if (m && m.size) {
      // A faithful copy lands on Drive's byte count exactly; allow 2% for stray whitespace.
      const drift = Math.abs(bytes - Number(m.size)) / Number(m.size);
      if (drift === 0) flag = '  matches Drive';
      else if (drift > 0.02) { flag = `  WARNING: ${bytes} bytes here vs ${m.size} in Drive; re-copy this file`; warn++; }
      else flag = `  close to Drive (${m.size})`;
    }
    fs.writeFileSync(path.join(REPORTS, f), text);
    if (m) sync[f] = { modifiedTime: m.modifiedTime, size: Number(m.size) || 0 };
    fs.rmSync(path.join(INCOMING, f));
    console.log(`ingest ${f} (${bytes} bytes)${flag}`);
  }
  fs.rmSync(path.join(INCOMING, 'meta.json'), { force: true });
  fs.writeFileSync(SYNC, JSON.stringify(sync, null, 2));
  process.exit(warn ? 1 : 0);
} else if (cmd === 'build') {
  const site = buildSite();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(encrypt(site, key())));
  const back = decrypt(JSON.parse(fs.readFileSync(OUT, 'utf8')), key());
  console.log(`Built data/site.enc: ${back.reports.length} reports, ${fs.statSync(OUT).size} bytes, round-trip OK.`);
} else if (cmd === 'check') {
  const site = decrypt(JSON.parse(fs.readFileSync(OUT, 'utf8')), key());
  console.log(`Bundle built ${site.generated}`);
  for (const r of site.reports) console.log(`  ${r.agent.padEnd(8)} ${r.date || '          '} ${r.file}`);
  if (process.argv[3] === '--json') fs.writeFileSync(path.join(WORK, 'site.json'), JSON.stringify(site, null, 1));
} else {
  console.log('Usage: JBSOCIAL_KEY=... node tools/build.mjs unpack|status|ingest|build|check');
  process.exit(cmd ? 2 : 0);
}
