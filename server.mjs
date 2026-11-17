// server.mjs — the forge's HTTP server: routing, auth, REST v3, GraphQL v4,
// MCP, and git smart HTTP (upload-pack v2/v0, receive-pack v0).
//
// Plain Node.js stdlib only. Deterministic: no wall clock, no unseeded
// randomness in anything stored or sent (see store.mjs).

import { createServer } from 'node:http';
import { Store, FIXED_ISO, DEFAULT_BRANCH, globalId } from './store.mjs';
import { executeGraphQL } from './graphql.mjs';
import { handleMcp } from './mcp.mjs';
import {
  ZERO_OID,
  isObjectId,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  FLUSH,
  DELIM,
  computeFetch,
  readPack,
  writePack,
  parseCommit,
  peelToCommit,
} from './gitcore.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-forge/1.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------- small helpers

function sendJson(res, store, status, body, extraHeaders = {}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res, store, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function jsonError(res, store, status, message) {
  sendJson(res, store, status, { message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buffer) {
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString('utf8'));
}

/** Exact-match against MAKEFUN_SHOP_TOKEN when set; any non-empty Bearer token in local dev. */
function isAuthorized(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (!presented) return false;
  if (TOKEN) return presented === TOKEN;
  return true;
}

function pathOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Paginate a list; returns {slice, link} with absolute same-origin Link URLs. */
function paginate(req, url, items, defaultPerPage = 30) {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || defaultPerPage));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const base = `${origin}${url.pathname}`;
  const qs = (p) => `${base}?per_page=${perPage}&page=${p}`;
  const links = [];
  if (page < pages) links.push(`<${qs(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${qs(page - 1)}>; rel="prev"`);
  if (page === 1 && pages > 1) links.push(`<${qs(pages)}>; rel="last"`);
  if (page > 1) links.push(`<${qs(1)}>; rel="first"`);
  return { slice, link: links.join(', ') };
}

// ---------------------------------------------------------------- pkt-line stream parsing

/** Decode pkt-lines one at a time until the first flush; returns {packets, consumed}. */
function decodePktStream(bytes) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line header');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------- git advertisements

function v0Advertisement(store, repo, service) {
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
    : `symref=HEAD:refs/heads/main agent=${AGENT}`;
  const parts = [encodePktLine(`# service=${service}\n`), FLUSH];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const lines = [];
    const headTip = store.refTip(repo, store.headTarget(repo));
    if (headTip) lines.push(`${headTip} HEAD\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const commit = peelToCommit(ref.oid, store.lookup(repo));
        if (commit !== ref.oid) lines.push(`${commit} ${ref.name}^{}\n`);
      }
    }
    // Capabilities ride on the first line, whatever it is.
    lines[0] = lines[0].replace(/\n$/, `\0${caps}\n`);
    parts.push(encodePktLines(lines));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(req, res, store, owner, repoName, service) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, store, 404, 'Not Found');
    return;
  }
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    const body = Buffer.concat([
      encodePktLine('# service=git-upload-pack\n'),
      FLUSH,
      encodePktLines(['version 2\n', `agent=${AGENT}\n`, 'object-format=sha1\n', 'ls-refs=unborn\n', 'fetch=shallow\n']),
      FLUSH,
    ]);
    sendBuffer(res, store, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const body = v0Advertisement(store, repo, service);
  sendBuffer(res, store, 200, body, `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- upload-pack

/** Parse a v2 request body into {command, args}. Throws on malformed input. */
function parseV2Request(body) {
  const { packets } = decodePktStream(body);
  let seenFlush = false;
  let pastDelim = false;
  const pre = [];
  const post = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') { pastDelim = true; continue; }
    if (packet.kind === 'flush') { seenFlush = true; break; }
    (pastDelim ? post : pre).push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (!seenFlush || pre.length === 0) throw new Error('malformed v2 request');
  const commandLine = pre[0];
  if (!commandLine.startsWith('command=')) throw new Error('v2 request has no command');
  return { command: commandLine.slice('command='.length), args: post };
}

function handleLsRefs(store, repo, args) {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const match = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines = [];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    if (match('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    const headTip = store.refTip(repo, store.headTarget(repo));
    if (headTip && match('HEAD')) {
      lines.push(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of refs) {
      if (!match(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      const object = repo.objects.get(ref.oid);
      if (peel && object?.type === 'tag') {
        const commit = peelToCommit(ref.oid, store.lookup(repo));
        if (commit !== ref.oid) line += ` peeled:${commit}`;
      }
      lines.push(`${line}\n`);
    }
  }
  return Buffer.concat([encodePktLines(lines), FLUSH]);
}

function handleFetchV2(store, repo, args) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n)) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not: parsed, not needed.
  }
  const lookup = store.lookup(repo);
  const cacheKey = JSON.stringify([wants.slice().sort(), haves.slice().sort(), shallow.slice().sort(), depth ?? null]);
  let cached = repo.packCache.get(cacheKey);
  if (!cached) {
    const result = computeFetch(wants, haves, shallow, depth, lookup);
    const objects = result.sendObjects
      .map((oid) => repo.objects.get(oid))
      .filter((o) => o)
      .map((o) => ({ type: o.type, data: o.data }));
    cached = {
      pack: writePack(objects),
      newShallow: result.newShallow,
      unshallow: result.unshallow,
      acks: result.acks,
    };
    repo.packCache.set(cacheKey, cached);
  }
  const result = cached;

  const parts = [];
  // acknowledgments
  const ackLines = ['acknowledgments\n'];
  if (result.acks.length) {
    for (const ack of result.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(encodePktLines(ackLines), DELIM);
  // shallow-info, only when non-empty
  if (result.newShallow.length || result.unshallow.length) {
    const lines = ['shallow-info\n'];
    for (const oid of result.newShallow) lines.push(`shallow ${oid}\n`);
    for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(lines), DELIM);
  }
  // packfile (always present, at least one sideband packet)
  parts.push(encodePktLine('packfile\n'), encodeSideband(1, result.pack), DELIM, FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(store, repo, body) {
  // v0: wants section, flush, haves section, flush.
  const { packets: first, consumed } = decodePktStream(body);
  const rest = body.subarray(consumed);
  const second = rest.length ? decodePktStream(rest).packets : [];
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth;
  const scan = (packets) => {
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n)) depth = n;
      }
    }
  };
  scan(first);
  scan(second);
  const result = computeFetch(wants, haves, shallow, depth, store.lookup(repo));
  const objects = result.sendObjects
    .map((oid) => repo.objects.get(oid))
    .filter((o) => o)
    .map((o) => ({ type: o.type, data: o.data }));
  const pack = writePack(objects);
  const lines = [];
  if (result.acks.length) for (const ack of result.acks) lines.push(`ACK ${ack}\n`);
  else lines.push('NAK\n');
  for (const oid of result.newShallow) lines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
  return Buffer.concat([encodePktLines(lines), encodeSideband(1, pack), FLUSH]);
}

async function handleUploadPack(req, res, store, owner, repoName, body) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, store, 404, 'Not Found');
    return;
  }
  try {
    if (req.headers['git-protocol'] === 'version=2') {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        sendBuffer(res, store, 200, handleLsRefs(store, repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        sendBuffer(res, store, 200, handleFetchV2(store, repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      jsonError(res, store, 400, `unknown upload-pack command ${command}`);
      return;
    }
    sendBuffer(res, store, 200, handleFetchV0(store, repo, body), 'application/x-git-upload-pack-result');
  } catch (err) {
    jsonError(res, store, 400, `malformed upload-pack request: ${err.message}`);
  }
}

// ---------------------------------------------------------------- receive-pack

async function handleReceivePack(req, res, store, owner, repoName, body) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, store, 404, 'Not Found');
    return;
  }
  let commands = [];
  let packBytes = Buffer.alloc(0);
  let unpackError = null;
  try {
    const { packets, consumed } = decodePktStream(body);
    packBytes = body.subarray(consumed);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length !== 3) throw new Error('malformed receive-pack command');
      const [oldOid, newOid, ref] = parts;
      if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
        throw new Error('malformed receive-pack command');
      }
      commands.push({ oldOid, newOid, ref });
    }
    if (commands.length === 0) throw new Error('empty receive-pack command list');
  } catch (err) {
    unpackError = err.message;
  }

  // Store the pack first (unpack must succeed even when a ref is refused).
  let packObjects = null;
  if (!unpackError && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      packObjects = read.objects;
    } catch (err) {
      unpackError = err.message;
    }
  }
  if (!unpackError && packBytes.length === 0 && commands.some((c) => c.newOid !== ZERO_OID)) {
    unpackError = 'a pack is required for a create or update';
  }
  if (packObjects) {
    for (const [oid, object] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  const reportLines = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    let changed = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      let problem = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) problem = 'remote ref does not exist';
        else if (command.oldOid !== current) problem = 'old value does not match';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) problem = 'already exists';
        else if (!repo.objects.has(command.newOid)) problem = 'object not found';
      } else {
        // Update: fast-forward only for branches; tags move freely.
        if (current === null) problem = 'remote ref does not exist';
        else if (command.oldOid !== current) problem = 'old value does not match';
        else if (!repo.objects.has(command.newOid)) problem = 'object not found';
        else if (command.ref.startsWith('refs/heads/') && !isFastForward(command.oldOid, command.newOid, store.lookup(repo))) problem = 'non-fast-forward';
      }
      if (problem) {
        reportLines.push(`ng ${command.ref} ${problem}\n`);
      } else {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        changed = true;
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
    if (changed) repo.packCache.clear();
  }
  const report = encodePktLines(reportLines);
  const bodyOut = Buffer.concat([encodeSideband(1, report), FLUSH]);
  sendBuffer(res, store, 200, bodyOut, 'application/x-git-receive-pack-result');
}

/** newOid must be a descendant of oldOid (or equal). */
function isFastForward(oldOid, newOid, lookup) {
  if (oldOid === newOid) return true;
  const seen = new Set();
  const queue = [newOid];
  while (queue.length) {
    const oid = queue.pop();
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- REST v3

function repoOr404(res, store, owner, name) {
  const repo = store.getRepo(owner, name);
  if (!repo) jsonError(res, store, 404, 'Not Found');
  return repo;
}

async function handleRest(req, res, store, segments, url) {
  const method = req.method ?? 'GET';
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
    ? await readBody(req)
    : Buffer.alloc(0);
  let json = {};
  if (body.length > 0) {
    try {
      json = parseJsonBody(body);
    } catch {
      jsonError(res, store, 400, 'malformed JSON body');
      return;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) json = {};
  }

  // /api/v3 and /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
    sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments[0] === 'meta') {
    if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
    sendJson(res, store, 200, { installed_version: '1.0.0' });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
    const viewer = store.viewer;
    sendJson(res, store, 200, { login: viewer.login, id: viewer.id, node_id: globalId('User', viewer.login), type: 'User', name: viewer.name, email: viewer.email });
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { slice, link } = paginate(req, url, store.viewerRepos.map((r) => store.repoJson(r)));
      sendJson(res, store, 200, slice, link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = typeof json.name === 'string' ? json.name : '';
      if (!name) { jsonError(res, store, 422, 'name is required'); return; }
      const created = store.createRepo(store.viewer.login, name, {
        description: typeof json.description === 'string' ? json.description : '',
        isPrivate: json.private === true,
      });
      if (created.error) {
        jsonError(res, store, 422, `Repository ${name} already exists`);
        return;
      }
      sendJson(res, store, 201, store.repoJson(created.repo));
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }
  if (segments[0] !== 'repos' || segments.length < 3) {
    jsonError(res, store, 404, 'Not Found');
    return;
  }
  const [owner, repoName] = [segments[1], segments[2]];
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = repoOr404(res, store, owner, repoName);
      if (repo) sendJson(res, store, 200, store.repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const repo = repoOr404(res, store, owner, repoName);
      if (!repo) return;
      if (typeof json.description === 'string') repo.description = json.description;
      if (typeof json.private === 'boolean') repo.private = json.private;
      sendJson(res, store, 200, store.repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      if (!store.deleteRepo(owner, repoName)) { jsonError(res, store, 404, 'Not Found'); return; }
      res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
      res.end();
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  const repo = repoOr404(res, store, owner, repoName);
  if (!repo) return;

  // branches
  if (rest[0] === 'branches') {
    if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
    if (rest.length === 1) {
      const branches = store.listRefs(repo)
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid } }));
      sendJson(res, store, 200, branches);
      return;
    }
    const branch = rest.slice(1).join('/');
    const tip = store.refTip(repo, `refs/heads/${branch}`);
    if (!tip) { jsonError(res, store, 404, 'Not Found'); return; }
    sendJson(res, store, 200, { name: branch, commit: { sha: tip } });
    return;
  }

  // commits
  if (rest[0] === 'commits') {
    if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
    const tip = store.resolveRef(repo, url.searchParams.get('sha'));
    if (!tip) { sendJson(res, store, 200, []); return; }
    const commits = store.commitsFrom(repo, tip).map((oid) => {
      const object = repo.objects.get(oid);
      const message = object ? parseCommit(object.data).message : '';
      return { sha: oid, commit: { message } };
    });
    sendJson(res, store, 200, commits);
    return;
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof json.ref === 'string' ? json.ref : '';
      const sha = typeof json.sha === 'string' ? json.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) { jsonError(res, store, 422, 'ref and sha are required'); return; }
      if (repo.refs.has(ref)) { jsonError(res, store, 422, 'Reference already exists'); return; }
      if (!repo.objects.has(sha)) { jsonError(res, store, 422, 'object not found'); return; }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      sendJson(res, store, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const tip = repo.refs.get(ref);
      if (!tip) { jsonError(res, store, 404, 'Not Found'); return; }
      sendJson(res, store, 200, { ref, object: { sha: tip } });
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  // contents
  if (rest[0] === 'contents') {
    const contentPath = decodeURIComponent(rest.slice(1).join('/'));
    if (method === 'PUT') {
      if (typeof json.content !== 'string' || typeof json.message !== 'string') {
        jsonError(res, store, 422, 'content and message are required');
        return;
      }
      const content = Buffer.from(json.content, 'base64');
      const result = store.putContents(repo, contentPath, content, json.message, json.branch, json.sha);
      if (result.status !== 200 && result.status !== 201) { jsonError(res, store, result.status, result.error); return; }
      sendJson(res, store, result.status, result.body);
      return;
    }
    if (method === 'GET') {
      const found = store.getContents(repo, contentPath, url.searchParams.get('ref'));
      if (found === null) { jsonError(res, store, 404, 'Not Found'); return; }
      sendJson(res, store, 200, found);
      return;
    }
    if (method === 'DELETE') {
      if (typeof json.message !== 'string' || typeof json.sha !== 'string') {
        jsonError(res, store, 422, 'message and sha are required');
        return;
      }
      const result = store.deleteContents(repo, contentPath, json.message, json.branch);
      if (result.status !== 200) { jsonError(res, store, result.status, result.error); return; }
      sendJson(res, store, 200, result.body);
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET') {
      sendJson(res, store, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      return;
    }
    if (method === 'POST') {
      const name = typeof json.name === 'string' ? json.name : '';
      if (!name) { jsonError(res, store, 422, 'name is required'); return; }
      const label = store.createLabel(repo, name, typeof json.color === 'string' ? json.color : undefined);
      sendJson(res, store, 201, { name: label.name, color: label.color, description: label.description });
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        const list = store.listIssues(repo, { state, sort, direction }).map((i) => store.issueJson(repo, i));
        const { slice, link } = paginate(req, url, list);
        sendJson(res, store, 200, slice, link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const title = typeof json.title === 'string' ? json.title : '';
        if (!title) { jsonError(res, store, 422, 'title is required'); return; }
        const labels = Array.isArray(json.labels)
          ? json.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
          : [];
        const created = store.createIssue(repo, { title, body: typeof json.body === 'string' ? json.body : '', labels });
        if (created.status !== 201) { jsonError(res, store, created.status, created.error); return; }
        sendJson(res, store, 201, store.issueJson(repo, created.issue));
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) { jsonError(res, store, 404, 'Not Found'); return; }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = store.getIssue(repo, number);
      if (!issue) { jsonError(res, store, 404, 'Not Found'); return; }
      if (method === 'GET') {
        sendJson(res, store, 200, issue.comments.map((c) => ({ id: c.seq, node_id: c.id, body: c.body })));
        return;
      }
      if (method === 'POST') {
        const bodyText = typeof json.body === 'string' ? json.body : '';
        const comment = {
          __typename: 'IssueComment',
          id: globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${store.commentSeq}`),
          body: bodyText,
          seq: store.commentSeq++,
        };
        issue.comments.push(comment);
        repo.issueCache.delete(issue.number);
        sendJson(res, store, 201, { id: comment.seq, node_id: comment.id, body: bodyText });
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    if (rest.length === 2) {
      const issue = store.getIssue(repo, number);
      if (!issue) { jsonError(res, store, 404, 'Not Found'); return; }
      if (method === 'GET') {
        // Fast path for the read benchmark: pre-serialized JSON.
        const text = store.cachedIssueJson(repo, issue);
        res.writeHead(200, {
          'content-type': JSON_TYPE,
          'content-length': Buffer.byteLength(text) + 1,
          'x-github-request-id': store.nextRequestId(),
        });
        res.end(`${text}\n`);
        return;
      }
      if (method === 'PATCH') {
        if (typeof json.title === 'string') issue.title = json.title;
        if (typeof json.body === 'string') issue.body = json.body;
        if (typeof json.state === 'string' && (json.state === 'open' || json.state === 'closed')) issue.state = json.state;
        if (Array.isArray(json.labels)) {
          issue.labels = json.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
        }
        repo.issueCache.delete(issue.number);
        sendJson(res, store, 200, store.issueJson(repo, issue));
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const list = store.listPulls(repo, { state }).map((p) => store.pullJson(repo, p));
        const { slice, link } = paginate(req, url, list);
        sendJson(res, store, 200, slice, link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const title = typeof json.title === 'string' ? json.title : '';
        const head = typeof json.head === 'string' ? json.head : '';
        const base = typeof json.base === 'string' ? json.base : '';
        if (!title || !head || !base) { jsonError(res, store, 422, 'title, head and base are required'); return; }
        const stripOwner = (ref) => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
        const created = store.createPull(repo, { title, body: typeof json.body === 'string' ? json.body : '', head: stripOwner(head), base: stripOwner(base) });
        if (created.status !== 201) { jsonError(res, store, created.status, created.error); return; }
        sendJson(res, store, 201, store.pullJson(repo, created.pull));
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) { jsonError(res, store, 404, 'Not Found'); return; }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
      const pull = store.getPull(repo, number);
      if (!pull) { jsonError(res, store, 404, 'Not Found'); return; }
      sendJson(res, store, 200, store.pullFiles(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') { jsonError(res, store, 404, 'Not Found'); return; }
      const pull = store.getPull(repo, number);
      if (!pull) { jsonError(res, store, 404, 'Not Found'); return; }
      const merged = store.mergePull(repo, pull, typeof json.merge_method === 'string' ? json.merge_method : 'squash');
      if (merged.status !== 200) { jsonError(res, store, merged.status, merged.error); return; }
      sendJson(res, store, 200, merged.body);
      return;
    }
    if (rest.length === 2) {
      if (method !== 'GET') { jsonError(res, store, 404, 'Not Found'); return; }
      const pull = store.getPull(repo, number);
      if (!pull) { jsonError(res, store, 404, 'Not Found'); return; }
      sendJson(res, store, 200, store.pullJson(repo, pull));
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  jsonError(res, store, 404, 'Not Found');
}

// ---------------------------------------------------------------- app

export function createApp() {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;

      // Health probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, store, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) {
        if (!isAuthorized(req)) { jsonError(res, store, 401, 'Unauthorized'); return; }
        const owner = gitMatch[1];
        let repoName = gitMatch[2];
        if (repoName.endsWith('.git')) repoName = repoName.slice(0, -4);
        const service = gitMatch[3] === 'info/refs' ? url.searchParams.get('service') : gitMatch[3];
        if (gitMatch[3] === 'info/refs') {
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            jsonError(res, store, 400, 'unknown service');
            return;
          }
          handleInfoRefs(req, res, store, owner, repoName, service);
          return;
        }
        const body = await readBody(req);
        if (gitMatch[3] === 'git-upload-pack') {
          await handleUploadPack(req, res, store, owner, repoName, body);
        } else {
          await handleReceivePack(req, res, store, owner, repoName, body);
        }
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') { jsonError(res, store, 404, 'Not Found'); return; }
        if (!isAuthorized(req)) { jsonError(res, store, 401, 'Unauthorized'); return; }
        const body = await readBody(req);
        let parsed;
        try {
          parsed = parseJsonBody(body);
        } catch {
          jsonError(res, store, 400, 'malformed JSON body');
          return;
        }
        sendJson(res, store, 200, executeGraphQL(store, parsed));
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method !== 'POST') { jsonError(res, store, 404, 'Not Found'); return; }
        if (!isAuthorized(req)) { jsonError(res, store, 401, 'Unauthorized'); return; }
        const body = await readBody(req);
        const outcome = handleMcp(store, body.toString('utf8'));
        res.writeHead(outcome.status, {
          'content-type': JSON_TYPE,
          'content-length': Buffer.byteLength(outcome.body),
          'x-github-request-id': store.nextRequestId(),
        });
        res.end(outcome.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!isAuthorized(req)) { jsonError(res, store, 401, 'Unauthorized'); return; }
        const segments = path.split('/').filter(Boolean).slice(2);
        await handleRest(req, res, store, segments, url);
        return;
      }

      jsonError(res, store, 404, 'Not Found');
    } catch (err) {
      // Never crash the process on a bad request; stay healthy.
      try {
        jsonError(res, store, 500, `internal error: ${err.message}`);
      } catch {
        try { res.end(); } catch { /* already closed */ }
      }
    }
  });
  return server;
}

export { FIXED_ISO, DEFAULT_BRANCH };
