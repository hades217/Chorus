#!/usr/bin/env node

/**
 * Chorus — AI-Native Project Management
 *
 * Zero-dependency Node.js server that serves a drag-and-drop kanban board.
 * Reads PRD markdown files, displays them as cards, and writes status
 * changes back to the file's YAML frontmatter.
 *
 * Usage:
 *   node scripts/prd-board/server.mjs
 *   # Open http://localhost:4000
 */

import { createServer } from 'node:http';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, basename, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DOCS_DIR = join(ROOT, 'docs');
const PORT = 4000;

// Directories to scan for PRD/project docs (relative to ROOT)
// Add your own directories here
const SCAN_DIRS = [
  'docs/prd',
];

const SKIP_FILES = new Set(['TEMPLATE.md', 'README.md']);

const STATUS_ORDER = ['draft', 'ready', 'in-progress', 'review', 'done', 'blocked', 'archived'];

// ---------------------------------------------------------------------------
// Frontmatter parsing (same logic as dashboard generator)
// ---------------------------------------------------------------------------

function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase().trim().replace(/[_\s]+/g, '-');
  const MAP = {
    'draft': 'draft', 'wip': 'in-progress', 'in-progress': 'in-progress',
    'in-development': 'in-progress', 'in-review': 'review', 'review': 'review',
    'confirmed': 'ready', 'ready': 'ready', 'approved': 'ready',
    'done': 'done', 'completed': 'done', 'complete': 'done',
    'shipped': 'done', 'implemented': 'done',
    'blocked': 'blocked', 'on-hold': 'blocked',
    'archived': 'archived', 'deprecated': 'archived', 'legacy': 'archived',
  };
  return MAP[s] || 'unknown';
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w\s]*?):\s*(.+)/);
    if (kv) meta[kv[1].trim().toLowerCase()] = stripQuotes(kv[2].trim());
  }
  return meta;
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

function parseTableMeta(content) {
  const meta = {};
  const tableRegex = /\|\s*\*?\*?([^|*]+?)\*?\*?\s*\|\s*([^|]+?)\s*\|/g;
  let match, found = false;
  const head = content.split('\n').slice(0, 30).join('\n');
  while ((match = tableRegex.exec(head)) !== null) {
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key && value && key !== '---' && key !== 'item' && key !== 'field') {
      meta[key] = value; found = true;
    }
  }
  return found ? meta : null;
}

function parseBoldMeta(content) {
  const meta = {};
  const head = content.split('\n').slice(0, 20).join('\n');
  const regex = /\*\*(\w[\w\s]*?):\*\*\s*(.+)/g;
  let match, found = false;
  while ((match = regex.exec(head)) !== null) {
    meta[match[1].trim().toLowerCase()] = match[2].trim(); found = true;
  }
  return found ? meta : null;
}

function extractTitle(content, filename) {
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].replace(/^PRD:\s*/i, '').trim();
  return filename.replace(extname(filename), '').replace(/^PRD-\d{8}-?\d{0,4}-?/, '').replace(/[-_]/g, ' ');
}

function extractChecklist(content) {
  const checked = (content.match(/- \[x\]/gi) || []).length;
  const unchecked = (content.match(/- \[ \]/g) || []).length;
  const total = checked + unchecked;
  return total > 0 ? { checked, total, percent: Math.round((checked / total) * 100) } : null;
}

/**
 * Infer status from content when no explicit status is set.
 * Heuristics:
 *   - Has "Implementation Summary" or all checklist items done → done
 *   - Has many checked items (>50%) → in-progress
 *   - Has checklist but none checked → draft
 *   - Contains "STATUS" or "EXECUTION-PLAN" in filename → in-progress
 *   - Default → draft (better than unknown)
 */
function inferStatus(content, filename, checklist) {
  const lower = content.toLowerCase();
  const fname = filename.toLowerCase();

  // Signals for "done"
  if (fname.includes('implementation-summary') || fname.includes('implementation_summary')) return 'done';
  if (fname.includes('migration-verification-report')) return 'done';
  if (checklist && checklist.percent === 100) return 'done';

  // Signals for "in-progress"
  if (fname.includes('-status')) return 'in-progress';
  if (fname.includes('execution-plan') || fname.includes('task-plan') || fname.includes('task_plan')) return 'in-progress';
  if (checklist && checklist.percent > 50) return 'in-progress';

  // Signals for "review"
  if (checklist && checklist.percent > 80) return 'review';

  // Has checklist but early → draft
  if (checklist && checklist.percent <= 50) return 'draft';

  // Default: treat as draft (most PRDs without status are written but not started)
  return 'draft';
}

function extractMeta(content, filename) {
  let meta = parseYamlFrontmatter(content) || parseTableMeta(content) || parseBoldMeta(content) || {};
  const checklist = extractChecklist(content);
  const hasExplicitStatus = !!meta.status;
  let status = normalizeStatus(meta.status);

  // If no explicit status, infer from content
  if (!hasExplicitStatus || status === 'unknown') {
    status = inferStatus(content, filename, checklist);
  }

  return {
    title: meta.title || extractTitle(content, filename),
    status,
    statusInferred: !hasExplicitStatus,
    owner: meta.owner || meta.owners || meta.author || meta.assignee || '',
    date: meta.date || meta.created || meta['last updated'] || '',
    priority: (meta.priority || '').toLowerCase(),
    tags: meta.tags || '',
    checklist,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter writing
// ---------------------------------------------------------------------------

function updateFrontmatterStatus(content, newStatus) {
  // Has YAML frontmatter — update status field
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (fmMatch) {
    let fm = fmMatch[2];
    if (/^status:\s*.+/m.test(fm)) {
      fm = fm.replace(/^status:\s*.+/m, `status: ${newStatus}`);
    } else {
      fm += `\nstatus: ${newStatus}`;
    }
    return fmMatch[1] + fm + fmMatch[3] + content.slice(fmMatch[0].length);
  }

  // Has table metadata — update Status row
  const tableMatch = content.match(/(\|\s*\*?\*?Status\*?\*?\s*\|\s*)([^|]+?)(\s*\|)/i);
  if (tableMatch) {
    return content.replace(tableMatch[0], `${tableMatch[1]}${newStatus}${tableMatch[3]}`);
  }

  // Has bold metadata — update **Status:** line
  const boldMatch = content.match(/(\*\*Status:\*\*\s*).+/i);
  if (boldMatch) {
    return content.replace(boldMatch[0], `${boldMatch[1]}${newStatus}`);
  }

  // No metadata — prepend YAML frontmatter
  const title = extractTitle(content, '');
  const now = new Date().toISOString().slice(0, 10);
  const frontmatter = `---\ntitle: "${title}"\ndate: ${now}\nstatus: ${newStatus}\n---\n\n`;
  return frontmatter + content;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

async function getAllMdFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllMdFiles(fullPath));
    } else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Get git author (creator) and last modifier for a file.
 */
async function getGitInfo(filePath) {
  const { execSync } = await import('node:child_process');
  let author = '', lastModifier = '', createdDate = '';
  try {
    // Original author (first commit that added this file)
    author = execSync(
      `git log --format="%an" --diff-filter=A --follow -- "${filePath}"`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim().split('\n').pop() || '';

    // Last modifier
    lastModifier = execSync(
      `git log -1 --format="%an" -- "${filePath}"`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();

    // Created date
    createdDate = execSync(
      `git log --format="%aI" --diff-filter=A --follow -- "${filePath}"`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim().split('\n').pop() || '';
    if (createdDate) createdDate = createdDate.slice(0, 10);
  } catch {
    // git not available or file not tracked
  }
  return { author, lastModifier, createdDate };
}

async function scanPRDs() {
  // Collect files from all scan directories
  const allFiles = [];
  for (const scanDir of SCAN_DIRS) {
    const fullDir = join(ROOT, scanDir);
    try {
      const files = await getAllMdFiles(fullDir);
      for (const f of files) {
        allFiles.push({ path: f, category: scanDir.replace('docs/', '') });
      }
    } catch {
      // Directory may not exist — skip silently
    }
  }

  const prds = [];
  const gitInfoMap = new Map();
  const { execSync } = await import('node:child_process');

  // Get all git authors in one pass for all docs/
  try {
    const gitLog = execSync(
      `git log --format="%H %an" --name-only --diff-filter=A -- "docs/"`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
    ).toString();

    let currentAuthor = '';
    for (const line of gitLog.split('\n')) {
      const commitMatch = line.match(/^[a-f0-9]{40}\s+(.+)/);
      if (commitMatch) {
        currentAuthor = commitMatch[1];
      } else if (line.trim() && currentAuthor) {
        gitInfoMap.set(line.trim(), currentAuthor);
      }
    }
  } catch { /* fallback to per-file */ }

  for (const { path: filePath, category } of allFiles) {
    const content = await readFile(filePath, 'utf-8');
    const filename = basename(filePath);
    const relPath = relative(ROOT, filePath);
    const fileStat = await stat(filePath);
    const meta = extractMeta(content, filename);

    // Use git author if no owner in frontmatter
    const gitAuthor = gitInfoMap.get(relPath) || '';
    const owner = meta.owner || gitAuthor;
    const date = meta.date || fileStat.mtime.toISOString().slice(0, 10);

    prds.push({
      ...meta,
      owner,
      gitAuthor,
      date,
      category,
      file: relPath,
      filename,
      lastModified: fileStat.mtime.toISOString(),
    });
  }
  return prds;
}

async function updatePRDStatus(filePath, newStatus) {
  const fullPath = join(ROOT, filePath);
  const content = await readFile(fullPath, 'utf-8');
  const updated = updateFrontmatterStatus(content, newStatus);
  await writeFile(fullPath, updated, 'utf-8');
}

// ---------------------------------------------------------------------------
// Regenerate dashboard after status change
// ---------------------------------------------------------------------------

async function regenerateDashboard() {
  try {
    const { execSync } = await import('node:child_process');
    execSync('node scripts/generate-prd-dashboard.mjs', { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // Non-critical — dashboard will be stale but no harm
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API: list all PRDs
  if (url.pathname === '/api/prds' && req.method === 'GET') {
    const prds = await scanPRDs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prds, statuses: STATUS_ORDER }));
    return;
  }

  // API: update PRD status
  if (url.pathname === '/api/prds/status' && req.method === 'PUT') {
    const body = await readBody(req);
    const { file, status } = JSON.parse(body);
    if (!file || !status) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file and status required' }));
      return;
    }
    await updatePRDStatus(file, status);
    await regenerateDashboard();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: read PRD content
  if (url.pathname === '/api/prds/content' && req.method === 'GET') {
    const file = url.searchParams.get('file');
    if (!file || !file.startsWith('docs/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid file path' }));
      return;
    }
    const fullPath = join(ROOT, file);
    const content = await readFile(fullPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content, file }));
    return;
  }

  // API: toggle checkbox in PRD
  if (url.pathname === '/api/prds/checkbox' && req.method === 'PUT') {
    const body = await readBody(req);
    const { file, index, checked } = JSON.parse(body);
    if (!file || !file.startsWith('docs/') || typeof index !== 'number') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file and index required' }));
      return;
    }
    const fullPath = join(ROOT, file);
    let content = await readFile(fullPath, 'utf-8');

    // Find the Nth checkbox (- [ ] or - [x]) and toggle it
    let count = 0;
    const checkboxRegex = /- \[[ xX]\]/g;
    let match;
    const positions = [];
    while ((match = checkboxRegex.exec(content)) !== null) {
      positions.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
      count++;
    }

    if (index < 0 || index >= positions.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'checkbox index out of range' }));
      return;
    }

    const pos = positions[index];
    const replacement = checked ? '- [x]' : '- [ ]';
    content = content.slice(0, pos.start) + replacement + content.slice(pos.end);
    await writeFile(fullPath, content, 'utf-8');

    // Return updated content
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, content }));
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Chorus — AI-Native Project Management\n`);
  console.log(`    http://localhost:${PORT}\n`);
  console.log(`  Scanning: ${SCAN_DIRS.join(', ')}`);
  console.log(`  Drag cards to change status. Click to view. Check boxes to complete.\n`);
});
