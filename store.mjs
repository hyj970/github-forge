// store.mjs — the forge's state: the seeded scenario derivation (wire.ts's
// Rng, re-implemented exactly) and the in-memory domain model: repositories,
// objects, refs, issues, pull requests, labels, comments.
//
// Determinism: no wall clock, no unseeded randomness. Server-created commits
// use FIXED_EPOCH_SEC; created_at/updated_at/merged_at are fixed ISO strings;
// ordering falls back to monotonic per-repo sequence numbers.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
} from './gitcore.mjs';

/** Fixed timestamp for every server-created commit (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH_SEC = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------- scenario derivation (wire.ts, exact)

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value) {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label) {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state;
  constructor(seed) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64() {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32() {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick(items) {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
const REPO_ADJECTIVES = ['amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat', 'vivid', 'warm', 'witty', 'young', 'zesty'];
const REPO_NOUNS = ['acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr'];

function generateUsers(rng, count) {
  const used = new Set();
  const users = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The scenario's identities, derived from the fixed seed at startup. */
export function deriveScenario() {
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  const orgRng = new Rng(scenarioSeedFor('org'));
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  return { viewer: users[0], teammate: users[1], stranger: users[2], users, org };
}

// ---------------------------------------------------------------- global ids

/** Opaque, stable Relay-style global id: base64 of `Type:key`. */
export function globalId(type, key) {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Deterministic numeric database id for a repo: 5000 + hash(owner/name). */
export function repoDatabaseId(owner, name) {
  let hash = 0xcbf29ce484222325n;
  const text = `${owner}/${name}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return 5000 + Number(hash % 900000n);
}

// ---------------------------------------------------------------- helpers

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0x0a) count += 1;
  if (buffer[buffer.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Flatten a tree (by oid) into path -> {mode, oid}; missing tree = {}. */
function flattenTree(repo, treeOid, prefix, out) {
  if (!treeOid || !isObjectId(treeOid)) return out;
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build trees bottom-up from a flat path -> {mode, oid} map. Returns root oid. */
function buildTreeFromFlat(repo, flat) {
  const put = (type, data) => {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  };
  const buildDir = (prefix) => {
    const entries = [];
    const subdirs = new Map();
    for (const [path, file] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, true);
      }
    }
    for (const dir of subdirs.keys()) {
      entries.push({ mode: '40000', name: dir, oid: buildDir(prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return put('tree', buildTree(entries));
  };
  return buildDir('');
}

/** Diff two flat file maps: [{path, status, additions, deletions, changes}]. */
function diffFlat(baseFlat, headFlat, repo) {
  const files = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base && head && base.oid === head.oid) continue;
    if (!base) {
      const data = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (!head) {
      const data = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const baseData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const headData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(headData);
      const deletions = countLines(baseData);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

// ---------------------------------------------------------------- the store

export class Store {
  constructor() {
    this.scenario = deriveScenario();
    this.viewer = this.scenario.viewer;
    /** key `${owner}/${name}` -> repo */
    this.repos = new Map();
    /** viewer's repos in creation order (for GET /user/repos) */
    this.viewerRepos = [];
    this.commentSeq = 1;
    this.requestSeq = 0;
  }

  nextRequestId() {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  viewerIdentity() {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  // ---------------------------------------------------------- repos

  getRepo(owner, name) {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  createRepo(owner, name, { description = '', isPrivate = false } = {}) {
    if (this.repos.has(`${owner}/${name}`)) return { error: 'already exists' };
    const databaseId = repoDatabaseId(owner, name);
    const repo = {
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      databaseId,
      id: globalId('Repository', `${owner}/${name}`),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      issueCache: new Map(), // number -> serialized issue JSON (read-bench fast path)
      packCache: new Map(), // fetch key -> pack Buffer
      seq: 0, // creation sequence for issues/PRs ordering
    };
    this.repos.set(`${owner}/${name}`, repo);
    if (owner === this.viewer.login) this.viewerRepos.push(repo);
    return { repo };
  }

  deleteRepo(owner, name) {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(`${owner}/${name}`);
    const index = this.viewerRepos.indexOf(repo);
    if (index >= 0) this.viewerRepos.splice(index, 1);
    return true;
  }

  repoJson(repo) {
    return {
      id: repo.databaseId,
      node_id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: this.viewer.id, node_id: globalId('User', repo.owner), type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
    };
  }

  // ---------------------------------------------------------- git objects / refs

  putObject(repo, type, data) {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo) {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo, ref) {
    return repo.refs.get(ref) ?? null;
  }

  /** All refs sorted by name: [{name, oid}]. */
  listRefs(repo) {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  headTarget(repo) {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a ref name, branch name or sha to a commit oid (or null). */
  resolveRef(repo, ref) {
    if (!ref) return this.refTip(repo, this.headTarget(repo));
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = `refs/heads/${ref}`;
    if (repo.refs.has(branch)) return repo.refs.get(branch);
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** Create a commit on a branch from a flat file map; returns the commit oid. */
  commitFiles(repo, branch, files, message, parentOverride) {
    const parent = parentOverride !== undefined ? parentOverride : this.refTip(repo, `refs/heads/${branch}`);
    const baseTree = parent ? parseCommit(repo.objects.get(parent).data).tree : null;
    const flat = flattenTree(repo, baseTree, '', new Map());
    for (const [path, data] of files) {
      if (data === null) flat.delete(path);
      else flat.set(path, { mode: '100644', oid: this.putObject(repo, 'blob', data) });
    }
    const treeOid = buildTreeFromFlat(repo, flat);
    const parents = parent ? [parent] : [];
    const identity = this.viewerIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: identity,
      committer: identity,
      timestamp: FIXED_EPOCH_SEC,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.packCache.clear();
    return { commitOid, treeOid };
  }

  /** The flat file map at a commit oid. */
  filesAt(repo, commitOid) {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(repo, parseCommit(object.data).tree, '', new Map());
  }

  /** Commits reachable from `tip`, newest first. */
  commitsFrom(repo, tip) {
    const out = [];
    const seen = new Set();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift();
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // ---------------------------------------------------------- contents

  /** PUT /contents: create or update a file on a branch. Returns {status, body} or {status, error}. */
  putContents(repo, path, content, message, branch, sha) {
    const targetBranch = branch ?? repo.defaultBranch;
    let tip = this.refTip(repo, `refs/heads/${targetBranch}`);
    if (!tip) {
      // A missing branch is created from the default branch's tip (or unborn).
      const baseTip = this.refTip(repo, this.headTarget(repo));
      if (targetBranch !== repo.defaultBranch && !baseTip) {
        // No default tip either: the branch starts unborn.
        tip = null;
      } else if (targetBranch !== repo.defaultBranch) {
        tip = baseTip;
      }
    }
    const flat = tip ? this.filesAt(repo, tip) : new Map();
    const existing = flat.get(path);
    const blobOid = hashObject('blob', content);
    if (existing) {
      if (!sha || sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { status: 409, error: 'sha does not match the current blob' };
      }
      if (existing.oid === blobOid) {
        // No change: still a new commit in GitHub's behaviour; keep it simple
        // and write the commit (the checks never do a no-op update).
      }
    }
    const { commitOid } = this.commitFiles(repo, targetBranch, [[path, content]], message, tip);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blobOid,
          size: content.length,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: commitOid, message },
      },
    };
  }

  /** GET /contents: file object, directory listing, or null when missing. */
  getContents(repo, path, ref) {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const flat = this.filesAt(repo, tip);
    const file = flat.get(path);
    if (file) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      return {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: file.oid,
        size: data.length,
        name: path.split('/').pop(),
        path,
      };
    }
    // Directory? ('' is the root.)
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map();
    for (const [filePath, entry] of flat) {
      if (prefix !== '' && !filePath.startsWith(prefix)) continue;
      const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.set(rest, { type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!entries.has(dir)) {
          const dirOid = this.dirOid(repo, tip, prefix + dir);
          entries.set(dir, { type: 'dir', name: dir, path: prefix + dir, sha: dirOid ?? '' });
        }
      }
    }
    if (entries.size === 0) return null;
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  dirOid(repo, tip, dirPath) {
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    let treeOid = parseCommit(object.data).tree;
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === segment && e.mode === '40000');
      if (!entry) return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  /** DELETE /contents: remove a file with a commit. */
  deleteContents(repo, path, message, branch) {
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = this.refTip(repo, `refs/heads/${targetBranch}`);
    if (!tip) return { status: 404, error: 'branch not found' };
    const flat = this.filesAt(repo, tip);
    if (!flat.has(path)) return { status: 404, error: 'file not found' };
    const { commitOid } = this.commitFiles(repo, targetBranch, [[path, null]], message, tip);
    return { status: 200, body: { commit: { sha: commitOid, message } } };
  }

  // ---------------------------------------------------------- labels / issues

  createLabel(repo, name, color) {
    if (repo.labels.has(name)) return repo.labels.get(name);
    const label = { name, color: color ?? 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  issueJson(repo, issue) {
    return {
      id: repo.databaseId * 1000000 + issue.number,
      node_id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: '' };
      }),
      user: { login: this.viewer.login, id: this.viewer.id, node_id: globalId('User', this.viewer.login), type: 'User' },
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      comments: issue.comments.length,
    };
  }

  /** Cached serialized issue JSON (invalidated on mutation). */
  cachedIssueJson(repo, issue) {
    let cached = repo.issueCache.get(issue.number);
    if (!cached) {
      cached = JSON.stringify(this.issueJson(repo, issue));
      repo.issueCache.set(issue.number, cached);
    }
    return cached;
  }

  createIssue(repo, { title, body = '', labels = [] }) {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { status: 422, error: `label ${name} does not exist` };
    }
    const number = repo.nextNumber++;
    repo.seq += 1;
    const issue = {
      number,
      id: globalId('Issue', `${repo.owner}/${repo.name}:${number}`),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.seq,
    };
    repo.issues.push(issue);
    return { status: 201, issue };
  }

  getIssue(repo, number) {
    return repo.issues.find((i) => i.number === number) ?? null;
  }

  listIssues(repo, { state = 'open', sort = 'created', direction = 'desc' } = {}) {
    let list = repo.issues;
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const sorted = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return sorted;
  }

  // ---------------------------------------------------------- pull requests

  createPull(repo, { title, body = '', head, base }) {
    const headTip = this.refTip(repo, `refs/heads/${head}`);
    const baseTip = this.refTip(repo, `refs/heads/${base}`);
    if (!headTip) return { status: 422, error: `head branch ${head} does not exist` };
    if (!baseTip) return { status: 422, error: `base branch ${base} does not exist` };
    const dup = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
    if (dup) return { status: 422, error: 'a pull request already exists for this head branch' };
    const number = repo.nextNumber++;
    repo.seq += 1;
    const mergeBaseOid = mergeBase(headTip, baseTip, this.lookup(repo));
    const pull = {
      number,
      id: globalId('PullRequest', `${repo.owner}/${repo.name}:${number}`),
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      mergeBase: mergeBaseOid,
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    return { status: 201, pull };
  }

  getPull(repo, number) {
    return repo.pulls.find((p) => p.number === number) ?? null;
  }

  /** Files changed between the merge-base and the head tip. */
  pullFiles(repo, pull) {
    const baseFlat = pull.mergeBase ? this.filesAt(repo, pull.mergeBase) : new Map();
    const headFlat = this.filesAt(repo, pull.headSha);
    return diffFlat(baseFlat, headFlat, repo);
  }

  /** Is the PR conflicted against the CURRENT base tip? */
  pullConflicted(repo, pull) {
    const baseFlat = pull.mergeBase ? this.filesAt(repo, pull.mergeBase) : new Map();
    const headFlat = this.filesAt(repo, pull.headSha);
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const currentFlat = baseTip ? this.filesAt(repo, baseTip) : new Map();
    const headDiff = diffFlat(baseFlat, headFlat, repo);
    const baseDiff = diffFlat(baseFlat, currentFlat, repo);
    const baseChanged = new Map(baseDiff.map((f) => [f.filename, f]));
    for (const file of headDiff) {
      const other = baseChanged.get(file.filename);
      if (!other) continue;
      const headBlob = headFlat.get(file.filename)?.oid;
      const baseBlob = currentFlat.get(file.filename)?.oid;
      if (headBlob !== baseBlob) return true;
    }
    return false;
  }

  pullJson(repo, pull) {
    return {
      id: repo.databaseId * 1000000 + pull.number,
      node_id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body ?? '',
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.viewer.login, id: this.viewer.id, node_id: globalId('User', this.viewer.login), type: 'User' },
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
    };
  }

  /** Squash-merge a PR onto its base branch. Returns {status, body} or {status, error}. */
  mergePull(repo, pull, method = 'squash') {
    if (pull.state !== 'open') return { status: 405, error: 'pull request is not open' };
    if (this.pullConflicted(repo, pull)) return { status: 405, error: 'merge conflict' };
    const headTip = this.refTip(repo, `refs/heads/${pull.headRef}`);
    if (!headTip) return { status: 404, error: 'head branch not found' };
    const headFlat = this.filesAt(repo, headTip);
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const treeOid = buildTreeFromFlat(repo, headFlat);
    const identity = this.viewerIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: baseTip ? [baseTip] : [],
      message: pull.title,
      author: identity,
      committer: identity,
      timestamp: FIXED_EPOCH_SEC,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    repo.packCache.clear();
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_ISO;
    pull.merge_commit_sha = mergeSha;
    return { status: 200, body: { sha: mergeSha, merged: true, message: pull.title } };
  }

  listPulls(repo, { state = 'open' } = {}) {
    let list = repo.pulls;
    if (state !== 'all') list = list.filter((p) => p.state === state);
    return [...list].sort((a, b) => b.seq - a.seq);
  }
}
