// mcp.mjs — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP (plain JSON
// answers, no SSE). Modern era (2026-07-28) via server/discover, with the
// legacy initialize handshake as a fallback. The tools list is a frozen
// constant so two tools/list calls are byte-identical.

import { FIXED_ISO } from './store.mjs';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'];

const TOOLS = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Repository name' }),
        description: Object.freeze({ type: 'string', description: 'Repository description' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        title: Object.freeze({ type: 'string', description: 'Issue title' }),
        body: Object.freeze({ type: 'string', description: 'Issue body' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Pull request number' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** First present value under any of the given names (synonym-tolerant). */
function pickArg(args, names) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function textResult(object) {
  const text = JSON.stringify(object);
  return { content: [{ type: 'text', text }], structuredContent: object };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store, name, args) {
  switch (name) {
    case 'create_repo': {
      const repoName = pickArg(args, ['name', 'repo', 'repository']);
      if (!repoName) return { error: 'create_repo: name is required' };
      const owner = pickArg(args, ['owner']) ?? store.viewer.login;
      const created = store.createRepo(owner, repoName, {
        description: pickArg(args, ['description']) ?? '',
        isPrivate: pickArg(args, ['private']) ?? false,
      });
      if (created.error) return { error: `create_repo: ${created.error}` };
      return { result: textResult(store.repoJson(created.repo)) };
    }
    case 'get_repo': {
      const owner = pickArg(args, ['owner']);
      const repoName = pickArg(args, ['repo', 'name', 'repository']);
      const repo = owner && repoName ? store.getRepo(owner, repoName) : null;
      if (!repo) return { error: `get_repo: repository ${owner}/${repoName} not found` };
      return { result: textResult(store.repoJson(repo)) };
    }
    case 'create_issue': {
      const owner = pickArg(args, ['owner']);
      const repoName = pickArg(args, ['repo', 'name', 'repository']);
      const title = pickArg(args, ['title']);
      if (!owner || !repoName || !title) return { error: 'create_issue: owner, repo and title are required' };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `create_issue: repository ${owner}/${repoName} not found` };
      const created = store.createIssue(repo, { title, body: pickArg(args, ['body']) ?? '' });
      if (created.status !== 201) return { error: `create_issue: ${created.error}` };
      return { result: textResult(store.issueJson(repo, created.issue)) };
    }
    case 'list_issues': {
      const owner = pickArg(args, ['owner']);
      const repoName = pickArg(args, ['repo', 'name', 'repository']);
      if (!owner || !repoName) return { error: 'list_issues: owner and repo are required' };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `list_issues: repository ${owner}/${repoName} not found` };
      const state = pickArg(args, ['state']) ?? 'open';
      const issues = store.listIssues(repo, { state }).map((i) => store.issueJson(repo, i));
      return { result: textResult({ issues }) };
    }
    case 'create_pull_request': {
      const owner = pickArg(args, ['owner']);
      const repoName = pickArg(args, ['repo', 'name', 'repository']);
      const title = pickArg(args, ['title']);
      const head = pickArg(args, ['head', 'head_ref', 'headRef']);
      const base = pickArg(args, ['base', 'base_ref', 'baseRef']);
      if (!owner || !repoName || !title || !head || !base) {
        return { error: 'create_pull_request: owner, repo, title, head and base are required' };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `create_pull_request: repository ${owner}/${repoName} not found` };
      const created = store.createPull(repo, { title, body: pickArg(args, ['body']) ?? '', head, base });
      if (created.status !== 201) return { error: `create_pull_request: ${created.error}` };
      return { result: textResult(store.pullJson(repo, created.pull)) };
    }
    case 'merge_pull_request': {
      const owner = pickArg(args, ['owner']);
      const repoName = pickArg(args, ['repo', 'name', 'repository']);
      const number = Number(pickArg(args, ['pull_number', 'number', 'pullNumber']));
      if (!owner || !repoName || !Number.isFinite(number)) {
        return { error: 'merge_pull_request: owner, repo and pull_number are required' };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `merge_pull_request: repository ${owner}/${repoName} not found` };
      const pull = store.getPull(repo, number);
      if (!pull) return { error: `merge_pull_request: pull request ${number} not found` };
      const merged = store.mergePull(repo, pull, 'squash');
      if (merged.status !== 200) return { error: `merge_pull_request: ${merged.error}` };
      return { result: textResult({ sha: merged.body.sha, merged: true, message: merged.body.message }) };
    }
    default:
      return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one POST /mcp body (raw text). Returns {status, body} where body is
 * a JSON string (or '' for a 202 notification acknowledgement).
 */
export function handleMcp(store, bodyText) {
  let request;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return { status: 400, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request')) };
  }
  const id = 'id' in request ? request.id : null;
  const isNotification = id === null || id === undefined;

  if (request.method === 'notifications/initialized') {
    return { status: 202, body: '' };
  }
  if (isNotification) {
    // Any other notification: acknowledge, no response body.
    return { status: 202, body: '' };
  }

  const params = request.params ?? {};
  switch (request.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return {
        status: 200,
        body: JSON.stringify(rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        })),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      return {
        status: 200,
        body: JSON.stringify(rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        })),
      };
    }
    case 'ping':
      return { status: 200, body: JSON.stringify(rpcResult(id, {})) };
    case 'tools/list':
      return { status: 200, body: JSON.stringify(rpcResult(id, { tools: TOOLS })) };
    case 'tools/call': {
      const toolName = params.name;
      const args = params.arguments ?? {};
      if (typeof toolName !== 'string' || !toolName) {
        return { status: 200, body: JSON.stringify(rpcError(id, -32602, 'tools/call requires a tool name')) };
      }
      if (typeof args !== 'object' || args === null) {
        return { status: 200, body: JSON.stringify(rpcError(id, -32602, 'tools/call arguments must be an object')) };
      }
      const outcome = callTool(store, toolName, args);
      if (outcome.rpcError) {
        return { status: 200, body: JSON.stringify(rpcError(id, outcome.rpcError.code, outcome.rpcError.message)) };
      }
      if (outcome.error) {
        return { status: 200, body: JSON.stringify(rpcResult(id, errorResult(outcome.error))) };
      }
      return { status: 200, body: JSON.stringify(rpcResult(id, outcome.result)) };
    }
    default:
      return { status: 200, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${request.method}`)) };
  }
}

export { FIXED_ISO };
