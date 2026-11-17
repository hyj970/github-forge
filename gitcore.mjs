// gitcore.mjs — the git object layer: SHA-1, pkt-lines, tree/commit/tag
// parse/build, packfile read/write, reachability, and the fetch object
// selection the upload-pack v2/v0 handlers need.
//
// Plain Node.js stdlib only. No wall clock, no randomness: every byte this
// module produces is a pure function of its inputs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value) {
  return typeof value === 'string' && HEX40.test(value);
}

// ---------------------------------------------------------------- SHA-1

export function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- pkt-lines

export function encodePktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items) {
  const parts = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Sideband-framed pkt-line: band byte + payload, chunked at 65,500 bytes. */
export function encodeSideband(band, data) {
  const out = [];
  let offset = 0;
  do {
    const chunk = data.subarray(offset, offset + 65500);
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(encodePktLine(payload));
    offset += chunk.length;
  } while (offset < data.length);
  return Buffer.concat(out);
}

/** Decode a whole buffer of pkt-lines into [{kind, payload, raw}]. */
export function decodePktLines(bytes) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line header');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len), raw: bytes.subarray(offset, offset + len) });
    offset += len;
  }
  if (offset !== bytes.length) throw new Error('trailing bytes after pkt-lines');
  return packets;
}

// ---------------------------------------------------------------- trees

/** Compare two tree entry names the way git orders them (dirs as name + '/'). */
export function compareTreeNames(a, b) {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function parseTree(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export function parseCommit(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit({ tree, parents = [], message, author, committer, timestamp, timezone = '+0000' }) {
  const who = `${author} ${timestamp} ${timezone}`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer} ${timestamp} ${timezone}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTag(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------- packs

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), sorted by oid for determinism. */
export function writePack(objects) {
  const list = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer, start) {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer, start) {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer, offset) {
  const view = buffer.subarray(offset);
  let result;
  try {
    result = inflateSync(view, { info: true });
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err.message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base, delta) {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA/REF_DELTA.
 * `resolveBase(oid)` supplies a base object a thin pack leaves out.
 * Returns {version, declaredCount, objects: Map<oid, {type, data}>}.
 */
export function readPack(pack, options = {}) {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer does not match its bytes');

  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects };
}

// ---------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing. Throws on a missing
 * object unless `allowMissing` is set. `lookup(oid)` returns {type, data}.
 */
export function collectReachable(roots, lookup, options = {}) {
  const seen = new Set();
  const queue = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The object closure of a commit set: each commit itself, its tree (recursive)
 * and blobs, tag targets — but NOT parent commits (those enter only as roots).
 */
export function objectClosure(commits, lookup) {
  const out = new Set();
  const queue = [...commits];
  const seenCommits = new Set();
  while (queue.length) {
    const oid = queue.pop();
    if (!isObjectId(oid) || out.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      queue.push(object.data ? parseCommit(object.data).tree : '');
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

/** Peel a possibly-tag oid to its commit (following tag objects). */
export function peelToCommit(oid, lookup) {
  let current = oid;
  const guard = new Set();
  for (;;) {
    if (guard.has(current)) return current;
    guard.add(current);
    const object = lookup(current);
    if (!object) return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return current;
  }
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(ancestor, descendant, lookup) {
  if (ancestor === descendant) return true;
  const seen = new Set();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop();
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found by BFS from both. */
export function mergeBase(a, b, lookup) {
  if (!isObjectId(a) || !isObjectId(b)) return null;
  const ancA = new Set();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop();
    if (ancA.has(oid)) continue;
    ancA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set();
  while (queueB.length) {
    const oid = queueB.pop();
    if (ancA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- fetch selection

/**
 * Compute what a fetch sends.
 *
 * wants: tip oids the client wants. haves: oids the client holds.
 * shallow: the client's current shallow boundary oids. depth: optional
 * generation limit (want = generation 1).
 *
 * - G = depth-limited closure of wants (tags peeled to their commits; the tag
 *   objects themselves are sent too).
 * - E = closure of haves, with parent traversal stopping at shallow boundaries
 *   (a boundary commit itself is held, its ancestors are not).
 * - sendCommits = G - E; sendObjects = objectClosure(sendCommits) minus the
 *   object closure of E (the client already holds those objects).
 * - newShallow = sendCommits whose parents are not in sendCommits (the depth
 *   cutoff, when depth is given); oldShallow = shallow boundaries that are no
 *   longer boundaries because their parent is now in sendCommits.
 * - acks = haves that are ancestors of (or equal to) a want.
 */
export function computeFetch(wants, haves, shallow, depth, lookup) {
  const wantSet = new Set(wants.filter(isObjectId));
  const haveSet = new Set(haves.filter(isObjectId));
  const shallowSet = new Set(shallow.filter(isObjectId));

  // Depth-limited walk from wants (tags peeled for the walk, kept as objects).
  const generations = new Map(); // commit oid -> generation (want = 1)
  const tagObjects = new Set();
  const queue = [];
  let head = 0;
  for (const want of wantSet) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const commit = peelToCommit(want, lookup);
      if (commit !== want && isObjectId(commit)) queue.push([commit, 1]);
    } else if (object.type === 'commit') {
      queue.push([want, 1]);
    }
  }
  // BFS: the first visit is at the minimum generation, which is what a depth
  // limit must measure.
  while (head < queue.length) {
    const [oid, gen] = queue[head++];
    if (generations.has(oid)) continue;
    if (depth !== null && depth !== undefined && gen > depth) continue;
    generations.set(oid, gen);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push([parent, gen + 1]);
    }
  }
  const gSet = new Set(generations.keys());

  // Closure of haves, stopping parent traversal at shallow boundaries.
  const eSet = new Set();
  const eQueue = [...haveSet, ...shallowSet];
  while (eQueue.length) {
    const oid = eQueue.pop();
    if (eSet.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    eSet.add(oid);
    if (object.type === 'tag') {
      eQueue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    if (shallowSet.has(oid)) continue; // a shallow boundary: held, ancestors not
    for (const parent of parseCommit(object.data).parents) eQueue.push(parent);
  }

  const sendCommits = [...gSet].filter((oid) => !eSet.has(oid));
  const sendCommitSet = new Set(sendCommits);

  // Object closure of the sent commits, minus what the client already holds.
  const heldObjects = objectClosure([...eSet], lookup);
  const wantedObjects = objectClosure(sendCommits, lookup);
  for (const tag of tagObjects) wantedObjects.add(tag);
  const sendObjects = [...wantedObjects].filter((oid) => !heldObjects.has(oid));

  // Shallow-info.
  const newShallow = [];
  const unshallow = [];
  if (depth !== null && depth !== undefined) {
    for (const oid of sendCommits) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.some((p) => !sendCommitSet.has(p))) newShallow.push(oid);
    }
    for (const boundary of shallowSet) {
      if (!eSet.has(boundary)) continue;
      const object = lookup(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((p) => sendCommitSet.has(p))) unshallow.push(boundary);
    }
  }

  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks = [];
  for (const have of haveSet) {
    for (const want of wantSet) {
      const target = peelToCommit(want, lookup);
      if (isAncestor(have, target, lookup)) {
        acks.push(have);
        break;
      }
    }
  }

  return { sendCommits, sendObjects, newShallow, unshallow, acks };
}
