#!/usr/bin/env node
/**
 * Semantic Versioning & Release Metadata utility for Antigravity Chat UI.
 * Zero external dependencies — runs on Node.js >= 24.
 *
 * Subcommands:
 *   resolve          Compute next SemVer version/tag from git tags + Conventional Commits
 *   stamp-sw         Stamp version & short SHA into built dist/sw.js to bust PWA caches cleanly
 *   stamp-manifests  Update version field inside staged bundle package.json manifests
 *   write-build-info Generate BUILD_INFO.json with deterministic buildId
 *   notes            Build Markdown release notes combining optional GitHub notes + metadata
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * @typedef {{ major: number; minor: number; patch: number; version: string; tag: string }} SemverInfo
 * @typedef {{ sha: string; subject: string; body: string }} CommitEntry
 * @typedef {'major' | 'minor' | 'patch' | 'none' | 'existing' | 'manual'} BumpKind
 */

/**
 * Parse a strict X.Y.Z or vX.Y.Z version string.
 * @param {string | null | undefined} input
 * @returns {SemverInfo | null}
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const match = SEMVER_RE.exec(trimmed);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  const version = `${major}.${minor}.${patch}`;
  return { major, minor, patch, version, tag: `v${version}` };
}

/**
 * Compare two SemVer objects. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * @param {SemverInfo} a
 * @param {SemverInfo} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/**
 * Bump a SemVer version.
 * @param {SemverInfo} base
 * @param {'major' | 'minor' | 'patch' | 'none'} bump
 * @returns {SemverInfo}
 */
export function bumpSemver(base, bump) {
  if (bump === 'major') {
    const version = `${base.major + 1}.0.0`;
    return { major: base.major + 1, minor: 0, patch: 0, version, tag: `v${version}` };
  }
  if (bump === 'minor') {
    const version = `${base.major}.${base.minor + 1}.0`;
    return { major: base.major, minor: base.minor + 1, patch: 0, version, tag: `v${version}` };
  }
  if (bump === 'patch') {
    const version = `${base.major}.${base.minor}.${base.patch + 1}`;
    return { major: base.major, minor: base.minor, patch: base.patch + 1, version, tag: `v${version}` };
  }
  return { ...base };
}

/**
 * Classify a single commit message according to Conventional Commits.
 * Any non-empty commit triggers at least a 'patch' bump so every update gets a version.
 * @param {string} subject
 * @param {string} [body]
 * @returns {'major' | 'minor' | 'patch'}
 */
export function classifyCommit(subject, body = '') {
  const s = (subject || '').trim();
  const b = (body || '').trim();
  const combined = `${s}\n${b}`;

  if (
    /^[a-zA-Z0-9_-]+(?:\([^)]+\))?!:/.test(s) ||
    /(?:^|\n)BREAKING[- ]CHANGE\s*:/i.test(combined)
  ) {
    return 'major';
  }
  if (/^feat(?:\([^)]+\))?:/i.test(s)) {
    return 'minor';
  }
  return 'patch';
}

/**
 * Determine the highest bump level across a list of commits.
 * @param {CommitEntry[]} commits
 * @returns {'major' | 'minor' | 'patch' | 'none'}
 */
export function classifyCommits(commits) {
  if (!commits || commits.length === 0) return 'none';
  let level = 'patch';
  for (const c of commits) {
    const k = classifyCommit(c.subject, c.body);
    if (k === 'major') return 'major';
    if (k === 'minor') level = 'minor';
  }
  return level;
}

/**
 * Pick the highest SemVer entry from an array of tag strings.
 * @param {string[]} tagNames
 * @returns {SemverInfo | null}
 */
export function pickLatestSemverTag(tagNames) {
  let best = null;
  for (const name of tagNames) {
    const parsed = parseSemver(name);
    if (!parsed) continue;
    if (!best || compareSemver(parsed, best) > 0) {
      best = parsed;
    }
  }
  return best;
}

/**
 * Pure version resolution function (testable without spawning git).
 *
 * @param {{
 *   pkgVersion?: string;
 *   headTags?: string[];
 *   mergedTags?: string[];
 *   allRepoTags?: string[];
 *   commitsSincePrevTag?: CommitEntry[];
 *   commitsSincePkgChange?: CommitEntry[];
 *   pkgChangedAtHead?: boolean;
 *   overrideVersion?: string;
 *   overrideBump?: string;
 *   prNumber?: string | number | null;
 *   commitSha?: string;
 * }} params
 */
export function resolveReleaseVersion(params) {
  const pkgSemver = parseSemver(params.pkgVersion) ?? {
    major: 1,
    minor: 0,
    patch: 0,
    version: '1.0.0',
    tag: 'v1.0.0',
  };
  const headTags = (params.headTags ?? []).map(parseSemver).filter(Boolean);
  const mergedLatest = pickLatestSemverTag(params.mergedTags ?? []);
  const allRepoTagSet = new Set(
    (params.allRepoTags ?? [])
      .map(parseSemver)
      .filter(Boolean)
      .map((s) => s.tag)
  );
  const overrideBumpRaw = (params.overrideBump ?? 'auto').trim().toLowerCase();
  const overrideRaw = (params.overrideVersion ?? '').trim();
  const overrideVer = overrideRaw ? parseSemver(overrideRaw) : null;
  if (overrideRaw && !overrideVer) {
    throw new Error(`Invalid explicit SemVer version: "${overrideRaw}" (expected X.Y.Z or vX.Y.Z)`);
  }
  const prNum =
    params.prNumber !== undefined && params.prNumber !== null && String(params.prNumber).trim() !== ''
      ? String(params.prNumber).trim()
      : null;

  const commitSha = (params.commitSha ?? '').trim();
  const shortSha = commitSha ? commitSha.slice(0, 8) : '';

  const ensureUniqueTag = (candidate) => {
    let cur = candidate;
    while (allRepoTagSet.has(cur.tag)) {
      cur = bumpSemver(cur, 'patch');
    }
    return cur;
  };

  /** @type {SemverInfo} */
  let resolved;
  /** @type {BumpKind} */
  let bump;
  let alreadyTagged = false;

  if (overrideVer) {
    resolved = overrideVer;
    bump = 'manual';
    alreadyTagged = headTags.some((t) => t.tag === resolved.tag);
  } else if (headTags.length > 0 && (overrideBumpRaw === 'auto' || !overrideBumpRaw)) {
    resolved = pickLatestSemverTag(headTags.map((t) => t.tag)) ?? headTags[0];
    bump = 'existing';
    alreadyTagged = true;
  } else if (mergedLatest) {
    if (
      (overrideBumpRaw === 'auto' || !overrideBumpRaw) &&
      compareSemver(pkgSemver, mergedLatest) > 0
    ) {
      resolved = ensureUniqueTag(pkgSemver);
      bump = 'manual';
    } else if (overrideBumpRaw === 'major' || overrideBumpRaw === 'minor' || overrideBumpRaw === 'patch') {
      const base = headTags.length > 0 ? pickLatestSemverTag(headTags.map((t) => t.tag)) ?? mergedLatest : mergedLatest;
      resolved = ensureUniqueTag(bumpSemver(base, overrideBumpRaw));
      bump = overrideBumpRaw;
    } else {
      const commits = params.commitsSincePrevTag ?? [];
      if (commits.length === 0) {
        resolved = mergedLatest;
        bump = 'none';
      } else {
        const autoBump = classifyCommits(commits);
        resolved = ensureUniqueTag(bumpSemver(mergedLatest, autoBump === 'none' ? 'patch' : autoBump));
        bump = autoBump;
      }
    }
  } else {
    // No SemVer tags exist yet in repository history
    if (overrideBumpRaw === 'major' || overrideBumpRaw === 'minor' || overrideBumpRaw === 'patch') {
      resolved = ensureUniqueTag(bumpSemver(pkgSemver, overrideBumpRaw));
      bump = overrideBumpRaw;
    } else if (params.pkgChangedAtHead) {
      resolved = ensureUniqueTag(pkgSemver);
      bump = 'manual';
    } else {
      const commits = params.commitsSincePkgChange ?? [];
      if (commits.length === 0) {
        resolved = ensureUniqueTag(pkgSemver);
        bump = 'manual';
      } else {
        const autoBump = classifyCommits(commits);
        resolved = ensureUniqueTag(bumpSemver(pkgSemver, autoBump === 'none' ? 'patch' : autoBump));
        bump = autoBump;
      }
    }
  }

  const prevTagSemver = pickLatestSemverTag(
    (params.mergedTags ?? []).filter((t) => {
      const parsed = parseSemver(t);
      return parsed !== null && compareSemver(parsed, resolved) < 0;
    })
  );
  const prevTag = prevTagSemver ? prevTagSemver.tag : '';

  const displayVersion = prNum ? `${resolved.version}-pr.${prNum}` : resolved.version;
  const displayTag = prNum ? `pr-${prNum}` : resolved.tag;

  return {
    version: displayVersion,
    baseVersion: resolved.version,
    tag: displayTag,
    releaseTag: resolved.tag,
    prevTag,
    bump,
    alreadyTagged,
    commitSha,
    shortSha,
  };
}

function tryGit(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse git log formatted with %H\x1f%s\x1f%b\x1e.
 * @param {string | null} raw
 * @returns {CommitEntry[]}
 */
export function parseGitLogOutput(raw) {
  if (!raw) return [];
  const entries = [];
  for (const record of raw.split('\x1e')) {
    const cleaned = record.trim();
    if (!cleaned) continue;
    const [sha = '', subject = '', ...bodyParts] = cleaned.split('\x1f');
    const body = bodyParts.join('\x1f').trim();
    if (sha || subject) {
      entries.push({ sha: sha.trim(), subject: subject.trim(), body });
    }
  }
  return entries;
}

function readRootPkgVersion(cwd) {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function resolveFromGitRepo(cwd, options = {}) {
  const shaInput = (options.sha ?? '').trim();
  const targetSha = shaInput || tryGit(cwd, ['rev-parse', 'HEAD']) || '';
  const ref = targetSha || 'HEAD';

  const headTagsRaw = tryGit(cwd, ['tag', '--points-at', ref, '--list', 'v[0-9]*.[0-9]*.[0-9]*']) ?? '';
  const mergedTagsRaw = tryGit(cwd, ['tag', '--merged', ref, '--list', 'v[0-9]*.[0-9]*.[0-9]*']) ?? '';
  const allTagsRaw = tryGit(cwd, ['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*']) ?? '';

  const splitLines = (s) =>
    s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);

  const headTags = splitLines(headTagsRaw);
  const mergedTags = splitLines(mergedTagsRaw);
  const allRepoTags = splitLines(allTagsRaw);
  const latestMerged = pickLatestSemverTag(mergedTags);

  let commitsSincePrevTag = [];
  if (latestMerged) {
    const logOut = tryGit(cwd, [
      'log',
      '--format=%H%x1f%s%x1f%b%x1e',
      `${latestMerged.tag}..${ref}`,
    ]);
    commitsSincePrevTag = parseGitLogOutput(logOut);
  }

  let pkgChangedAtHead = false;
  let commitsSincePkgChange = [];
  if (!latestMerged) {
    const pkgLastSha = tryGit(cwd, ['log', '-n', '1', '--format=%H', ref, '--', 'package.json']);
    if (pkgLastSha && targetSha && pkgLastSha === targetSha) {
      pkgChangedAtHead = true;
    } else if (pkgLastSha) {
      const logOut = tryGit(cwd, [
        'log',
        '--format=%H%x1f%s%x1f%b%x1e',
        `${pkgLastSha}..${ref}`,
      ]);
      commitsSincePkgChange = parseGitLogOutput(logOut);
    } else {
      const logOut = tryGit(cwd, ['log', '-n', '1', '--format=%H%x1f%s%x1f%b%x1e', ref]);
      commitsSincePkgChange = parseGitLogOutput(logOut);
    }
  }

  return resolveReleaseVersion({
    pkgVersion: readRootPkgVersion(cwd),
    headTags,
    mergedTags,
    allRepoTags,
    commitsSincePrevTag,
    commitsSincePkgChange,
    pkgChangedAtHead,
    overrideVersion: options.version,
    overrideBump: options.bump,
    prNumber: options.pr,
    commitSha: targetSha,
  });
}

export function stampServiceWorker(swPath, version, shortSha = '') {
  const raw = fs.readFileSync(swPath, 'utf8');
  const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, '-');
  const safeSha = shortSha ? `-${shortSha.replace(/[^a-zA-Z0-9._-]/g, '')}` : '';
  const cacheName = `antigravity-chat-shell-v${safeVer}${safeSha}`;
  const header = `// Build: v${version}${shortSha ? ` (${shortSha})` : ''}`;

  let next = raw.replace(/^\/\/ Build:.*\r?\n/, '');
  next = next.replace(
    /const CACHE_NAME\s*=\s*['"][^'"]+['"];/,
    `const CACHE_NAME = '${cacheName}';`
  );
  next = `${header}\n${next}`;
  fs.writeFileSync(swPath, next, 'utf8');
  return { cacheName };
}

export function stampManifests(stageDir, version) {
  const candidates = [
    path.join(stageDir, 'package.json'),
    path.join(stageDir, 'server', 'package.json'),
    path.join(stageDir, 'web', 'package.json'),
  ];
  const updated = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    updated.push(file);
  }
  return updated;
}

export function writeBuildInfo({ outPath, version, tag, commitSha, files = [], builtAt }) {
  const hash = crypto.createHash('sha256');
  hash.update(commitSha || '');
  hash.update(version || '');
  for (const f of files) {
    if (f && fs.existsSync(f)) {
      hash.update(fs.readFileSync(f));
    }
  }
  const buildId = hash.digest('hex').slice(0, 16);
  const info = {
    version,
    tag,
    commitSha,
    shortSha: commitSha ? commitSha.slice(0, 8) : '',
    buildId,
    builtAt: builtAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return info;
}

export function buildReleaseNotes({
  cwd = process.cwd(),
  version,
  tag,
  prevTag = '',
  commitSha = '',
  buildId = '',
  generatedBody = '',
}) {
  const lines = [
    `## Release ${tag}`,
    '',
    `- **Version**: \`${version}\``,
    ...(commitSha ? [`- **Commit**: \`${commitSha}\``] : []),
    ...(buildId ? [`- **Build ID**: \`${buildId}\``] : []),
    `- **Bundle**: \`antigravity-chat-bundle.tar.gz\` (pure-JS server + Vite SPA, ARM64/x64 compatible)`,
    '',
  ];

  const cleanGen = (generatedBody || '').trim();
  if (cleanGen) {
    lines.push(cleanGen);
  } else {
    const range = prevTag ? `${prevTag}..${commitSha || 'HEAD'}` : (commitSha || 'HEAD');
    const logArgs = prevTag
      ? ['log', '--no-merges', '--format=- %s (`%h`)', range]
      : ['log', '--no-merges', '-n', '20', '--format=- %s (`%h`)', range];
    const commitsText = tryGit(cwd, logArgs);
    if (commitsText) {
      lines.push('### Changes', '', commitsText);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const positionals = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i += 1;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? 'resolve', flags };
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();

  if (command === 'resolve') {
    const res = resolveFromGitRepo(cwd, {
      sha: typeof flags.sha === 'string' ? flags.sha : '',
      bump: typeof flags.bump === 'string' ? flags.bump : 'auto',
      version: typeof flags.version === 'string' ? flags.version : '',
      pr: typeof flags.pr === 'string' ? flags.pr : '',
    });

    if (typeof flags['github-output'] === 'string' && flags['github-output']) {
      const outputLines = [
        `version=${res.version}`,
        `base_version=${res.baseVersion}`,
        `tag=${res.tag}`,
        `release_tag=${res.releaseTag}`,
        `prev_tag=${res.prevTag}`,
        `bump=${res.bump}`,
        `already_tagged=${res.alreadyTagged ? 'true' : 'false'}`,
        `commit_sha=${res.commitSha}`,
        `short_sha=${res.shortSha}`,
      ];
      fs.appendFileSync(flags['github-output'], `${outputLines.join('\n')}\n`, 'utf8');
    }

    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (command === 'stamp-sw') {
    const file = typeof flags.file === 'string' ? flags.file : '';
    const version = typeof flags.version === 'string' ? flags.version : '';
    const shortSha = typeof flags.sha === 'string' ? flags.sha.slice(0, 8) : '';
    if (!file || !version) {
      throw new Error('stamp-sw requires --file and --version');
    }
    const result = stampServiceWorker(file, version, shortSha);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'stamp-manifests') {
    const dir = typeof flags.dir === 'string' ? flags.dir : '';
    const version = typeof flags.version === 'string' ? flags.version : '';
    if (!dir || !version) {
      throw new Error('stamp-manifests requires --dir and --version');
    }
    const updated = stampManifests(dir, version);
    process.stdout.write(`${JSON.stringify({ updated })}\n`);
    return;
  }

  if (command === 'write-build-info') {
    const outPath = typeof flags.out === 'string' ? flags.out : '';
    const version = typeof flags.version === 'string' ? flags.version : '';
    const tag = typeof flags.tag === 'string' ? flags.tag : version ? `v${version}` : '';
    const commitSha = typeof flags.sha === 'string' ? flags.sha : '';
    const filesRaw = typeof flags.files === 'string' ? flags.files : '';
    if (!outPath || !version) {
      throw new Error('write-build-info requires --out and --version');
    }
    const files = filesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const info = writeBuildInfo({ outPath, version, tag, commitSha, files });
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  if (command === 'notes') {
    const version = typeof flags.version === 'string' ? flags.version : '';
    const tag = typeof flags.tag === 'string' ? flags.tag : version ? `v${version}` : '';
    const prevTag = typeof flags['prev-tag'] === 'string' ? flags['prev-tag'] : '';
    const commitSha = typeof flags.sha === 'string' ? flags.sha : '';
    const buildId = typeof flags['build-id'] === 'string' ? flags['build-id'] : '';
    const genFile = typeof flags['generated-file'] === 'string' ? flags['generated-file'] : '';
    const out = typeof flags.out === 'string' ? flags.out : '';
    if (!version || !tag) {
      throw new Error('notes requires --version and --tag');
    }
    const generatedBody = genFile && fs.existsSync(genFile) ? fs.readFileSync(genFile, 'utf8') : '';
    const md = buildReleaseNotes({ cwd, version, tag, prevTag, commitSha, buildId, generatedBody });
    if (out) {
      fs.writeFileSync(out, md, 'utf8');
    } else {
      process.stdout.write(md);
    }
    return;
  }

  throw new Error(`Unknown subcommand: ${command}`);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main();
}
