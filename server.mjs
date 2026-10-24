import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.resolve(process.env.ARCHFLOW_DATA_DIR || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 4173);
const scrypt = promisify(scryptCb);
const dbPath = path.join(DATA, 'archflow.sqlite');

await mkdir(DATA, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('Owner','Editor','Viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('Editor','Viewer')),
    token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT,
    invited_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS diagrams (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, data_json TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    UNIQUE(diagram_id,revision)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), anchor_json TEXT NOT NULL, body TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shares (
    token_hash TEXT PRIMARY KEY, diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id,workspace_id);
  CREATE INDEX IF NOT EXISTS idx_projects_workspace_updated ON projects(workspace_id,archived,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_diagrams_project_updated ON diagrams(project_id,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_revisions_diagram ON revisions(diagram_id,revision DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_diagram ON comments(diagram_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id,email,expires_at);
`);

const now = () => new Date().toISOString();
const id = () => randomUUID();
const hashToken = (value) => createHash('sha256').update(value).digest('hex');
const json = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
  res.end(body);
};
const fail = (status, message, code = 'request_error') => Object.assign(new Error(message), { status, code });
const safeUser = (row) => ({ id: row.id, email: row.email, name: row.name });
const rowToProject = (p) => ({ id: p.id, workspaceId: p.workspace_id, ownerId: p.owner_id, name: p.name, description: p.description, tags: JSON.parse(p.tags_json || '[]'), archived: !!p.archived, createdAt: p.created_at, updatedAt: p.updated_at });
const rowToDiagram = (d) => ({ id: d.id, projectId: d.project_id, name: d.name, revision: d.revision, data: JSON.parse(d.data_json), createdAt: d.created_at, updatedAt: d.updated_at });

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(key).toString('hex') };
}
async function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expectedBuf = Buffer.from(expected, 'hex');
  return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf);
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2));
}
async function body(req, limit = 5_500_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Request body must be valid JSON.', 'invalid_json'); }
}
function string(value, field, max = 180, required = false) {
  if (typeof value !== 'string') throw fail(400, `${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw fail(400, `${field} is required.`);
  if (result.length > max) throw fail(400, `${field} must be ${max} characters or fewer.`);
  return result;
}
function emailValue(value) {
  const email = string(value, 'Email', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
  return email;
}
function sessionCookie(token, maxAge = 60 * 60 * 24 * 14) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `archflow_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function getSession(req) {
  const token = parseCookies(req.headers.cookie).archflow_session;
  if (!token) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token), now());
  return row || null;
}
function requireUser(req) {
  const user = getSession(req);
  if (!user) throw fail(401, 'Sign in to continue.', 'unauthorized');
  return user;
}
function member(workspaceId, userId) {
  return db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, userId) || null;
}
function requireRole(workspaceId, userId, allowed = ['Owner', 'Editor', 'Viewer']) {
  const m = member(workspaceId, userId);
  if (!m) throw fail(404, 'Workspace not found.', 'not_found');
  if (!allowed.includes(m.role)) throw fail(403, 'You do not have permission to do that.', 'forbidden');
  return m.role;
}
function projectForUser(projectId, user, roles = ['Owner', 'Editor', 'Viewer']) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) throw fail(404, 'Project not found.', 'not_found');
  requireRole(p.workspace_id, user.id, roles);
  return p;
}
function diagramForUser(diagramId, user, roles = ['Owner', 'Editor', 'Viewer']) {
  const d = db.prepare('SELECT d.*,p.workspace_id,p.name AS project_name FROM diagrams d JOIN projects p ON p.id=d.project_id WHERE d.id=?').get(diagramId);
  if (!d) throw fail(404, 'Diagram not found.', 'not_found');
  requireRole(d.workspace_id, user.id, roles);
  return d;
}
function validateDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fail(400, 'Diagram data must be an object.');
  if (doc.schemaVersion !== 1) throw fail(400, 'Unsupported diagram format version.');
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges) || !Array.isArray(doc.layers)) throw fail(400, 'Diagram must include nodes, edges, and layers.');
  if (doc.customTypes === undefined) doc.customTypes = [];
  if (!Array.isArray(doc.customTypes) || doc.customTypes.length > 100) throw fail(400, 'Custom component definitions are invalid.');
  if (doc.nodes.length > 10000 || doc.edges.length > 20000 || doc.layers.length > 200) throw fail(413, 'Diagram exceeds the supported import limits.');
  const nodeIds = new Set();
  for (const n of doc.nodes) {
    if (!n || typeof n.id !== 'string' || nodeIds.has(n.id)) throw fail(400, 'Every component needs a unique id.');
    nodeIds.add(n.id);
    if (![n.x, n.y, n.w, n.h].every(Number.isFinite) || Math.abs(n.x) > 1e7 || Math.abs(n.y) > 1e7 || n.w < 36 || n.w > 2500 || n.h < 28 || n.h > 2000) throw fail(400, `Component “${String(n.name || n.id).slice(0, 60)}” has invalid dimensions or position.`);
    if (typeof n.name !== 'string' || n.name.length > 160) throw fail(400, 'Component names must be 160 characters or fewer.');
    if (n.type === 'freehand') {
      const points = n.props?.points;
      if (!Array.isArray(points) || points.length < 2 || points.length > 10000 || points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > n.w + 1 || p.y > n.h + 1)) throw fail(400, 'Freehand strokes need between 2 and 10,000 valid points inside their bounds.');
      if (!Number.isFinite(n.props?.strokeWidth) || n.props.strokeWidth < 1 || n.props.strokeWidth > 16) throw fail(400, 'Freehand stroke width must be between 1 and 16.');
    }
  }
  const edgeIds = new Set();
  for (const e of doc.edges) {
    if (!e || typeof e.id !== 'string' || edgeIds.has(e.id) || !nodeIds.has(e.source) || !nodeIds.has(e.target)) throw fail(400, 'Every connection needs a unique id and two existing endpoints.');
    edgeIds.add(e.id);
  }
  if (JSON.stringify(doc).length > 5_000_000) throw fail(413, 'Diagram data must be under 5 MB.');
  return doc;
}
function applyOps(doc, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 1000) throw fail(400, 'Provide between 1 and 1,000 diagram changes.');
  let next = structuredClone(doc);
  for (const op of ops) {
    if (!op || typeof op.type !== 'string') throw fail(400, 'Invalid diagram change.');
    if (op.type === 'replace') { next = structuredClone(op.data); continue; }
    if (op.type === 'upsertNode') {
      const i = next.nodes.findIndex((n) => n.id === op.node?.id);
      if (i < 0) next.nodes.push(op.node); else next.nodes[i] = op.node;
    } else if (op.type === 'removeNode') {
      next.nodes = next.nodes.filter((n) => n.id !== op.id);
      next.edges = next.edges.filter((e) => e.source !== op.id && e.target !== op.id);
    } else if (op.type === 'upsertEdge') {
      const i = next.edges.findIndex((e) => e.id === op.edge?.id);
      if (i < 0) next.edges.push(op.edge); else next.edges[i] = op.edge;
    } else if (op.type === 'removeEdge') next.edges = next.edges.filter((e) => e.id !== op.id);
    else if (op.type === 'setLayers') next.layers = op.layers;
    else if (op.type === 'setCustomTypes') next.customTypes = op.customTypes;
    else throw fail(400, 'Unsupported diagram change.');
  }
  return validateDoc(next);
}
function saveRevision(diagramId, revision, dataJson, userId) {
  db.prepare('INSERT INTO revisions(diagram_id,revision,data_json,user_id,created_at) VALUES(?,?,?,?,?)').run(diagramId, revision, dataJson, userId, now());
  db.prepare('DELETE FROM revisions WHERE diagram_id=? AND id NOT IN (SELECT id FROM revisions WHERE diagram_id=? ORDER BY revision DESC LIMIT 40)').run(diagramId, diagramId);
}
function newDiagramData() {
  return { schemaVersion: 1, nodes: [], edges: [], layers: [{ id: 'layer-main', name: 'Main', visible: true, locked: false }], customTypes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

async function seedDemo() {
  if (db.prepare('SELECT id FROM users WHERE email=?').get('demo@archflow.local')) return;
  const t = now();
  const userId = id();
  const pwd = await passwordRecord('Diagram!2026');
  db.prepare('INSERT INTO users(id,email,name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, 'demo@archflow.local', 'Alex Morgan', pwd.hash, pwd.salt, t, t);
  const workspaceId = id();
  db.prepare('INSERT INTO workspaces(id,name,created_by,created_at) VALUES(?,?,?,?)').run(workspaceId, 'Northstar Studio', userId, t);
  db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(workspaceId, userId, 'Owner', t);
  const projectId = id();
  db.prepare('INSERT INTO projects(id,workspace_id,owner_id,name,description,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(projectId, workspaceId, userId, 'Northstar Commerce', 'A resilient storefront architecture built for seasonal traffic and a global customer base.', JSON.stringify(['E-commerce', 'AWS', 'Production']), t, t);
  const ids = ['web', 'cdn', 'api', 'auth', 'catalog', 'orders', 'cache', 'db', 'queue', 'worker', 'storage'].map(() => id());
  const makeNode = (i, type, name, x, y, layer = 'layer-main', description = '') => ({ id: ids[i], type, name, description, x, y, w: 158, h: 76, icon: ({ client: '◉', network: '⌁', api: '⇄', service: '◇', cache: '◈', database: '▤', queue: '⇢', storage: '▧' })[type] || '◇', layer, locked: false, props: {} });
  const nodes = [
    makeNode(0, 'client', 'Customers', -520, 20, undefined, 'Web and mobile shoppers.'),
    makeNode(1, 'network', 'CloudFront CDN', -300, 20),
    makeNode(2, 'api', 'Edge API', -80, 20, undefined, 'REST endpoints for the storefront.'),
    makeNode(3, 'service', 'Identity service', 150, -110),
    makeNode(4, 'service', 'Catalog service', 150, 15),
    makeNode(5, 'service', 'Order service', 150, 140),
    makeNode(6, 'cache', 'Redis cache', 390, -45),
    makeNode(7, 'database', 'Aurora Postgres', 390, 115),
    makeNode(8, 'queue', 'Order events', 610, 165),
    makeNode(9, 'service', 'Fulfillment worker', 830, 165),
    makeNode(10, 'storage', 'Product images', 390, -190),
  ];
  const edges = [
    [0, 1, 'HTTPS'], [1, 2, 'TLS'], [2, 3, 'OAuth 2.0'], [2, 4, 'catalog query'], [2, 5, 'checkout'],
    [4, 6, 'read-through'], [4, 10, 'presigned URL'], [5, 7, 'transactions'], [5, 8, 'publish'], [8, 9, 'consume'],
  ].map(([a, b, label]) => ({ id: id(), source: ids[a], target: ids[b], label, style: 'solid', direction: 'forward', color: '#64748b' }));
  const data = { ...newDiagramData(), nodes, edges };
  const diagramId = id();
  db.prepare('INSERT INTO diagrams(id,project_id,name,data_json,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(diagramId, projectId, 'Global storefront', JSON.stringify(data), 1, userId, t, t);
  saveRevision(diagramId, 1, JSON.stringify(data), userId);
}
await seedDemo();

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';
  if (method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok', time: now(), database: 'sqlite' });

  if (pathname.startsWith('/api/')) {
    if (method === 'POST' && pathname === '/api/auth/signup') {
      const input = await body(req); const email = emailValue(input.email); const name = string(input.name, 'Name', 80, true); const password = string(input.password, 'Password', 200, true);
      if (password.length < 10) throw fail(400, 'Use a password with at least 10 characters.');
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw fail(409, 'An account already exists for that email.');
      const userId = id(); const pwd = await passwordRecord(password); const t = now();
      db.prepare('INSERT INTO users(id,email,name,password_hash,password_salt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId,email,name,pwd.hash,pwd.salt,t,t);
      const workspaceId = id();
      db.prepare('INSERT INTO workspaces(id,name,created_by,created_at) VALUES(?,?,?,?)').run(workspaceId, `${name.split(' ')[0]}'s workspace`, userId, t);
      db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(workspaceId,userId,'Owner',t);
      const token = randomBytes(32).toString('base64url'); db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),userId,new Date(Date.now()+14*86400000).toISOString(),t);
      return json(res,201,{user:{id:userId,email,name},workspaces:[{id:workspaceId,name:`${name.split(' ')[0]}'s workspace`,role:'Owner'}]},{'set-cookie':sessionCookie(token)});
    }
    if (method === 'POST' && pathname === '/api/auth/signin') {
      const input = await body(req); const email = emailValue(input.email); const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!row || !(await verifyPassword(String(input.password || ''),row.password_salt,row.password_hash))) throw fail(401,'Email or password is incorrect.','invalid_credentials');
      const token = randomBytes(32).toString('base64url'); const t=now(); db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),row.id,new Date(Date.now()+14*86400000).toISOString(),t);
      return json(res,200,{user:safeUser(row)},{'set-cookie':sessionCookie(token)});
    }
    if (method === 'POST' && pathname === '/api/auth/signout') {
      const token=parseCookies(req.headers.cookie).archflow_session; if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      return json(res,200,{ok:true},{'set-cookie':sessionCookie('',0)});
    }
    if (method === 'POST' && pathname === '/api/auth/forgot') {
      const input=await body(req); const email=emailValue(input.email); const row=db.prepare('SELECT id FROM users WHERE email=?').get(email);
      if(row){const token=randomBytes(32).toString('base64url'); const expires=new Date(Date.now()+3600000).toISOString(); db.prepare('CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL)'); db.prepare('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),row.id,expires); console.log(JSON.stringify({event:'password_reset_link',email,link:`http://localhost:${PORT}/reset?token=${token}`,expiresAt:expires}));}
      return json(res,200,{message:'If that account exists, a reset link has been created. For local development, check the server terminal.'});
    }
    if(method==='POST' && pathname==='/api/auth/reset'){
      const input=await body(req); const token=string(input.token,'Reset token',256,true); const password=string(input.password,'Password',200,true); if(password.length<10) throw fail(400,'Use a password with at least 10 characters.');
      const reset=db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>?').get(hashToken(token),now()); if(!reset) throw fail(400,'This reset link has expired or is invalid.'); const pwd=await passwordRecord(password); db.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(pwd.hash,pwd.salt,now(),reset.user_id); db.prepare('DELETE FROM password_resets WHERE user_id=?').run(reset.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id); return json(res,200,{ok:true});
    }
    if (method === 'GET' && pathname === '/api/me') {
      const user=requireUser(req); return json(res,200,{user:safeUser(user),workspaces:db.prepare('SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at').all(user.id)});
    }
    if(method==='PATCH' && pathname==='/api/profile'){
      const user=requireUser(req); const input=await body(req); const name=string(input.name,'Name',80,true); db.prepare('UPDATE users SET name=?,updated_at=? WHERE id=?').run(name,now(),user.id); return json(res,200,{user:{...safeUser(user),name}});
    }
    if(method==='POST' && pathname==='/api/profile/password'){
      const user=requireUser(req); const input=await body(req); if(!(await verifyPassword(String(input.currentPassword||''),user.password_salt,user.password_hash))) throw fail(400,'Current password is incorrect.'); const password=string(input.newPassword,'New password',200,true); if(password.length<10) throw fail(400,'Use a password with at least 10 characters.'); const pwd=await passwordRecord(password); db.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(pwd.hash,pwd.salt,now(),user.id); return json(res,200,{ok:true});
    }
    const me = method !== 'GET' || pathname !== '/api/me' ? null : undefined;

    if (method === 'GET' && pathname === '/api/workspaces') {
      const user=requireUser(req); return json(res,200,{workspaces:db.prepare('SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at DESC').all(user.id)});
    }
    if (method === 'POST' && pathname === '/api/workspaces') {
      const user=requireUser(req); const input=await body(req); const name=string(input.name,'Workspace name',100,true); const workspaceId=id(); const t=now(); db.prepare('INSERT INTO workspaces(id,name,created_by,created_at) VALUES(?,?,?,?)').run(workspaceId,name,user.id,t); db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(workspaceId,user.id,'Owner',t); return json(res,201,{workspace:{id:workspaceId,name,role:'Owner'}});
    }
    let match=pathname.match(/^\/api\/workspaces\/([^/]+)\/invitations$/);
    if(match && method==='POST'){
      const user=requireUser(req); const input=await body(req); const workspaceId=match[1]; requireRole(workspaceId,user.id,['Owner']); const email=emailValue(input.email); const role=input.role==='Viewer'?'Viewer':'Editor'; const raw=randomBytes(24).toString('base64url'); const t=now(); const expires=new Date(Date.now()+7*86400000).toISOString(); db.prepare('INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at,invited_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id(),workspaceId,email,role,hashToken(raw),expires,user.id,t); return json(res,201,{invitation:{email,role,expiresAt:expires,acceptUrl:`${url.origin}/invite/${raw}`} });
    }
    match=pathname.match(/^\/api\/invitations\/([^/]+)$/);
    if(match && method==='GET'){
      const inv=db.prepare('SELECT i.email,i.role,i.expires_at,w.name AS workspace_name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>?').get(hashToken(match[1]),now()); if(!inv) throw fail(404,'This invitation is invalid or expired.'); return json(res,200,{invitation:inv});
    }
    match=pathname.match(/^\/api\/invitations\/([^/]+)\/accept$/);
    if(match && method==='POST'){
      const user=requireUser(req); const inv=db.prepare('SELECT * FROM invitations WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?').get(hashToken(match[1]),now()); if(!inv) throw fail(404,'This invitation is invalid or expired.'); if(inv.email!==user.email) throw fail(403,`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`); db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role').run(inv.workspace_id,user.id,inv.role,now()); db.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').run(now(),inv.id); return json(res,200,{ok:true,workspaceId:inv.workspace_id});
    }
    match=pathname.match(/^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/);
    if(match && method==='GET'){
      const user=requireUser(req); requireRole(match[1],user.id); return json(res,200,{members:db.prepare('SELECT u.id,u.name,u.email,m.role,m.created_at AS joinedAt FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY CASE m.role WHEN "Owner" THEN 0 WHEN "Editor" THEN 1 ELSE 2 END,u.name').all(match[1])});
    }
    if(match && method==='PATCH'){
      const user=requireUser(req); requireRole(match[1],user.id,['Owner']); const input=await body(req); if(!['Editor','Viewer','Owner'].includes(input.role)) throw fail(400,'Choose Owner, Editor, or Viewer.'); const target=match[2]; if(!target) throw fail(400,'Member id is required.'); if(target===user.id && input.role!=='Owner') throw fail(400,'You cannot remove your own owner access.'); db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(input.role,match[1],target); return json(res,200,{ok:true});
    }
    if(match && method==='DELETE'){
      const user=requireUser(req); requireRole(match[1],user.id,['Owner']); if(!match[2]) throw fail(400,'Member id is required.'); if(match[2]===user.id) throw fail(400,'Transfer ownership before leaving this workspace.'); db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(match[1],match[2]); return json(res,200,{ok:true});
    }
    match=pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if(match && method==='PATCH'){
      const user=requireUser(req); requireRole(match[1],user.id,['Owner']); const input=await body(req); const name=string(input.name,'Workspace name',100,true); db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name,match[1]); return json(res,200,{workspace:{id:match[1],name,role:'Owner'}});
    }

    if (method === 'GET' && pathname === '/api/projects') {
      const user=requireUser(req); const workspaceId=string(url.searchParams.get('workspaceId')||'','Workspace',100,true); requireRole(workspaceId,user.id); const q=(url.searchParams.get('q')||'').trim().toLowerCase(); const archived=url.searchParams.get('archived')==='true'?1:0; const sort=url.searchParams.get('sort')==='name'?'p.name COLLATE NOCASE':'p.updated_at DESC'; const pageValue=Number(url.searchParams.get('page')||1),limitValue=Number(url.searchParams.get('limit')||20); const page=Math.max(1,Number.isFinite(pageValue)?pageValue:1); const limit=Math.min(50,Math.max(1,Number.isFinite(limitValue)?limitValue:20)); const tag=url.searchParams.get('tag')||''; const where=['p.workspace_id=?','p.archived=?']; const args=[workspaceId,archived]; if(q){where.push('(LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ?)');args.push(`%${q}%`,`%${q}%`);} if(tag){where.push('EXISTS (SELECT 1 FROM json_each(p.tags_json) AS project_tag WHERE LOWER(project_tag.value)=LOWER(?))');args.push(tag);} const whereSql=where.join(' AND '); const total=db.prepare(`SELECT COUNT(*) AS total FROM projects p WHERE ${whereSql}`).get(...args).total; const sql=`SELECT p.*,u.name AS owner_name,(SELECT COUNT(*) FROM diagrams d WHERE d.project_id=p.id) AS diagram_count FROM projects p JOIN users u ON u.id=p.owner_id WHERE ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`; const projects=db.prepare(sql).all(...args,limit,(page-1)*limit).map(p=>({...rowToProject(p),ownerName:p.owner_name,diagramCount:p.diagram_count})); return json(res,200,{projects,total,page,limit});
    }
    if (method === 'POST' && pathname === '/api/projects') {
      const user=requireUser(req); const input=await body(req); const workspaceId=string(input.workspaceId,'Workspace',100,true); requireRole(workspaceId,user.id,['Owner','Editor']); const name=string(input.name,'Project name',120,true); const description=string(input.description||'','Description',2000); const tags=Array.isArray(input.tags)?input.tags.slice(0,20).map(t=>string(t,'Tag',36,true)):[]; const projectId=id(); const t=now(); db.prepare('INSERT INTO projects(id,workspace_id,owner_id,name,description,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(projectId,workspaceId,user.id,name,description,JSON.stringify([...new Set(tags)]),t,t); return json(res,201,{project:rowToProject(db.prepare('SELECT * FROM projects WHERE id=?').get(projectId))});
    }
    match=pathname.match(/^\/api\/projects\/([^/]+)$/);
    if(match && method==='GET'){
      const user=requireUser(req); const p=projectForUser(match[1],user); const owner=db.prepare('SELECT name FROM users WHERE id=?').get(p.owner_id); const diagrams=db.prepare('SELECT id,project_id,name,revision,created_at,updated_at FROM diagrams WHERE project_id=? ORDER BY updated_at DESC').all(p.id).map(d=>({id:d.id,projectId:d.project_id,name:d.name,revision:d.revision,createdAt:d.created_at,updatedAt:d.updated_at})); return json(res,200,{project:{...rowToProject(p),ownerName:owner?.name||'Unknown'},diagrams});
    }
    if(match && method==='PATCH'){
      const user=requireUser(req); const p=projectForUser(match[1],user,['Owner','Editor']); const input=await body(req); const name=string(input.name??p.name,'Project name',120,true); const description=string(input.description??p.description,'Description',2000); const tags=Array.isArray(input.tags)?input.tags.slice(0,20).map(t=>string(t,'Tag',36,true)):JSON.parse(p.tags_json); db.prepare('UPDATE projects SET name=?,description=?,tags_json=?,updated_at=? WHERE id=?').run(name,description,JSON.stringify([...new Set(tags)]),now(),p.id); return json(res,200,{project:rowToProject(db.prepare('SELECT * FROM projects WHERE id=?').get(p.id))});
    }
    if(match && method==='DELETE'){
      const user=requireUser(req); const p=projectForUser(match[1],user,['Owner']); db.prepare('DELETE FROM projects WHERE id=?').run(p.id); return json(res,200,{ok:true});
    }
    match=pathname.match(/^\/api\/projects\/([^/]+)\/(archive|restore|duplicate)$/);
    if(match && method==='POST'){
      const user=requireUser(req); const p=projectForUser(match[1],user,match[2]==='duplicate'?['Owner','Editor']:['Owner']); const t=now();
      if(match[2]==='archive'||match[2]==='restore'){db.prepare('UPDATE projects SET archived=?,updated_at=? WHERE id=?').run(match[2]==='archive'?1:0,t,p.id);return json(res,200,{project:rowToProject(db.prepare('SELECT * FROM projects WHERE id=?').get(p.id))});}
      const newId=id(); db.prepare('INSERT INTO projects(id,workspace_id,owner_id,name,description,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(newId,p.workspace_id,user.id,`${p.name} copy`,p.description,p.tags_json,t,t); for(const d of db.prepare('SELECT * FROM diagrams WHERE project_id=?').all(p.id)){const did=id();const doc=JSON.parse(d.data_json);db.prepare('INSERT INTO diagrams(id,project_id,name,data_json,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(did,newId,`${d.name} copy`,JSON.stringify(doc),1,user.id,t,t);saveRevision(did,1,JSON.stringify(doc),user.id);} return json(res,201,{project:rowToProject(db.prepare('SELECT * FROM projects WHERE id=?').get(newId))});
    }
    match=pathname.match(/^\/api\/projects\/([^/]+)\/diagrams$/);
    if(match && method==='POST'){
      const user=requireUser(req); const p=projectForUser(match[1],user,['Owner','Editor']); const input=await body(req); const diagramId=id(); const t=now(); const name=string(input.name||'Untitled diagram','Diagram name',120,true); const data=validateDoc(input.data||newDiagramData()); const serialized=JSON.stringify(data); db.prepare('INSERT INTO diagrams(id,project_id,name,data_json,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(diagramId,p.id,name,serialized,1,user.id,t,t); saveRevision(diagramId,1,serialized,user.id); return json(res,201,{diagram:rowToDiagram(db.prepare('SELECT * FROM diagrams WHERE id=?').get(diagramId))});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)$/);
    if(match && method==='GET'){
      const user=requireUser(req); const d=diagramForUser(match[1],user); return json(res,200,{diagram:rowToDiagram(d),projectName:d.project_name,workspaceId:d.workspace_id,role:member(d.workspace_id,user.id).role});
    }
    if(match && method==='PATCH'){
      const user=requireUser(req); const d=diagramForUser(match[1],user,['Owner','Editor']); const input=await body(req); const name=string(input.name,'Diagram name',120,true); const t=now(); db.prepare('UPDATE diagrams SET name=?,updated_by=?,updated_at=? WHERE id=?').run(name,user.id,t,d.id); db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(t,d.project_id); return json(res,200,{name,updatedAt:t});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/ops$/);
    if(match && method==='POST'){
      const user=requireUser(req); const d=diagramForUser(match[1],user,['Owner','Editor']); const input=await body(req); const base=Number(input.baseRevision); if(!Number.isInteger(base)) throw fail(400,'A base revision is required.'); if(base!==d.revision) return json(res,409,{error:{message:'This diagram changed in another session. Reload the latest version before continuing.',code:'revision_conflict'},diagram:rowToDiagram(d)}); const current=JSON.parse(d.data_json); const updated=applyOps(current,input.operations); const serialized=JSON.stringify(updated); const revision=d.revision+1; const t=now(); db.prepare('UPDATE diagrams SET data_json=?,revision=?,updated_by=?,updated_at=? WHERE id=? AND revision=?').run(serialized,revision,user.id,t,d.id,d.revision); saveRevision(d.id,revision,serialized,user.id); db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(t,d.project_id); return json(res,200,{revision,updatedAt:t});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/versions$/);
    if(match && method==='GET'){
      const user=requireUser(req); const d=diagramForUser(match[1],user); const versions=db.prepare('SELECT r.revision,r.created_at,u.name AS user_name FROM revisions r JOIN users u ON u.id=r.user_id WHERE r.diagram_id=? ORDER BY r.revision DESC LIMIT 40').all(d.id).map(v=>({revision:v.revision,createdAt:v.created_at,userName:v.user_name})); return json(res,200,{versions});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/versions\/(\d+)$/);
    if(match && method==='GET'){
      const user=requireUser(req); const d=diagramForUser(match[1],user); const version=db.prepare('SELECT r.revision,r.data_json,r.created_at,u.name AS user_name FROM revisions r JOIN users u ON u.id=r.user_id WHERE r.diagram_id=? AND r.revision=?').get(d.id,Number(match[2])); if(!version) throw fail(404,'That version is no longer available.'); return json(res,200,{version:{revision:version.revision,data:JSON.parse(version.data_json),createdAt:version.created_at,userName:version.user_name}});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/versions\/(\d+)\/restore$/);
    if(match && method==='POST'){
      const user=requireUser(req); const d=diagramForUser(match[1],user,['Owner','Editor']); const target=db.prepare('SELECT data_json FROM revisions WHERE diagram_id=? AND revision=?').get(d.id,Number(match[2])); if(!target) throw fail(404,'That version is no longer available.'); const data=validateDoc(JSON.parse(target.data_json)); const serialized=JSON.stringify(data); const revision=d.revision+1; const t=now(); db.prepare('UPDATE diagrams SET data_json=?,revision=?,updated_by=?,updated_at=? WHERE id=?').run(serialized,revision,user.id,t,d.id); saveRevision(d.id,revision,serialized,user.id); return json(res,200,{revision,data});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/comments$/);
    if(match && (method==='GET'||method==='POST')){
      const user=requireUser(req); const d=diagramForUser(match[1],user);
      if(method==='GET') return json(res,200,{comments:db.prepare('SELECT c.id,c.anchor_json,c.body,c.resolved,c.created_at,u.name AS user_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.diagram_id=? ORDER BY c.created_at').all(d.id).map(c=>({id:c.id,anchor:JSON.parse(c.anchor_json),body:c.body,resolved:!!c.resolved,createdAt:c.created_at,userName:c.user_name}))});
      requireRole(d.workspace_id,user.id,['Owner','Editor']); const input=await body(req); const anchor=input.anchor; if(!anchor||!['node','point'].includes(anchor.type)) throw fail(400,'Choose a component or canvas location for this comment.'); const commentId=id(); const t=now(); const text=string(input.body,'Comment',2000,true); db.prepare('INSERT INTO comments(id,diagram_id,user_id,anchor_json,body,created_at) VALUES(?,?,?,?,?,?)').run(commentId,d.id,user.id,JSON.stringify(anchor),text,t); return json(res,201,{comment:{id:commentId,anchor,body:text,resolved:false,createdAt:t,userName:user.name}});
    }
    match=pathname.match(/^\/api\/diagrams\/([^/]+)\/share$/);
    if(match && method==='POST'){
      const user=requireUser(req); const d=diagramForUser(match[1],user,['Owner']); const input=await body(req); const days=[1,7,30,90,null].includes(input.expiresInDays)?input.expiresInDays:30; const token=randomBytes(24).toString('base64url'); const expires=days?new Date(Date.now()+days*86400000).toISOString():null; db.prepare('INSERT INTO shares(token_hash,diagram_id,created_by,expires_at,created_at) VALUES(?,?,?,?,?)').run(hashToken(token),d.id,user.id,expires,now()); return json(res,201,{url:`${url.origin}/share/${token}`,expiresAt:expires,permission:'Viewer'});
    }
    match=pathname.match(/^\/api\/shared\/([^/]+)$/);
    if(match && method==='GET'){
      const s=db.prepare('SELECT d.*,p.name AS project_name FROM shares sh JOIN diagrams d ON d.id=sh.diagram_id JOIN projects p ON p.id=d.project_id WHERE sh.token_hash=? AND (sh.expires_at IS NULL OR sh.expires_at>?)').get(hashToken(match[1]),now()); if(!s) throw fail(404,'This share link is invalid or has expired.'); return json(res,200,{diagram:rowToDiagram(s),projectName:s.project_name,permission:'Viewer'});
    }
    throw fail(404,'API route not found.','not_found');
  }

  const filePath = pathname === '/' ? path.join(PUBLIC,'index.html') : path.resolve(PUBLIC,`.${pathname}`);
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== path.join(PUBLIC,'index.html')) throw fail(404,'Not found.','not_found');
  let content;
  try { content=await readFile(filePath); }
  catch { if(pathname.includes('.') && pathname!=='/favicon.svg') throw fail(404,'Not found.','not_found'); content=await readFile(path.join(PUBLIC,'index.html')); }
  const ext=path.extname(filePath); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
  res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':'no-cache'}); res.end(content);
}

const server=http.createServer((req,res)=>{
  handle(req,res).catch((error)=>{
    const status=error.status||500;
    if(status>=500) console.error(JSON.stringify({level:'error',message:error.message,stack:error.stack,method:req.method,url:req.url}));
    if(res.headersSent){res.destroy();return;}
    json(res,status,{error:{message:status===500?'Something went wrong. Please try again.':error.message,code:error.code||'server_error'}});
  });
});
server.listen(PORT,()=>console.log(JSON.stringify({event:'server_started',url:`http://localhost:${PORT}`,database:dbPath,mode:process.env.NODE_ENV||'development'})));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{console.log(JSON.stringify({event:'server_stopping',signal}));db.close();server.close(()=>process.exit(0));});
