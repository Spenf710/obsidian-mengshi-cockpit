/**
 * 飞书数据层 — lark-cli 检测、命令封装、JSON 解析、缓存
 *
 * 依赖：Node.js child_process（Obsidian Electron 环境可用）
 * 外部工具：lark-cli（用户自行安装）
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import { getFeishuConfig, type FeishuConfig } from './settings';

// ===== 超时包装 =====
/** 给 Promise 加硬超时，防止 Electron 环境下 exec timeout 失效导致永久卡死 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ===== 类型定义 =====

/** lark-cli 连接状态 */
export type LarkStatus = 'ready' | 'no-cli' | 'no-auth' | 'checking';

/** 飞书空间 */
export interface FeishuSpace {
  spaceId: string;
  name: string;
  description: string;
  spaceType: string;
  visibility: string;
}

/** 飞书文档节点 */
export interface FeishuNode {
  nodeToken: string;
  objToken: string;
  objType: string;       // docx | doc | sheet | bitable | wiki | mindnote | slides | folder
  title: string;
  parentNodeToken: string;
  spaceId: string;
  hasChild: boolean;
  url: string;           // 合成的飞书链接
}

/** 链接检查结果 */
export interface LinkInspectResult {
  url: string;
  ok: boolean;
  title: string;
  type: string;          // docx | sheet | bitable | wiki 等
  error?: string;
}

/** 连接信息 */
export interface LarkConnection {
  status: LarkStatus;
  cliPath: string | null;
  cliVersion: string | null;
  userName: string | null;
  openId: string | null;
  tokenExpiresAt: string | null;
  error?: string;
}

// ===== URL 工具 =====

let _baseUrl = '';

/** 从 API 返回的 URL 中自动提取飞书域名 */
function detectBaseUrl(url: string): void {
  if (_baseUrl) return;
  const m = url.match(/^(https:\/\/[^/]+\.feishu\.cn)/)
    || url.match(/^(https:\/\/[^/]+\.larkoffice\.com)/)
    || url.match(/^(https:\/\/[^/]+\.larksuite\.com)/);
  if (m) _baseUrl = m[1];
}

function getBaseUrl(): string {
  return _baseUrl || 'https://open.feishu.cn'; // 兜底，首次 Drive API 调用后从返回 URL 中自动提取正确域名
}

const OBJ_TYPE_URL_MAP: Record<string, string> = {
  docx: '/docx/',
  doc: '/doc/',
  sheet: '/sheets/',
  bitable: '/base/',
  wiki: '/wiki/',
  mindnote: '/mindnote/',
  slides: '/slides/',
};

function buildDocUrl(objToken: string, objType: string): string {
  const base = getBaseUrl();
  const path = OBJ_TYPE_URL_MAP[objType];
  if (path) return `${base}${path}${objToken}`;
  return `${base}/docx/${objToken}`; // fallback
}

// ===== lark-cli 路径检测 =====

let _cachedCliPath: string | null = null;

async function getCliVersion(cliPath: string): Promise<string | null> {
  if (cliPath === '__npx__') {
    return withTimeout(new Promise((resolve) => {
      exec('npx --no-install @larksuite/cli --version', { timeout: 15000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const m = stdout.match(/(\d+\.\d+\.\d+)/);
        resolve(m ? m[1] : null);
      });
    }), 20000, null);
  }
  return withTimeout(new Promise((resolve) => {
    exec(`"${cliPath}" --version`, { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = stdout.match(/(\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  }), 15000, null);
}

export async function detectLarkCli(): Promise<string | null> {
  const cfg = getFeishuConfig();

  // 1. 用户手动配置（优先级最高）
  if (cfg.larkCliPath) {
    if (fs.existsSync(cfg.larkCliPath)) {
      _cachedCliPath = cfg.larkCliPath;
      return cfg.larkCliPath;
    }
    // 用户配置了但文件不存在 → 不回落，让用户检查路径
    _cachedCliPath = null;
    return null;
  }

  // 2. Windows 多路径探测
  if (process.platform === 'win32') {
    const candidates = [
      // a) npm 全局 .cmd 脚本（最常见）
      `${process.env.APPDATA || ''}\\npm\\lark-cli.cmd`,
      // b) npm 全局 node_modules 下的实际二进制
      `${process.env.APPDATA || ''}\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe`,
      // c) LocalAppData 下的 npm（某些 npm 安装使用 Local）
      `${process.env.LOCALAPPDATA || ''}\\npm\\lark-cli.cmd`,
      `${process.env.LOCALAPPDATA || ''}\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe`,
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        _cachedCliPath = p;
        return p;
      }
    }

    // d) 尝试 `where lark-cli` 搜索 PATH
    const wherePath = await new Promise<string | null>((resolve) => {
      exec('where lark-cli', { timeout: 5000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const firstLine = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
        resolve(firstLine && fs.existsSync(firstLine) ? firstLine : null);
      });
    });
    if (wherePath) {
      _cachedCliPath = wherePath;
      return wherePath;
    }

    // 3. npx 兜底：所有路径都找不到，用 npx 执行
    _cachedCliPath = '__npx__';
    return '__npx__';
  }

  // 4. Mac/Linux: npm 全局通常在 PATH 中
  _cachedCliPath = 'lark-cli';
  return 'lark-cli';
}

// ===== 通用 lark-cli 执行封装 =====

interface LarkCliResult {
  ok: boolean;
  data: any;
  error?: string;
}

/** 执行 lark-cli 并返回 JSON — 适用于 API 命令（返回 {ok, data} 结构） */
function execLarkCli(args: string[], timeoutMs: number = 15000): Promise<LarkCliResult> {
  return _execLarkCli(args, timeoutMs, true);
}

/** 执行 lark-cli 并返回 JSON — 不检查 ok 字段（适用于 auth status 等非 API 命令） */
function execLarkCliRaw(args: string[], timeoutMs: number = 15000): Promise<LarkCliResult> {
  return _execLarkCli(args, timeoutMs, false);
}

function _execLarkCli(args: string[], timeoutMs: number, checkOk: boolean): Promise<LarkCliResult> {
  return withTimeout(new Promise<LarkCliResult>((resolve) => {
    const rawPath = _cachedCliPath;
    if (!rawPath) { resolve({ ok: false, data: null, error: 'lark-cli 未检测到' }); return; }

    // __npx__ 模式：用 npx @larksuite/cli 执行
    const isNpxMode = rawPath === '__npx__';
    const cliPath = isNpxMode ? 'npx' : rawPath;
    const npxPrefix = isNpxMode ? ['@larksuite/cli'] : [];

    // 构建安全命令
    const safeArgs = args.map((a) => {
      if (a.startsWith('{') || a.startsWith('[')) {
        return `"${a.replace(/"/g, '\\"')}"`;
      }
      if (/\s/.test(a)) return `"${a}"`;
      return a;
    });
    const cmd = isNpxMode
      ? `npx --no-install @larksuite/cli ${safeArgs.join(' ')}`
      : `"${cliPath}" ${safeArgs.join(' ')}`;

    exec(cmd, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || err.message || '执行失败';
        resolve({ ok: false, data: null, error: msg.slice(0, 500) });
        return;
      }

      try {
        // lark-cli 输出前可能混有状态行（如 "Found 5 node(s)"），取第一个 { 开始的 JSON
        const jsonStart = stdout.indexOf('{');
        if (jsonStart < 0) {
          resolve({ ok: false, data: null, error: '无效输出格式' });
          return;
        }
        const jsonStr = stdout.slice(jsonStart);
        const parsed = JSON.parse(jsonStr);

        if (checkOk && parsed.ok !== true && parsed.code !== 0) {
          resolve({
            ok: false,
            data: null,
            error: parsed.error?.message || parsed.error?.hint || parsed.msg || '飞书 API 返回错误',
          });
          return;
        }

        resolve({ ok: true, data: parsed.data ?? parsed });
      } catch (parseErr: any) {
        resolve({ ok: false, data: null, error: `JSON 解析失败: ${parseErr.message}` });
      }
    });
  }), timeoutMs + 5000, { ok: false, data: null, error: 'lark-cli 执行超时' });
}

// ===== 连接检测 =====

let _connectionCache: LarkConnection | null = null;
let _connectionCacheTime = 0;
const CONNECTION_CACHE_MS = 60000; // 1 分钟

export async function checkConnection(forceRefresh = false): Promise<LarkConnection> {
  if (!forceRefresh && _connectionCache && (Date.now() - _connectionCacheTime) < CONNECTION_CACHE_MS) {
    return _connectionCache;
  }

  // 检测 lark-cli
  const cliPath = await detectLarkCli();
  if (!cliPath) {
    _connectionCache = {
      status: 'no-cli',
      cliPath: null,
      cliVersion: null,
      userName: null,
      openId: null,
      tokenExpiresAt: null,
      error: '未检测到 lark-cli，请先安装',
    };
    _connectionCacheTime = Date.now();
    return _connectionCache;
  }

  const version = await getCliVersion(cliPath);

  // version 为 null 说明 CLI 无法执行（未安装 / 路径错误 / npx 包不可用），
  // 判定为「未安装」而非继续走登录态检测，避免误判为「未登录」
  if (!version) {
    _connectionCache = {
      status: 'no-cli',
      cliPath: cliPath === '__npx__' ? null : cliPath,
      cliVersion: null,
      userName: null,
      openId: null,
      tokenExpiresAt: null,
      error: '未检测到可用的 lark-cli，请先运行 npm install -g @larksuite/cli',
    };
    _connectionCacheTime = Date.now();
    return _connectionCache;
  }

  // 检测登录态 — withTimeout 防 Electron 下 exec timeout 失效导致永久卡死
  const authResult = await withTimeout(
    new Promise<LarkConnection>((resolve) => {
    const isNpxMode = cliPath === '__npx__';
    const authCmd = isNpxMode ? 'npx --no-install @larksuite/cli auth status' : `"${cliPath}" auth status`;
    exec(authCmd, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          status: 'no-auth', cliPath, cliVersion: version,
          userName: null, openId: null, tokenExpiresAt: null,
          error: `auth status 执行失败: ${(stderr || err.message).slice(0, 200)}`,
        });
        return;
      }
      try {
        const jsonStart = stdout.indexOf('{');
        if (jsonStart < 0) {
          resolve({ status: 'no-auth', cliPath, cliVersion: version, userName: null, openId: null, tokenExpiresAt: null, error: `auth status 返回非 JSON: ${stdout.slice(0, 200)}` });
          return;
        }
        const parsed = JSON.parse(stdout.slice(jsonStart));
        const userIdentity = parsed?.identities?.user ?? {};
        // 只要有 userName 就认为可用（token 会在实际 API 调用时自动刷新）
        const isAuthed = !!(userIdentity.userName && userIdentity.openId);
        resolve({
          status: isAuthed ? 'ready' : 'no-auth',
          cliPath, cliVersion: version,
          userName: userIdentity.userName ?? null,
          openId: userIdentity.openId ?? null,
          tokenExpiresAt: userIdentity.expiresAt ?? null,
          error: !isAuthed ? (userIdentity.message || '请运行 lark-cli auth login') : undefined,
        });
      } catch (parseErr: any) {
        resolve({
          status: 'no-auth', cliPath, cliVersion: version,
          userName: null, openId: null, tokenExpiresAt: null,
          error: `JSON 解析失败: ${parseErr.message} | 原始输出: ${stdout.slice(0, 200)}`,
        });
      }
    });
  }),
    20000,
    {
      status: 'no-auth', cliPath, cliVersion: version,
      userName: null, openId: null, tokenExpiresAt: null,
      error: '登录态检测超时，请运行 lark-cli auth login',
    },
  );

  _connectionCache = authResult;
  _connectionCacheTime = Date.now();
  return authResult;
}

// ===== 空间列表 =====

let _spacesCache: FeishuSpace[] | null = null;
let _spacesCacheTime = 0;
const SPACES_CACHE_MS = 300000; // 5 分钟

export async function loadSpaces(forceRefresh = false): Promise<FeishuSpace[]> {
  if (!forceRefresh && _spacesCache && (Date.now() - _spacesCacheTime) < SPACES_CACHE_MS) {
    return _spacesCache;
  }

  const conn = await checkConnection();
  if (conn.status !== 'ready') return [];

  // 先获取自定义空间
  const result = await execLarkCli(['wiki', '+space-list', '--page-all', '--format', 'json']);
  if (!result.ok) { return []; }

  const spaces: FeishuSpace[] = (result.data?.spaces ?? []).map((s: any) => ({
    spaceId: s.space_id,
    name: s.name || '(未命名)',
    description: s.description || '',
    spaceType: s.space_type || 'team',
    visibility: s.visibility || 'private',
  }));

  // 追加 my_library（个人文档库）
  const cfg = getFeishuConfig();
  const includeMyLibrary = cfg.spaces.includes('my_library');

  if (includeMyLibrary) {
    // 检查 my_library 是否已在列表中
    const hasMyLib = spaces.some((s) => s.spaceId === 'my_library');
    if (!hasMyLib) {
      // 尝试获取 my_library 信息
      const myLibResult = await execLarkCli(['wiki', '+node-list', '--space-id', 'my_library', '--page-size', '1', '--format', 'json']);
      if (myLibResult.ok) {
        spaces.unshift({
          spaceId: 'my_library',
          name: '我的文档库',
          description: '个人飞书文档',
          spaceType: 'personal',
          visibility: 'private',
        });
      }
    }
  }

  _spacesCache = spaces;
  _spacesCacheTime = Date.now();
  return spaces;
}

// ===== 文档节点列表 =====

const _nodesCache = new Map<string, { nodes: FeishuNode[]; time: number }>();
const NODES_CACHE_MS = 120000; // 2 分钟

export async function loadNodes(spaceId: string, forceRefresh = false): Promise<FeishuNode[]> {
  const cached = _nodesCache.get(spaceId);
  if (!forceRefresh && cached && (Date.now() - cached.time) < NODES_CACHE_MS) {
    return cached.nodes;
  }

  const conn = await checkConnection();
  if (conn.status !== 'ready') return [];

  const result = await execLarkCli([
    'wiki', '+node-list',
    '--space-id', spaceId,
    '--page-all',
    '--format', 'json',
  ]);

  if (!result.ok) { return []; }

  const nodes: FeishuNode[] = (result.data?.nodes ?? []).map((n: any) => ({
    nodeToken: n.node_token,
    objToken: n.obj_token,
    objType: n.obj_type || 'docx',
    title: n.title || '(无标题)',
    parentNodeToken: n.parent_node_token || '',
    spaceId: n.space_id || spaceId,
    hasChild: n.has_child ?? false,
    url: buildDocUrl(n.obj_token, n.obj_type || 'docx'),
  }));

  // 子节点加载（递归一层）
  for (const node of nodes) {
    if (node.hasChild) {
      const childResult = await execLarkCli([
        'wiki', '+node-list',
        '--space-id', spaceId,
        '--parent-node-token', node.nodeToken,
        '--page-all',
        '--format', 'json',
      ]);
      if (childResult.ok && childResult.data?.nodes) {
        for (const cn of childResult.data.nodes) {
          nodes.push({
            nodeToken: cn.node_token,
            objToken: cn.obj_token,
            objType: cn.obj_type || 'docx',
            title: cn.title || '(无标题)',
            parentNodeToken: cn.parent_node_token || node.nodeToken,
            spaceId: cn.space_id || spaceId,
            hasChild: cn.has_child ?? false,
            url: buildDocUrl(cn.obj_token, cn.obj_type || 'docx'),
          });
        }
      }
    }
  }

  _nodesCache.set(spaceId, { nodes, time: Date.now() });
  return nodes;
}

// ===== 链接检测 =====

export async function inspectUrl(url: string): Promise<LinkInspectResult> {
  const conn = await checkConnection();
  if (conn.status !== 'ready') {
    return { url, ok: false, title: '', type: '', error: '飞书未连接' };
  }

  const result = await execLarkCli([
    'drive', '+inspect',
    '--url', url,
    '--format', 'json',
  ]);

  if (!result.ok) {
    return { url, ok: false, title: '', type: '', error: result.error || '链接无效' };
  }

  return {
    url,
    ok: true,
    title: result.data?.title || '',
    type: result.data?.type || '',
    error: undefined,
  };
}

/**
 * 批量检查项目云文档链接
 * 返回每个 URL 的检查结果
 */
export async function inspectProjectUrls(
  urls: Array<{ name: string; url: string }>,
): Promise<Array<{ name: string } & LinkInspectResult>> {
  const results: Array<{ name: string } & LinkInspectResult> = [];

  // 逐个检查（避免并发限频）
  for (const item of urls) {
    const result = await inspectUrl(item.url);
    results.push({ name: item.name, ...result });
    // 简单节流：间隔 300ms
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

// ===== 图标常量 =====

/** 表格 4×4 网格 SVG 图标 */
export const SHEET_GRID_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:middle">` +
  `<rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>` +
  `<line x1="1" y1="5" x2="15" y2="5" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `<line x1="1" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `<line x1="1" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `<line x1="5" y1="1" x2="5" y2="15" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `<line x1="9" y1="1" x2="9" y2="15" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `<line x1="13" y1="1" x2="13" y2="15" stroke="currentColor" stroke-width="0.6" opacity="0.5"/>` +
  `</svg>`;

export const OBJ_TYPE_META: Record<string, { emoji: string; label: string }> = {
  docx: { emoji: '📝', label: '文档' },
  doc: { emoji: '📝', label: '文档(旧)' },
  sheet: { emoji: '__grid__', label: '表格' },
  bitable: { emoji: '📊', label: '多维表' },
  wiki: { emoji: '📚', label: '知识库' },
  mindnote: { emoji: '🧠', label: '思维导图' },
  slides: { emoji: '🖼️', label: '幻灯片' },
  folder: { emoji: '📁', label: '文件夹' },
  file: { emoji: '📎', label: '文件' },
};

export function getObjTypeEmoji(objType: string): string {
  return OBJ_TYPE_META[objType]?.emoji ?? '📄';
}

export function getObjTypeLabel(objType: string): string {
  return OBJ_TYPE_META[objType]?.label ?? objType;
}

// ===== Drive 云盘 =====

/** 云盘文件/文件夹 */
export interface DriveFile {
  token: string;
  name: string;
  type: string;        // folder | doc | docx | sheet | bitable | mindnote | slides | file
  url: string;
  parentToken: string;
  modifiedTime: string;
  createdTime: string;
  ownerId: string;
}

const _driveCache = new Map<string, { files: DriveFile[]; time: number }>();
const DRIVE_CACHE_MS = 120000; // 2 分钟
/** 深度扫描模式的文件夹列表缓存时长：10 分钟内复用上次结果，增量刷新不重复打 API */
export const DRIVE_SCAN_CACHE_MS = 10 * 60 * 1000;

/** 列出云盘根目录文件（不传 folder_token） */
export async function loadDriveRoot(forceRefresh = false): Promise<DriveFile[]> {
  return loadDriveFolder('', forceRefresh);
}

/** 列出指定云盘文件夹内容。
 *  @param maxStaleMs 缓存最大时效：浏览用 2 分钟；扫描用 DRIVE_SCAN_CACHE_MS（10 分钟）实现增量刷新
 */
export async function loadDriveFolder(folderToken: string, forceRefresh = false, timeoutMs = 15000, maxStaleMs: number = DRIVE_CACHE_MS): Promise<DriveFile[]> {
  const cacheKey = folderToken || '__root__';
  const cached = _driveCache.get(cacheKey);
  if (!forceRefresh && cached && (Date.now() - cached.time) < maxStaleMs) {
    return cached.files;
  }

  const conn = await checkConnection();
  if (conn.status !== 'ready') return [];

  const args = ['drive', 'files', 'list', '--json', '--page-all'];
  if (folderToken) {
    args.push('--params', JSON.stringify({ folder_token: folderToken }));
  }

  const result = await execLarkCli(args, timeoutMs);
  if (!result.ok) { return cached?.files /* 请求失败时返回陈旧缓存，避免刷新打断列表 */ || []; }

  const files: DriveFile[] = (result.data?.files ?? []).map((f: any) => {
    // 从第一个有效 URL 自动提取飞书域名
    if (f.url) detectBaseUrl(f.url);
    return {
      token: f.token,
      name: f.name || '(未命名)',
      type: f.type || 'file',
      url: f.url || buildDriveUrl(f.token, f.type),
      parentToken: f.parent_token || '',
      modifiedTime: f.modified_time || '',
      createdTime: f.created_time || '',
      ownerId: f.owner_id || '',
    };
  });

  // 文件夹在前，文件在后
  files.sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name, 'zh');
  });

  _driveCache.set(cacheKey, { files, time: Date.now() });
  return files;
}

function buildDriveUrl(token: string, type: string): string {
  const base = getBaseUrl();
  if (type === 'folder') return `${base}/drive/folder/${token}`;
  const path = OBJ_TYPE_URL_MAP[type];
  if (path) return `${base}${path}${token}`;
  return `${base}/drive/file/${token}`;
}

// ===== 智能纪要 =====

export interface MeetingMinute {
  token: string;
  title: string;
  date: string;
  url: string;
  type: string; // '智能纪要' | '文字记录'
  ownerId: string;
  ownerName?: string;
}

/** 用 Drive 搜索加载智能纪要（我创建 + 我参与的全部） */
export async function loadMinutes(): Promise<MeetingMinute[]> {
  const conn = await checkConnection();
  if (conn.status !== 'ready') return [];

  const all: MeetingMinute[] = [];
  let pageToken = '';

  // 搜全部文档，不限时间，翻页拿到所有智能纪要
  for (let page = 0; page < 15; page++) {
    const args = ['drive', '+search', '--page-size', '20', '--json', '--doc-types', 'docx'];
    if (pageToken) args.push('--page-token', pageToken);
    const result = await execLarkCli(args);
    if (!result.ok) break;

    for (const item of (result.data?.results ?? [])) {
      const meta = item.result_meta || {};
      const title = item.title_highlighted || '';
      const m = parseMinuteItem(title, meta.token || '', meta.url || '', meta.owner_id || '', meta.owner_name || '');
      if (m) all.push(m);
    }

    if (!result.data?.has_more) break;
    pageToken = result.data?.page_token || '';
  }

  // 去重 + 倒序
  const seen = new Set<string>();
  const unique: MeetingMinute[] = [];
  for (const m of all) {
    const key = `${m.title}|${m.date}`;
    if (!seen.has(key)) { seen.add(key); unique.push(m); }
  }
  unique.sort((a, b) => b.date.localeCompare(a.date));
  return unique;
}

function parseMinuteItem(title: string, token: string, url: string, ownerId: string, ownerName: string): MeetingMinute | null {
  const isNote = title.startsWith('智能纪要：');
  const isTranscript = title.startsWith('文字记录：');
  if (!isNote && !isTranscript) return null;

  // 保留完整标题，不裁剪
  const name = title;
  const cleaned = title.replace(/^(智能纪要|文字记录)：/, '');
  const dateMatch = cleaned.match(/(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  const date = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';

  return { token, title: name, date, url, type: isNote ? '智能纪要' : '文字记录', ownerId, ownerName };
}

// ===== 删除文件 =====

export async function deleteDriveFile(fileToken: string, fileType: string): Promise<{ ok: boolean; error?: string }> {
  const conn = await checkConnection();
  if (conn.status !== 'ready') return { ok: false, error: '飞书未连接' };

  const result = await execLarkCli([
    'drive', '+delete',
    '--file-token', fileToken,
    '--type', fileType,
    '--yes',
    '--json',
  ]);

  if (!result.ok) return { ok: false, error: result.error || '删除失败' };
  return { ok: true };
}

// ===== 云盘项目分组 =====

export interface DriveProjectGroup {
  key: string;
  emoji: string;
  name: string;
  files: DriveFile[];
  systemType?: string;
  treeRoot?: string;          // 来源 vault 根目录（projectRoots），用于项目 Tab 树形分组
}

/** 太通用、匹配噪音大的关键词 */
const KEYWORD_BLOCKLIST = new Set(['FQ', 'SQE', 'AI', 'V1', 'V2', 'V3', 'M18', '自动化', '系统', '管控', '项目']);

/** 从项目名自动提取关键词（含中文 n-gram 子串） */
function extractKeywords(projectName: string): string[] {
  const parts = projectName.split(/[\s·\-\/]+/).filter((p) => p.length > 0);
  const keywords: string[] = [];

  for (const p of parts) {
    if (/^\d+$/.test(p)) continue;
    if (KEYWORD_BLOCKLIST.has(p) || KEYWORD_BLOCKLIST.has(p.toUpperCase())) continue;

    // 英文词（无中文）
    if (!/[一-鿿]/.test(p)) {
      if (p.length >= 3 || /^[A-Z]{3,}$/.test(p)) keywords.push(p);
      continue;
    }

    // 中文词：完整词 + 2-gram + 3-gram 子串（提高命中率）
    keywords.push(p);
    if (p.length >= 3) {
      for (let i = 0; i <= p.length - 2; i++) {
        const bg = p.slice(i, i + 2);
        if (!KEYWORD_BLOCKLIST.has(bg)) keywords.push(bg);
      }
    }
    if (p.length >= 4) {
      for (let i = 0; i <= p.length - 3; i++) {
        const tg = p.slice(i, i + 3);
        if (!KEYWORD_BLOCKLIST.has(tg)) keywords.push(tg);
      }
    }
  }

  return [...new Set(keywords)];
}

/** 通用兜底分类（静态定义，匹配不到项目时使用） */
export const GENERIC_CATEGORIES: Array<{ key: string; emoji: string; name: string; keywords: string[] }> = [
  { key: '__meeting__', emoji: '🎙️', name: '会议纪要', keywords: ['智能纪要', '文字记录', '会议', '研讨', '讨论'] },
  { key: '__guide__', emoji: '📖', name: '指南与材料', keywords: ['新人指引', '入职指南', '培训', '手册', '教程'] },
  { key: '__report__', emoji: '📊', name: '报告与汇总', keywords: ['亮点汇总', '工作记录', '总结', '报告'] },
  { key: '__bitable__', emoji: '📊', name: '多维表', keywords: [] },
  { key: '__image__', emoji: '🖼️', name: '图片', keywords: [] },
  { key: '__other__', emoji: '📁', name: '其他', keywords: [] },
];

export interface ProjectMapEntry {
  key: string;
  emoji: string;
  name: string;
  keywords: string[];
  systemType?: string;
  treeRoot?: string;          // 来源 vault 根目录（projectRoots），供项目 Tab 树形分组
}

/** 合并 PROJECT_META + vault 自动扫描的项目（vault 优先，META 仅补充 emoji/name/systemType） */
export function mergeProjectMaps(
  metaProjects: Array<{ key: string; emoji: string; name: string; systemType?: string }>,
  scannedProjects: Array<{ folderName: string; name: string; emoji: string; systemType?: string; treeRoot?: string }>,
): ProjectMapEntry[] {
  const map = new Map<string, ProjectMapEntry>();
  // 先建 META 索引（查 emoji/name/systemType 用）
  const metaIndex = new Map<string, { emoji: string; name: string; systemType?: string }>();
  for (const p of metaProjects) metaIndex.set(p.key, { emoji: p.emoji, name: p.name, systemType: p.systemType });

  // vault 扫描优先（只显示真实存在的文件夹）
  for (const s of scannedProjects) {
    const meta = metaIndex.get(s.folderName);
    map.set(s.folderName, {
      key: s.folderName,
      emoji: meta?.emoji || s.emoji,
      name: meta?.name || s.name,
      keywords: extractKeywords(meta?.name || s.name),
      systemType: s.systemType || meta?.systemType || '其他',
      treeRoot: s.treeRoot,
    });
  }

  // PROJECT_META 中有但 vault 中不存在的（仅你自己 vault 的项目，共享时不显示）
  // 不添加——避免别人看到你的项目

  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, 'zh'));
}

function matchFile(name: string, projects: ProjectMapEntry[]): string | null {
  const n = name.toLowerCase();
  let bestKey: string | null = null;
  let bestLen = 0;

  // 找最长匹配关键词，而非第一个匹配
  for (const proj of projects) {
    for (const kw of proj.keywords) {
      if (kw.length > bestLen && kw.length >= 2 && n.includes(kw.toLowerCase())) {
        bestKey = proj.key;
        bestLen = kw.length;
      }
    }
  }
  return bestKey;
}

function isImageFile(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico|tiff|heic)$/i.test(name);
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** 按文件类型分组（不参与项目匹配） */
export function groupDriveByType(allFiles: DriveFile[]): DriveProjectGroup[] {
  const categories: Array<{ key: string; emoji: string; name: string; match: (f: DriveFile) => boolean }> = [
    { key: '__bitable__', emoji: '📊', name: '多维表', match: (f) => f.type === 'bitable' },
    { key: '__meeting__', emoji: '🎙️', name: '会议纪要', match: (f) => /智能纪要|文字记录|会议|研讨|讨论/.test(f.name) },
    { key: '__image__', emoji: '🖼️', name: '图片', match: (f) => isImageFile(f.name) },
    { key: '__markdown__', emoji: '📝', name: 'MD文档', match: (f) => isMarkdown(f.name) },
    { key: '__docx__', emoji: '☁️', name: '云文档', match: (f) => ['docx', 'doc', 'sheet', 'slides', 'mindnote'].includes(f.type) },
    { key: '__other__', emoji: '📁', name: '其他', match: () => true },
  ];

  const map = new Map<string, DriveFile[]>();
  for (const cat of categories) map.set(cat.key, []);

  for (const f of allFiles) {
    for (const cat of categories) {
      if (cat.match(f)) { map.get(cat.key)!.push(f); break; }
    }
  }

  const groups: DriveProjectGroup[] = [];
  for (const cat of categories) {
    const files = map.get(cat.key) || [];
    groups.push({ key: cat.key, emoji: cat.emoji, name: cat.name, files });
  }

  // 通用分类保持定义顺序
  return groups;
}

function matchGeneric(name: string): string {
  // 图片优先单独归类
  if (isImageFile(name)) return '__image__';

  const n = name.toLowerCase();
  let bestKey = '__other__';
  let bestLen = 0;
  for (const cat of GENERIC_CATEGORIES) {
    if (cat.keywords.length === 0) continue;
    for (const kw of cat.keywords) {
      if (kw.length > bestLen && n.includes(kw.toLowerCase())) {
        bestKey = cat.key;
        bestLen = kw.length;
      }
    }
  }
  return bestKey;
}

/** 深度遍历云盘根目录所有子文件夹，收集全部文件。
 *  性能策略：
 *    1. 并发加载：同一批文件夹用 Promise.all 并发调 API（execLarkCli 每次都新建 exec，无共享状态，可安全并发）
 *    2. 增量命中：缓存 10 分钟内有效 → 直接复用结果，零 API 调用
 *  @param incremental 增量模式：使用 drive 文件夹的 10 分钟扫描缓存，过期文件夹才逐个刷新。
 *  @param forceRefreshFolders 强制全量重扫：忽略所有缓存，每个文件夹都调 API。
 *  @param maxFolders 文件夹数量上限（防失控），默认 100；超过返回 truncated。
 *  @param concurrency 并发批大小，默认 5。
 */
export async function deepScanDriveFiles(
  rootFiles: DriveFile[],
  loadFolderFn: (token: string) => Promise<DriveFile[]>,
  onProgress?: (scanned: number, total: number) => void,
  maxFolders = 100,
  excludedTokens?: string[],
  incremental = true,
  forceRefreshFolders = false,
  concurrency = 5,
): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const excluded = new Set(excludedTokens || []);
  const allFiles: DriveFile[] = [];
  const queue: DriveFile[] = rootFiles
    .filter((f) => f.type === 'folder' && !excluded.has(f.token));
  // 根目录的非文件夹直接加入
  for (const f of rootFiles) {
    if (f.type !== 'folder') allFiles.push(f);
  }

  let scanned = 0;

  while (queue.length > 0 && scanned < maxFolders) {
    // 每次取一批并发处理，避免逐级串行等待（串行 100 文件夹 ≈ 100 次 API 往返）
    const batch = queue.splice(0, Math.max(1, concurrency));
    scanned += batch.length;
    onProgress?.(scanned, maxFolders);

    // 并发加载本批文件夹的子内容
    const childrenBatch = await Promise.all(batch.map(async (item) => {
      try {
        let children: DriveFile[];
        const cacheKey = item.token || '__root__';
        if (incremental && !forceRefreshFolders) {
          // 增量命中：缓存 10 分钟内有效 → 直接复用，零 API 调用
          const cached = _driveCache.get(cacheKey);
          if (cached && (Date.now() - cached.time) < DRIVE_SCAN_CACHE_MS) {
            children = cached.files;
          } else {
            // 过期 → 刷新该文件夹（写回工作副本缓存，后续增量复用）
            children = await loadFolderFn(item.token);
          }
        } else {
          children = await loadFolderFn(item.token);
        }
        return { token: item.token, children, error: null };
      } catch (err) {
        // 跳过无权限/失败的文件夹，不中断整体扫描
        return { token: item.token, children: [], error: String(err) };
      }
    }));

    // 汇总：文件直接收集，子文件夹入队继续
    for (const r of childrenBatch) {
      for (const child of r.children) {
        if (child.type === 'folder') {
          if (!excluded.has(child.token)) queue.push(child);
        } else {
          allFiles.push(child);
        }
      }
    }
  }

  onProgress?.(scanned, maxFolders);
  return { files: allFiles, truncated: queue.length > 0 };
}

/** 按 Obsidian 项目分组所有云盘文件 */
export function groupDriveByProject(allFiles: DriveFile[], projectList: ProjectMapEntry[], fileOverrides?: Record<string, string>): DriveProjectGroup[] {
  const map = new Map<string, DriveFile[]>();
  const projectRootMap = new Map<string, string>();

  // 初始化项目桶
  for (const proj of projectList) {
    map.set(proj.key, []);
    if (proj.treeRoot) projectRootMap.set(proj.key, proj.treeRoot);
  }
  for (const cat of GENERIC_CATEGORIES) map.set(cat.key, []);

  // 项目视图归类：仅可分类文件参与项目匹配，不可分类文件直接跳过（不展示）
  /** 是否属于可分类的文件类型：云文档(docx/doc/sheet/slides/mindnote)、多维表(bitable)、会议纪要（不含文字记录） */
  function isClassifiable(f: DriveFile): boolean {
    // 文字记录一律排除（名称含"文字记录"的都不进入项目视图）
    if (/文字记录/.test(f.name)) return false;
    const docTypes = ['docx', 'doc', 'sheet', 'slides', 'mindnote'];
    if (docTypes.includes(f.type)) return true;
    if (f.type === 'bitable') return true;
    if (/智能纪要|会议|研讨|讨论/.test(f.name)) return true;
    return false;
  }

  for (const f of allFiles) {
    // 不可分类的文件完全不进入项目视图
    if (!isClassifiable(f)) continue;

    // 用户手动覆盖优先
    const overrideKey = fileOverrides?.[f.token];
    if (overrideKey && map.has(overrideKey)) {
      map.get(overrideKey)!.push(f);
      continue;
    }

    const projKey = matchFile(f.name, projectList);
    if (projKey) {
      map.get(projKey)!.push(f);
    } else {
      map.get('__other__')!.push(f);
    }
  }

  // 构建结果 — 所有项目都显示，即使 0 个文件（UI 树形展示时由面板过滤 0 文件项目）
  // treeRoot 取自项目来源根目录（mergeProjectMaps 透传 scanProjects 的 source）
  const groups: DriveProjectGroup[] = [];
  for (const proj of projectList) {
    groups.push({
      key: proj.key,
      emoji: proj.emoji,
      name: proj.name,
      files: map.get(proj.key) || [],
      systemType: proj.systemType,
      treeRoot: projectRootMap.get(proj.key),
    });
  }
  // 追加「待分配」分组：可分类但未匹配到任何项目的文件
  const unassignedFiles = map.get('__other__') || [];
  if (unassignedFiles.length > 0) {
    groups.push({ key: '__unassigned__', emoji: '📥', name: '待分配', files: unassignedFiles });
  }

  groups.sort((a, b) => b.files.length - a.files.length);
  return groups;
}

// ===== 文件统计信息 =====

/** 文件统计信息（访问人数/次数） */
export interface StatisticsInfo {
  uvCount: number;  // 独立访客数
  pvCount: number;  // 页面浏览量
}

/** 获取单个文件的统计信息（访问人数/次数） */
export async function getFileStatistics(fileToken: string, fileType: string = 'docx'): Promise<StatisticsInfo | null> {
  const conn = await checkConnection();
  if (conn.status !== 'ready') return null;

  const result = await execLarkCli([
    'drive', 'file.statistics', 'get',
    '--file-token', fileToken,
    '--file-type', fileType,
    '--format', 'json',
  ]);

  if (!result.ok) return null;

  const stats = result.data?.statistics;
  if (!stats) return null;

  return {
    uvCount: stats.uv ?? 0,
    pvCount: stats.pv ?? 0,
  };
}

/** 批量获取文件统计信息（带 200ms 节流） */
export async function batchGetStatistics(
  files: Array<{ token: string; type: string }>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Map<string, StatisticsInfo>> {
  const map = new Map<string, StatisticsInfo>();
  for (let i = 0; i < files.length; i++) {
    const { token, type } = files[i];
    const stats = await getFileStatistics(token, type);
    if (stats) map.set(token, stats);
    onProgress?.(i + 1, files.length);
    await new Promise((r) => setTimeout(r, 200));
  }
  return map;
}

export function clearAllCaches(): void {
  _connectionCache = null;
  _spacesCache = null;
  _nodesCache.clear();
  _driveCache.clear();
  _cachedCliPath = null;
  _baseUrl = '';
  _connectionCacheTime = 0;
  _spacesCacheTime = 0;
}
