#!/usr/bin/env node

/**
 * Chorus — Dashboard Generator
 *
 * Scans docs/ subdirectories for all PRD markdown files, extracts
 * frontmatter/metadata, and generates docs/DASHBOARD.md with status overview.
 *
 * Usage:
 *   node scripts/generate-prd-dashboard.mjs
 *
 * Supported frontmatter formats:
 *   1. YAML frontmatter (--- delimited)
 *   2. Markdown table metadata (| Item | Detail |)
 *   3. Bold key-value pairs (**Status:** Done)
 *   4. Falls back to "unknown" if no metadata found
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, basename, extname } from 'node:path';

const DOCS_DIR = join(import.meta.dirname, '..', 'docs');
const PRD_DIR = join(DOCS_DIR, 'prd');
const OUTPUT_FILE = join(DOCS_DIR, 'DASHBOARD.md');

// Files to skip (not actual PRDs)
const SKIP_FILES = new Set([
  'TEMPLATE.md',
  'PRD-IMPROVEMENT-SUMMARY.md',
  'IMPLEMENTATION_SUMMARY.md',
]);

// Canonical status values
const STATUS_ORDER = [
  'draft',
  'ready',
  'in-progress',
  'review',
  'done',
  'blocked',
  'archived',
  'unknown',
];

const STATUS_EMOJI = {
  'blocked': '🔴',
  'in-progress': '🟡',
  'draft': '📝',
  'ready': '🟢',
  'review': '🔍',
  'done': '✅',
  'archived': '📦',
  'unknown': '❓',
};

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase().trim().replace(/[_\s]+/g, '-');
  const MAP = {
    'draft': 'draft',
    'wip': 'in-progress',
    'in-progress': 'in-progress',
    'in-development': 'in-progress',
    'in-review': 'review',
    'review': 'review',
    'confirmed': 'ready',
    'ready': 'ready',
    'approved': 'ready',
    'done': 'done',
    'completed': 'done',
    'complete': 'done',
    'shipped': 'done',
    'implemented': 'done',
    'blocked': 'blocked',
    'on-hold': 'blocked',
    'archived': 'archived',
    'deprecated': 'archived',
    'legacy': 'archived',
  };
  return MAP[s] || 'unknown';
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w\s]*?):\s*(.+)/);
    if (kv) {
      meta[kv[1].trim().toLowerCase()] = stripQuotes(kv[2].trim());
    }
  }
  return meta;
}

function parseTableMeta(content) {
  // Match "| **Key** | Value |" or "| Key | Value |" style tables
  const meta = {};
  const tableRegex = /\|\s*\*?\*?([^|*]+?)\*?\*?\s*\|\s*([^|]+?)\s*\|/g;
  let match;
  let found = false;

  // Only scan first 30 lines
  const head = content.split('\n').slice(0, 30).join('\n');
  while ((match = tableRegex.exec(head)) !== null) {
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key && value && key !== '---' && key !== 'item' && key !== 'field') {
      meta[key] = value;
      found = true;
    }
  }
  return found ? meta : null;
}

function parseBoldMeta(content) {
  const meta = {};
  const head = content.split('\n').slice(0, 20).join('\n');
  const regex = /\*\*(\w[\w\s]*?):\*\*\s*(.+)/g;
  let match;
  let found = false;

  while ((match = regex.exec(head)) !== null) {
    meta[match[1].trim().toLowerCase()] = match[2].trim();
    found = true;
  }
  return found ? meta : null;
}

function extractTitle(content, filename) {
  // Try first H1
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].replace(/^PRD:\s*/i, '').trim();

  // Try title from frontmatter (already extracted)
  return filename.replace(extname(filename), '').replace(/^PRD-\d{8}-?\d{0,4}-?/, '').replace(/[-_]/g, ' ');
}

function extractMeta(content, filename) {
  // Try YAML frontmatter first
  let meta = parseYamlFrontmatter(content);
  if (!meta) meta = parseTableMeta(content);
  if (!meta) meta = parseBoldMeta(content);
  if (!meta) meta = {};

  const title = meta.title || extractTitle(content, filename);
  const status = normalizeStatus(meta.status);
  const owner = meta.owner || meta.owners || meta.author || meta.assignee || '';
  const date = meta.date || meta.created || meta['last updated'] || '';
  const updated = meta.updated || meta['last updated'] || meta['last modified'] || date;
  const priority = (meta.priority || '').toLowerCase() || '';
  const tags = meta.tags || '';

  return { title, status, owner, date, updated, priority, tags };
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

async function getAllMdFiles(dir, base) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllMdFiles(fullPath, base));
    } else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function scanPRDs() {
  const files = await getAllMdFiles(PRD_DIR, PRD_DIR);
  const prds = [];

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf-8');
    const filename = basename(filePath);
    const relPath = relative(DOCS_DIR, filePath);
    const fileStat = await stat(filePath);

    const meta = extractMeta(content, filename);
    prds.push({
      ...meta,
      file: relPath,
      filename,
      lastModified: fileStat.mtime,
    });
  }

  return prds;
}

// ---------------------------------------------------------------------------
// Dashboard generation
// ---------------------------------------------------------------------------

function groupByStatus(prds) {
  const groups = {};
  for (const s of STATUS_ORDER) groups[s] = [];
  for (const prd of prds) {
    (groups[prd.status] || groups['unknown']).push(prd);
  }
  // Sort each group by lastModified descending
  for (const s of STATUS_ORDER) {
    groups[s].sort((a, b) => b.lastModified - a.lastModified);
  }
  return groups;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  // Handle ISO and common formats
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toISOString().slice(0, 10);
}

function truncate(str, len) {
  if (!str) return '-';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function generateDashboard(prds) {
  const groups = groupByStatus(prds);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // Stats
  const total = prds.length;
  const statCounts = STATUS_ORDER
    .filter(s => groups[s].length > 0)
    .map(s => `${STATUS_EMOJI[s]} ${s}: ${groups[s].length}`)
    .join(' | ');

  let md = `# Chorus Dashboard

> Auto-generated by \`scripts/generate-prd-dashboard.mjs\` — do not edit manually.
> Kanban board: \`node scripts/prd-board/server.mjs\` → http://localhost:4000
> Last updated: ${now}

## Overview

**Total PRDs: ${total}** — ${statCounts}

---

`;

  // Render each non-empty status group
  for (const status of STATUS_ORDER) {
    const items = groups[status];
    if (items.length === 0) continue;

    md += `## ${STATUS_EMOJI[status]} ${status.charAt(0).toUpperCase() + status.slice(1)} (${items.length})\n\n`;
    md += `| Title | Owner | Date | File |\n`;
    md += `|-------|-------|------|------|\n`;

    for (const prd of items) {
      const title = truncate(prd.title, 60);
      const owner = truncate(prd.owner, 25);
      const date = formatDate(prd.date || prd.lastModified.toISOString());
      const link = `[${prd.filename}](${prd.file})`;
      md += `| ${title} | ${owner} | ${date} | ${link} |\n`;
    }
    md += '\n';
  }

  // Quick reference: how to update status
  md += `---

## How to Update PRD Status

Add or update YAML frontmatter at the top of your PRD file:

\`\`\`markdown
---
title: Your PRD Title
date: 2026-04-06
status: in-progress
owner: "@your-name"
priority: high
tags: [frontend, resume]
---
\`\`\`

**Valid statuses:** \`draft\` | \`ready\` | \`in-progress\` | \`review\` | \`done\` | \`blocked\` | \`archived\`

Then regenerate this dashboard:

\`\`\`bash
node scripts/generate-prd-dashboard.mjs
\`\`\`
`;

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Scanning PRDs in docs/prd/ ...');
  const prds = await scanPRDs();
  console.log(`Found ${prds.length} PRD files.`);

  const dashboard = generateDashboard(prds);
  await writeFile(OUTPUT_FILE, dashboard, 'utf-8');
  console.log(`Dashboard written to docs/DASHBOARD.md`);

  // Print summary
  const groups = groupByStatus(prds);
  for (const s of STATUS_ORDER) {
    if (groups[s].length > 0) {
      console.log(`  ${STATUS_EMOJI[s]} ${s}: ${groups[s].length}`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
