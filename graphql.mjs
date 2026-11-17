// graphql.mjs — a small GraphQL executor for exactly the documents the
// suite sends (gh's viewer/repository/issue/PR reads, the __type probes, the
// five mutations, node(id:), cursor pagination, and batched arrays).
//
// No GraphQL library: a hand-written tokenizer + recursive-descent parser +
// resolver over the store. Unknown fields produce a 200 with an `errors`
// array naming the field, never an HTTP 400.

import { decodeGlobalId, globalId } from './store.mjs';

// ---------------------------------------------------------------- schema tables (introspection)

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'assignees', 'milestone', 'locked', 'closedAt'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'fork', 'archived'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------- tokenizer

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind} (${token.value})`);
    return token;
  }
  skip(kind) {
    if (this.peek().kind === kind) { this.pos += 1; return true; }
    return false;
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition() {
    let operation = 'query';
    let name = null;
    if (this.peek().kind === 'name' && ['query', 'mutation', 'subscription'].includes(this.peek().value)) {
      operation = this.next().value;
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (this.peek().kind === '{') {
      operation = 'query';
    } else {
      throw new Error(`unexpected definition ${this.peek().value}`);
    }
    const variables = this.parseVariableDefinitions();
    this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variables, selectionSet };
  }

  parseVariableDefinitions() {
    const defs = [];
    if (!this.skip('(')) return defs;
    while (this.peek().kind !== ')') {
      this.expect('$');
      const varName = this.expect('name').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue;
      if (this.skip('=')) defaultValue = this.parseValueLiteral(true);
      this.parseDirectives();
      defs.push({ name: varName, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  parseType() {
    let type;
    if (this.skip('[')) {
      const inner = this.parseType();
      this.expect(']');
      type = `[${inner}]`;
    } else {
      type = this.expect('name').value;
    }
    if (this.skip('!')) type += '!';
    return type;
  }

  parseDirectives() {
    while (this.skip('@')) {
      this.expect('name');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }

  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selectionSet };
      }
      const fragmentName = this.expect('name').value;
      this.parseDirectives();
      return { kind: 'fragmentSpread', name: fragmentName };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.parseArguments();
    this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias: alias ?? name, name, args, selectionSet };
  }

  parseArguments() {
    const args = {};
    if (!this.skip('(')) return args;
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValueLiteral(true);
      if (this.peek().kind === ',') this.next();
    }
    this.expect(')');
    return args;
  }

  parseValueLiteral(constant) {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.kind === 'string') { this.next(); return { kind: 'string', value: token.value }; }
    if (token.kind === 'number') {
      this.next();
      const num = Number(token.value);
      return { kind: Number.isInteger(num) ? 'int' : 'float', value: num };
    }
    if (token.kind === '[') {
      this.next();
      const values = [];
      while (this.peek().kind !== ']') {
        values.push(this.parseValueLiteral(constant));
        if (this.peek().kind === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValueLiteral(constant);
        if (this.peek().kind === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value ${token.kind} (${token.value})`);
  }
}

export function parseDocument(source) {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- execution

function valueFromAst(node, variables) {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueFromAst(v, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueFromAst(value, variables);
      return out;
    }
    default: return undefined;
  }
}

function resolveArgs(argsAst, variables) {
  const out = {};
  for (const [key, node] of Object.entries(argsAst)) out[key] = valueFromAst(node, variables);
  return out;
}

class Executor {
  constructor(store) {
    this.store = store;
    this.errors = [];
  }

  execute(definition, variables) {
    const isMutation = definition.operation === 'mutation';
    const root = isMutation ? this.mutationRoot() : this.queryRoot();
    const rootType = isMutation ? 'Mutation' : 'Query';
    const data = {};
    for (const selection of definition.selectionSet) {
      if (selection.kind === 'field') {
        data[selection.alias] = this.executeField(root, rootType, selection, variables);
      }
    }
    return data;
  }

  queryRoot() {
    return { __typename: 'Query' };
  }

  mutationRoot() {
    return { __typename: 'Mutation' };
  }

  /** Resolve one field on an object; unknown fields record an error and yield null. */
  executeField(parent, parentType, selection, variables) {
    const args = resolveArgs(selection.args, variables);
    const result = this.resolve(parent, parentType, selection.name, args);
    if (result === Executor.UNKNOWN) {
      this.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      return null;
    }
    if (result === null || result === undefined) return null;
    if (!selection.selectionSet) return result;
    if (Array.isArray(result)) {
      return result.map((item) => this.executeSelectionSet(item, selection.selectionSet, variables));
    }
    return this.executeSelectionSet(result, selection.selectionSet, variables);
  }

  executeSelectionSet(object, selectionSet, variables) {
    if (object === null || typeof object !== 'object') return object;
    const out = {};
    const typeName = object.__typename ?? 'Object';
    for (const selection of selectionSet) {
      if (selection.kind === 'field') {
        out[selection.alias] = this.executeField(object, typeName, selection, variables);
      } else if (selection.kind === 'inlineFragment') {
        if (!selection.typeCondition || selection.typeCondition === typeName) {
          for (const inner of selection.selectionSet) {
            if (inner.kind === 'field') out[inner.alias] = this.executeField(object, typeName, inner, variables);
          }
        }
      }
      // Named fragment spreads are not used by the suite's documents.
    }
    return out;
  }

  resolve(parent, parentType, field, args) {
    switch (parentType) {
      case 'Query': return this.resolveQuery(parent, field, args);
      case 'Mutation': return this.resolveMutation(parent, field, args);
      case 'Repository': return this.resolveRepository(parent, field, args);
      case 'Issue': return this.resolveIssue(parent, field, args);
      case 'PullRequest': return this.resolvePullRequest(parent, field, args);
      case 'User': return this.resolveUser(parent, field, args);
      case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection':
        return this.resolveConnection(parent, field, args);
      case 'PageInfo': return this.resolvePageInfo(parent, field, args);
      case 'IssueComment': return this.resolveComment(parent, field, args);
      default: return Executor.UNKNOWN;
    }
  }

  resolveQuery(parent, field, args) {
    const store = this.store;
    if (field === 'viewer') return { __typename: 'User', login: store.viewer.login };
    if (field === 'repository') {
      const repo = store.getRepo(args.owner, args.name);
      if (!repo) return null;
      return this.repositoryObject(repo);
    }
    if (field === 'node') {
      const decoded = decodeGlobalId(args.id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = store.getRepo(owner, name);
        return repo ? this.repositoryObject(repo) : null;
      }
      if (decoded.type === 'Issue') {
        const [ownerRepo, number] = decoded.key.split(':');
        const [owner, name] = ownerRepo.split('/');
        const repo = store.getRepo(owner, name);
        const issue = repo ? store.getIssue(repo, Number(number)) : null;
        return issue ? this.issueObject(repo, issue) : null;
      }
      if (decoded.type === 'PullRequest') {
        const [ownerRepo, number] = decoded.key.split(':');
        const [owner, name] = ownerRepo.split('/');
        const repo = store.getRepo(owner, name);
        const pull = repo ? store.getPull(repo, Number(number)) : null;
        return pull ? this.pullRequestObject(repo, pull) : null;
      }
      return null;
    }
    if (field === '__type') {
      return this.introspectType(args.name);
    }
    if (field === '__schema') return { __typename: '__Schema', types: [] };
    return Executor.UNKNOWN;
  }

  introspectType(name) {
    if (name === 'Issue') return { __typename: '__Type', name: 'Issue', fields: ISSUE_FIELDS.map((n) => ({ name: n })), enumValues: null };
    if (name === 'PullRequest') return { __typename: '__Type', name: 'PullRequest', fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })), enumValues: null };
    if (name === 'Repository') return { __typename: '__Type', name: 'Repository', fields: REPOSITORY_FIELDS.map((n) => ({ name: n })), enumValues: null };
    if (name === 'SearchType') return { __typename: '__Type', name: 'SearchType', fields: null, enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
    return null;
  }

  repositoryObject(repo) {
    return { __typename: 'Repository', __repo: repo };
  }

  issueObject(repo, issue) {
    return { __typename: 'Issue', __repo: repo, __issue: issue };
  }

  pullRequestObject(repo, pull) {
    return { __typename: 'PullRequest', __repo: repo, __pull: pull };
  }

  resolveRepository(wrapper, field, args) {
    const repo = wrapper.__repo;
    const store = this.store;
    switch (field) {
      case 'id': return repo.id;
      case 'databaseId': return repo.databaseId;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return { __typename: 'User', login: repo.owner };
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'defaultBranchRef': {
        const tip = store.refTip(repo, store.headTarget(repo));
        return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = store.getIssue(repo, args.number);
        return issue ? this.issueObject(repo, issue) : null;
      }
      case 'issues': {
        let list = store.listIssues(repo, { state: 'all', direction: 'asc' });
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        if (args.orderBy && String(args.orderBy.field ?? '').toUpperCase() === 'CREATED_AT') {
          list = [...list].sort((a, b) => (String(args.orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        }
        return this.paginateIssues(repo, list, args);
      }
      case 'pullRequests': {
        const list = store.listPulls(repo, { state: 'open' });
        const first = typeof args.first === 'number' ? args.first : list.length;
        return { __typename: 'PullRequestConnection', __nodes: list.slice(0, first).map((p) => this.pullRequestObject(repo, p)) };
      }
      case 'pullRequest': {
        const pull = store.getPull(repo, args.number);
        return pull ? this.pullRequestObject(repo, pull) : null;
      }
      default: return Executor.UNKNOWN;
    }
  }

  paginateIssues(repo, list, args) {
    const first = typeof args.first === 'number' ? args.first : list.length;
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      try {
        const decoded = Buffer.from(args.after, 'base64').toString('utf8');
        const number = Number(decoded.split(':')[1]);
        const index = list.findIndex((i) => i.number === number);
        if (index >= 0) start = index + 1;
      } catch {
        start = 0;
      }
    }
    const page = list.slice(start, start + first);
    const hasNextPage = start + page.length < list.length;
    const endCursor = page.length ? Buffer.from(`issue:${page[page.length - 1].number}`).toString('base64') : null;
    return {
      __typename: 'IssueConnection',
      __nodes: page.map((i) => this.issueObject(repo, i)),
      __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    };
  }

  resolveIssue(wrapper, field) {
    const issue = wrapper.__issue;
    switch (field) {
      case 'id': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body ?? '';
      case 'author': return { __typename: 'User', login: this.store.viewer.login };
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00.000Z';
      case 'url': return '';
      default: return Executor.UNKNOWN;
    }
  }

  resolvePullRequest(wrapper, field, args) {
    const repo = wrapper.__repo;
    const pull = wrapper.__pull;
    const store = this.store;
    switch (field) {
      case 'id': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body ?? '';
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return store.pullConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'files': {
        const files = store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __typename: 'PullRequestChangedFileConnection',
          __nodes: files.slice(0, first).map((f) => ({
            __typename: 'PullRequestChangedFile',
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          })),
        };
      }
      case 'author': return { __typename: 'User', login: store.viewer.login };
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00.000Z';
      case 'url': return '';
      default: return Executor.UNKNOWN;
    }
  }

  resolveUser(wrapper, field) {
    if (field === 'login') return wrapper.login;
    return Executor.UNKNOWN;
  }

  resolveConnection(wrapper, field) {
    if (field === 'nodes') return wrapper.__nodes ?? [];
    if (field === 'pageInfo') return wrapper.__pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
    if (field === 'totalCount') return (wrapper.__nodes ?? []).length;
    return Executor.UNKNOWN;
  }

  resolvePageInfo(wrapper, field) {
    if (field === 'hasNextPage') return wrapper.hasNextPage;
    if (field === 'endCursor') return wrapper.endCursor;
    return Executor.UNKNOWN;
  }

  resolveComment(wrapper, field) {
    if (field === 'id') return wrapper.id;
    if (field === 'body') return wrapper.body;
    return Executor.UNKNOWN;
  }

  resolveMutation(parent, field, args) {
    const store = this.store;
    const input = args.input ?? {};
    if (field === 'createIssue') {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.type !== 'Repository') {
        this.errors.push({ message: 'createIssue: repositoryId does not name a repository.' });
        return null;
      }
      const [owner, name] = decoded.key.split('/');
      const repo = store.getRepo(owner, name);
      if (!repo) {
        this.errors.push({ message: 'createIssue: repository not found.' });
        return null;
      }
      const created = store.createIssue(repo, { title: input.title ?? '', body: input.body ?? '' });
      if (created.status !== 201) {
        this.errors.push({ message: `createIssue: ${created.error}` });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: this.issueObject(repo, created.issue) };
    }
    if (field === 'closeIssue') {
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.type !== 'Issue') {
        this.errors.push({ message: 'closeIssue: issueId does not name an issue.' });
        return null;
      }
      const [ownerRepo, number] = decoded.key.split(':');
      const [owner, name] = ownerRepo.split('/');
      const repo = store.getRepo(owner, name);
      const issue = repo ? store.getIssue(repo, Number(number)) : null;
      if (!issue) {
        this.errors.push({ message: 'closeIssue: issue not found.' });
        return null;
      }
      issue.state = 'closed';
      repo.issueCache.delete(issue.number);
      return { __typename: 'CloseIssuePayload', issue: this.issueObject(repo, issue) };
    }
    if (field === 'createPullRequest') {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.type !== 'Repository') {
        this.errors.push({ message: 'createPullRequest: repositoryId does not name a repository.' });
        return null;
      }
      const [owner, name] = decoded.key.split('/');
      const repo = store.getRepo(owner, name);
      if (!repo) {
        this.errors.push({ message: 'createPullRequest: repository not found.' });
        return null;
      }
      const created = store.createPull(repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName,
        base: input.baseRefName,
      });
      if (created.status !== 201) {
        this.errors.push({ message: `createPullRequest: ${created.error}` });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: this.pullRequestObject(repo, created.pull) };
    }
    if (field === 'mergePullRequest') {
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.type !== 'PullRequest') {
        this.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request.' });
        return null;
      }
      const [ownerRepo, number] = decoded.key.split(':');
      const [owner, name] = ownerRepo.split('/');
      const repo = store.getRepo(owner, name);
      const pull = repo ? store.getPull(repo, Number(number)) : null;
      if (!pull) {
        this.errors.push({ message: 'mergePullRequest: pull request not found.' });
        return null;
      }
      const merged = store.mergePull(repo, pull, 'squash');
      if (merged.status !== 200) {
        this.errors.push({ message: `mergePullRequest: ${merged.error}` });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: this.pullRequestObject(repo, pull) };
    }
    if (field === 'addComment') {
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.type !== 'Issue') {
        this.errors.push({ message: 'addComment: subjectId does not name an issue.' });
        return null;
      }
      const [ownerRepo, number] = decoded.key.split(':');
      const [owner, name] = ownerRepo.split('/');
      const repo = store.getRepo(owner, name);
      const issue = repo ? store.getIssue(repo, Number(number)) : null;
      if (!issue) {
        this.errors.push({ message: 'addComment: issue not found.' });
        return null;
      }
      const comment = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${store.commentSeq}`),
        body: input.body ?? '',
        seq: store.commentSeq++,
      };
      issue.comments.push(comment);
      repo.issueCache.delete(issue.number);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: comment },
      };
    }
    return Executor.UNKNOWN;
  }
}

Executor.UNKNOWN = Symbol('unknown-field');

// Payload objects: resolve their single nested field by name.
Executor.prototype.resolvePayload = function (wrapper, field) {
  if (field === 'issue' || field === 'pullRequest') return wrapper[field] ?? null;
  if (field === 'commentEdge') return wrapper.commentEdge ?? null;
  return Executor.UNKNOWN;
};

// Route payload __typename through resolvePayload.
const baseResolve = Executor.prototype.resolve;
Executor.prototype.resolve = function (parent, parentType, field, args) {
  if (parentType.endsWith('Payload')) return this.resolvePayload(parent, field);
  if (parentType === 'IssueCommentEdge') {
    if (field === 'node') return parent.node ?? null;
    return Executor.UNKNOWN;
  }
  if (parentType === '__Type') {
    if (field === 'name') return parent.name ?? null;
    if (field === 'fields') return parent.fields ?? null;
    if (field === 'enumValues') return parent.enumValues ?? null;
    return Executor.UNKNOWN;
  }
  if (parentType === 'Ref') {
    if (field === 'name') return parent.name ?? null;
    return Executor.UNKNOWN;
  }
  if (parentType === 'PullRequestChangedFile') {
    if (field === 'path') return parent.path ?? null;
    if (field === 'additions') return parent.additions ?? 0;
    if (field === 'deletions') return parent.deletions ?? 0;
    if (field === 'changeType') return parent.changeType ?? 'MODIFIED';
    return Executor.UNKNOWN;
  }
  // Plain objects (introspection field entries, enum values) expose their
  // own properties directly.
  if (parent && typeof parent === 'object' && !parent.__typename && Object.prototype.hasOwnProperty.call(parent, field)) {
    return parent[field];
  }
  return baseResolve.call(this, parent, parentType, field, args);
};

/** Execute one operation document (or a batch array). Returns the response body object/array. */
export function executeGraphQL(store, body) {
  if (Array.isArray(body)) {
    return body.map((operation) => executeOne(store, operation));
  }
  return executeOne(store, body);
}

function executeOne(store, operation) {
  if (!operation || typeof operation !== 'object' || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'the request body is not a GraphQL operation.' }] };
  }
  let definitions;
  try {
    definitions = parseDocument(operation.query);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${err.message}` }] };
  }
  const variables = operation.variables && typeof operation.variables === 'object' ? operation.variables : {};
  const definition = definitions.find((d) => !operation.operationName || d.name === operation.operationName) ?? definitions[0];
  if (!definition) return { data: null, errors: [{ message: 'no operation in the document.' }] };
  const executor = new Executor(store);
  let data;
  try {
    data = executor.execute(definition, variables);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL execution error: ${err.message}` }] };
  }
  const response = { data };
  if (executor.errors.length > 0) response.errors = executor.errors;
  return response;
}
