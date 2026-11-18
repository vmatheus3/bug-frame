// The blind workspace: a throwaway copy of the project with every agent-instruction file, secret and build
// artefact left out, so the auditor sees the code and the page, never the team's rules for AI agents.
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { readdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CliError } from '../commands.mjs';

/** Files and folders (exact name, any letter case, any depth) that hold instructions for AI agents. */
const INSTRUCTION_NAMES = new Set(['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', 'gemini.md', '.claude', '.agents', '.agent', '.keel', '.codex',
  '.cursor', '.cursorrules', '.windsurfrules', '.windsurf', '.clinerules', '.roo', '.roomodes', '.continue', '.kiro', 'memory-bank']);
/** Instruction locations identified by their last path segments. */
const INSTRUCTION_TAILS = ['.github/copilot-instructions.md', '.github/instructions'];
const NOISE_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '_bugframe_audit', 'bugframe-audit', '.bugframe-blind']);
export const EVIDENCE_DIR = '_bugframe_audit';
const MB = 1024 * 1024;
const DEFAULT_LIMITS = { maxFiles: 50_000, maxBytes: 200 * MB, maxBinaryBytes: MB };

/** 'instruction' | 'secret' | 'noise' | null for a project-relative POSIX path. */
export function classify(rel, isDir) {
  const lower = rel.toLowerCase(), name = lower.split('/').pop();
  if (INSTRUCTION_NAMES.has(name) || name.startsWith('.aider') || INSTRUCTION_TAILS.some(t => lower === t || lower.endsWith('/' + t))) return 'instruction';
  if (NOISE_NAMES.has(name)) return 'noise';
  if (!isDir && ((name.startsWith('.env') && name !== '.env.example') || /\.(pem|key|p12)$/.test(name) || name.startsWith('id_rsa'))) return 'secret';
  return null;
}

/** A tiny gitignore-style matcher for `.bugframe-blind`: one glob per line, `#` comments, trailing `/` = folders only,
 *  a `/` inside the pattern anchors it to the project root, otherwise it matches a name at any depth. */
export function ignoreMatcher(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const dirOnly = line.endsWith('/'); line = line.replace(/\/+$/, '');
    const anchored = line.includes('/'); line = line.replace(/^\/+/, '');
    const body = line.split(/(\*\*\/|\*\*|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    rules.push({ dirOnly, re: new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`, 'i') });
  }
  return (rel, isDir) => rules.some(r => (!r.dirOnly || isDir) && r.re.test(rel));
}

/** Refuse a workspace that sits below an instruction file: agents read those from every parent folder. */
export function assertCleanAncestors(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    let names = []; try { names = readdirSync(d); } catch { names = []; }
    for (const name of names) {
      if (name.toLowerCase() !== '.claude' && classify(name, false) !== 'instruction') continue; // temp folders hold thousands of entries
      let isDir = false; try { isDir = lstatSync(join(d, name)).isDirectory(); } catch { /* vanished */ }
      const nested = isDir && name.toLowerCase() === '.claude' && (existsSync(join(d, name, 'CLAUDE.md')) || existsSync(join(d, name, 'rules')));
      if ((!isDir && classify(name, false) === 'instruction') || nested) throw new CliError(`Refusing to build the blind workspace: an agent instruction file (${name}) sits in one of its parent folders. Set TMPDIR to a clean folder.`);
    }
    if (dirname(d) === d) return;
  }
}

const isBinary = async (path, size) => {
  const fh = await open(path, 'r');
  try { const buf = Buffer.alloc(Math.min(8000, size)); await fh.read(buf, 0, buf.length, 0); return buf.includes(0); } finally { await fh.close(); }
};

/**
 * Copy `project` into a new folder under the system temp dir, minus instructions, secrets, noise and `.bugframe-blind`
 * entries. Symlinks are never followed or copied. Returns { root, dir, evidenceDir, manifest, cleanup }.
 */
export async function createBlindWorkspace({ project, tmpRoot = tmpdir(), limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let src, base;
  try { src = await realpath(resolve(project)); if (!(await lstat(src)).isDirectory()) throw new Error(); } catch { throw new CliError('--project must be an existing folder.'); }
  base = await realpath(resolve(tmpRoot));
  if (base === src || base.startsWith(src + sep)) throw new CliError('The temp folder is inside the project; the blind copy must live outside it. Set TMPDIR elsewhere.');
  assertCleanAncestors(base);
  let ignore = () => false, ignoreFile = false;
  try { ignore = ignoreMatcher(await readFile(join(src, '.bugframe-blind'), 'utf8')); ignoreFile = true; } catch { /* optional */ }

  const root = await mkdtemp(join(base, 'bugframe-audit-')), dir = join(root, 'workspace');
  const cleanup = () => rm(root, { recursive: true, force: true });
  const manifest = { copiedFiles: 0, copiedBytes: 0, excludedInstructions: [], excludedSecrets: 0, excludedNoise: 0, excludedByIgnoreFile: 0, skippedSymlinks: 0, skippedLargeBinaries: 0, ignoreFile };
  try {
    await mkdir(dir, { mode: 0o700 });
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      for (const name of await readdir(join(src, rel))) {
        const r = rel ? `${rel}/${name}` : name, from = join(src, r);
        const st = await lstat(from);
        if (st.isSymbolicLink()) { manifest.skippedSymlinks++; continue; }
        if (!st.isDirectory() && !st.isFile()) continue;
        const kind = classify(r, st.isDirectory());
        if (kind === 'instruction') { manifest.excludedInstructions.push(r); continue; }
        if (kind === 'secret') { manifest.excludedSecrets++; continue; }
        if (kind === 'noise') { manifest.excludedNoise++; continue; }
        if (ignore(r, st.isDirectory())) { manifest.excludedByIgnoreFile++; continue; }
        if (st.isDirectory()) { await mkdir(join(dir, r)); stack.push(r); continue; }
        if (st.size > lim.maxBinaryBytes && await isBinary(from, st.size)) { manifest.skippedLargeBinaries++; continue; }
        manifest.copiedFiles++; manifest.copiedBytes += st.size;
        if (manifest.copiedFiles > lim.maxFiles || manifest.copiedBytes > lim.maxBytes) throw new CliError(`The project is too large for a blind copy (limit ${lim.maxFiles} files / ${Math.round(lim.maxBytes / MB)} MB after exclusions). List generated or vendored folders in a .bugframe-blind file.`);
        await copyFile(from, join(dir, r));
      }
    }
    // Belt and braces: nothing that looks like an instruction file may exist in the copy.
    const leftovers = []; const check = [''];
    while (check.length) { const rel = check.pop(); for (const e of await readdir(join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (classify(r, e.isDirectory()) === 'instruction') leftovers.push(r); if (e.isDirectory()) check.push(r); } }
    if (leftovers.length) throw new CliError('The blind copy still contains instruction files; refusing to run.');
    assertCleanAncestors(dir);
    const evidenceDir = join(dir, EVIDENCE_DIR);
    await mkdir(evidenceDir);
    return { root, dir, evidenceDir, manifest, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
