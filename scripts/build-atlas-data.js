#!/usr/bin/env node
/**
 * build-atlas-data.js
 * Generates data/atlas-reference-architectures.json
 *
 * Source of truth: data/source/docs/ref-arch — same logic as the live site's
 * page-mapping-generator plugin, with full tagsMapping for domain classification.
 *
 * Active documents = all RA*\/**\/*.{md,mdx} where:
 *   - has id, title, tags[], last_update.date
 *   - NOT draft
 *   - NOT unlisted
 *   (RA0000 is the demo/index page — unlisted → excluded)
 */

const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');

const REF_ARCH_DIR = path.join(__dirname, '..', 'data', 'source', 'docs', 'ref-arch');
const OUT_FILE     = path.join(__dirname, '..', 'data', 'atlas-reference-architectures.json');

// ── Tag → domain/partner classification (from src/constant/tagsMapping.json) ──
const DOMAIN_MAP = {
  genai:'ai',      appdev:'appdev',   data:'data',
  integration:'integration', security:'opsec',
  cap:'appdev',    abap:'appdev',     eda:'integration',
  eic:'integration', build:'appdev',  buildworkzone:'appdev',
  transition:'integration', snowflake:'data', bdc:'data',
  successfactors:'data', agents:'ai',
};
const PARTNER_TAGS = new Set(['aws','azure','gcp','ibm','databricks','nvidia','snowflake']);

const DOMAIN_LABELS = {
  ai:'AI & Machine Learning',
  appdev:'Application Dev. & Automation',
  data:'Data & Analytics',
  integration:'Integration',
  opsec:'Operations & Security',
};

// ── Walk helpers ──────────────────────────────────────────────────────────────
function findMarkdownFiles(dir) {
  const results = [];
  for (const ra of fs.readdirSync(dir)) {
    if (!/^RA\d+$/.test(ra)) continue;
    walk(path.join(dir, ra), results);
  }
  return results;
}

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.md') || e.name.endsWith('.mdx')) acc.push(full);
  }
}

function getDrawioInfo(filePath) {
  const dir = path.dirname(filePath);
  const drawioDir = path.join(dir, 'drawio');
  try {
    if (!fs.existsSync(drawioDir)) return { has_diagram: false, drawio_filename: null };
    const files = fs.readdirSync(drawioDir).filter(f => f.endsWith('.drawio')).sort();
    if (!files.length) return { has_diagram: false, drawio_filename: null };
    return { has_diagram: true, drawio_filename: files[0] };
  } catch { return { has_diagram: false, drawio_filename: null }; }
}

// ── Build ─────────────────────────────────────────────────────────────────────
const docs = [];
const seen = new Set();

// Pre-load RA group titles from RA*/readme.md
const raGroupTitles = {};
for (const ra of fs.readdirSync(REF_ARCH_DIR)) {
  if (!/^RA\d+$/.test(ra)) continue;
  const indexPath = path.join(REF_ARCH_DIR, ra, 'readme.md');
  if (!fs.existsSync(indexPath)) continue;
  try {
    const { data: fm } = matter(fs.readFileSync(indexPath, 'utf8'));
    raGroupTitles[ra] = fm.title || fm.sidebar_label || ra;
  } catch {}
}

for (const filePath of findMarkdownFiles(REF_ARCH_DIR)) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data: fm } = matter(raw);

  // Required fields check — same as page-mapping-generator
  if (!fm.id || !fm.title || !fm.tags || !Array.isArray(fm.tags) || !fm.last_update?.date) continue;
  // Exclude draft and unlisted
  if (fm.draft || fm.unlisted) continue;

  const { has_diagram, drawio_filename } = getDrawioInfo(filePath);
  const rel   = path.relative(REF_ARCH_DIR, filePath).split(path.sep).join('/');
  const parts = rel.split('/');
  const raGroup = parts[0]; // e.g. RA0001

  // Deduplicate by id (slug is also unique but id is the canonical key)
  if (seen.has(fm.id)) continue;
  seen.add(fm.id);

  // Domain classification (1..n per doc)
  const domains  = [...new Set((fm.tags || []).map(t => DOMAIN_MAP[t]).filter(Boolean))];
  const partners = (fm.tags || []).filter(t => PARTNER_TAGS.has(t));

  docs.push({
    id:             fm.id,
    slug:           fm.slug || null,
    title:          fm.title,
    description:    fm.description || null,
    keywords:       fm.keywords   || [],
    tags:           fm.tags        || [],
    domains,                          // e.g. ['ai','appdev']
    domain_labels:  domains.map(d => DOMAIN_LABELS[d] || d),
    partners,                         // e.g. ['aws','azure']
    ra_group:       raGroup,
    ra_group_title: raGroupTitles[raGroup] || raGroup,
    contributors:   fm.contributors || [],
    last_update: {
      date:   fm.last_update.date,
      author: fm.last_update.author || null,
    },
    has_diagram,
    drawio_filename,
    arch_center_url: fm.slug ? `https://architecture.learning.sap.com/docs${fm.slug}` : null,
    source_url:     `https://github.com/SAP/architecture-center/tree/main/docs/ref-arch/${rel.replace('/readme.md','')}`,
  });
}

// Sort by last_update descending
docs.sort((a, b) => new Date(b.last_update.date) - new Date(a.last_update.date));

// ── Stats ─────────────────────────────────────────────────────────────────────
const domainCounts = {};
for (const d of docs) {
  for (const dom of d.domains) domainCounts[dom] = (domainCounts[dom] || 0) + 1;
}
// Docs with no domain (e.g. successfactors was missing in older mapping)
const noDomain = docs.filter(d => d.domains.length === 0);

const output = {
  meta: {
    generated_at:    new Date().toISOString(),
    source_sha:      (() => {
      try { return require('child_process').execSync('git -C data/source rev-parse HEAD',{stdio:['pipe','pipe','pipe']}).toString().trim(); } catch { return null; }
    })(),
    source_branch:   'main',
    source_repo:     'https://github.com/SAP/architecture-center',
    total_documents: docs.length,
    domain_counts:   domainCounts,
    notes: noDomain.length
      ? `${noDomain.length} doc(s) have no domain mapping: ${noDomain.map(d=>d.id).join(', ')}`
      : 'All documents have at least one domain.',
  },
  documents: docs,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

// ── Data History Snapshot (V2) ────────────────────────────────────────────────
// On every build, save a dated snapshot to data/snapshots/.
// Format: atlas-YYYY-MM-DD-<first8ofSHA>.json
// This enables future "what changed" queries without any external infrastructure.
// The snapshots/ directory is .gitignore'd by default — opt in by committing them.
const SNAPSHOTS_DIR = path.join(__dirname, '..', 'data', 'snapshots');
try {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const shortSha = (output.meta.source_sha || 'unknown').slice(0, 8);
  const snapshotFile = path.join(SNAPSHOTS_DIR, `atlas-${today}-${shortSha}.json`);
  if (!fs.existsSync(snapshotFile)) {
    // Compact snapshot: meta + doc ids/titles/domains/tags/last_update only
    const snap = {
      meta: output.meta,
      documents: docs.map(d => ({
        id: d.id, title: d.title, domains: d.domains,
        tags: d.tags, partners: d.partners, ra_group: d.ra_group,
        last_update: d.last_update,
      })),
    };
    fs.writeFileSync(snapshotFile, JSON.stringify(snap));
    console.log(`  Snapshot saved → data/snapshots/atlas-${today}-${shortSha}.json`);
  } else {
    console.log(`  Snapshot already exists for today (${today}), skipped.`);
  }
} catch (e) {
  console.warn(`  Warning: snapshot could not be saved (${e.message})`);
}

console.log(`\nAtlas data written → ${OUT_FILE}`);
console.log(`  Total documents : ${docs.length}`);
console.log(`  Domain breakdown:`);
for (const [d, c] of Object.entries(domainCounts)) {
  console.log(`    ${DOMAIN_LABELS[d] || d}: ${c}`);
}
if (noDomain.length) {
  console.log(`\n  ⚠ No domain: ${noDomain.map(d => d.title).join(', ')}`);
}
console.log(`\nNote: "119" on the live site includes RA0000 (the demo page, unlisted).`);
console.log(`      Our ${docs.length} = all active, non-draft, non-unlisted documents.`);
