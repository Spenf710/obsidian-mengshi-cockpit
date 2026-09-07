/**
 * 任务数据层（Phase 9/10 旧版任务看板，已下线，代码保留待重构复用）
 *
 * 原设计：独立任务清单 + 四状态机（排队/审查/loop/完结）。
 * 已决定移除任务看板 UI，转向「目标→计划→多轮自动执行→感知→继续/停止」的自主 loop 机制。
 * 保留 CRUD + runLoop CLI 封装，后续作为 loop 工程的底层组件复用。
 */

import { App, TFile, Notice } from 'obsidian';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getTaskStorePath, getSessionConfig } from './settings';

// ===== 类型 =====

export type TaskStatus = '排队' | '审查' | 'loop' | '完结';

export const TASK_STATUS_LIST: TaskStatus[] = ['排队', '审查', 'loop', '完结'];

export interface SessionTask {
  /** 文件 vault 相对路径 */
  path: string;
  /** 文件名（去 .md） */
  id: string;
  title: string;
  status: TaskStatus;
  /** 归属项目目录相对路径，如「项目管理-系统/8.猛士驾驶舱插件」 */
  project: string | null;
  /** 挂载的会话 sessionId 列表 */
  sessionIds: string[];
  priority: '高' | '中' | '低' | '';
  created: string;
  /** 更新时间戳 */
  updated: string;
}

// ===== 工具 =====

const STATUS_NEXT: Record<TaskStatus, TaskStatus | null> = {
  '排队': '审查',
  '审查': 'loop',
  'loop': '完结',
  '完结': null,
};

/** 状态机推进，到终态停留 */
export function nextStatus(s: TaskStatus): TaskStatus | null {
  return STATUS_NEXT[s] ?? null;
}

/** 生成任务文件名：YYYYMMDD-HHmm-标题片段.md */
function genTaskFileName(title: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const frag = title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 30).trim() || 'untitled';
  return `${stamp}-${frag}.md`;
}

/** 新建任务初始正文模板 */
function initialBody(title: string, project: string | null): string {
  const projLine = project ? `> 归属项目：[[${project}]]` : '> 归属项目：（未指定）';
  return `# ${title}

${projLine}

## 任务描述


## 审查意见


## loop 历史

> 每次 loop 起新会话后自动在此记录。

---
> 任务态由猛士驾驶舱会话面板管理，请勿手改 frontmatter 的 status/session_ids。
`;
}

// ===== 路径 =====

function taskStore(): string {
  return getTaskStorePath();
}

/** 确保任务存储目录存在（vault 内相对路径） */
async function ensureStoreDir(app: App): Promise<void> {
  const store = taskStore();
  if (store.endsWith('.md')) return; // 用户误配成文件，不自动建
  if (!app.vault.getAbstractFileByPath(store)) {
    try {
      await app.vault.createFolder(store);
    } catch {
      // 可能已存在，忽略
    }
  }
}

// ===== 读取 =====

/** 扫描任务存储目录下的所有任务 */
export async function scanTasks(app: App): Promise<SessionTask[]> {
  const store = taskStore();
  const folder = app.vault.getAbstractFileByPath(store);
  if (!folder || !('children' in folder)) return [];

  const tasks: SessionTask[] = [];
  const files = (folder as any).children?.filter((f: any) => f instanceof TFile && f.path.endsWith('.md')) ?? [];
  for (const f of files as TFile[]) {
    const t = await parseTaskFile(app, f);
    if (t) tasks.push(t);
  }
  tasks.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return tasks;
}

/** 从单个文件解析任务 */
async function parseTaskFile(app: App, file: TFile): Promise<SessionTask | null> {
  try {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return null;
    const status = (fm.status as TaskStatus) || '排队';
    const sessionIds = Array.isArray(fm.session_ids) ? fm.session_ids : (fm.session_ids ? [fm.session_ids] : []);
    return {
      path: file.path,
      id: file.basename,
      title: fm.title || file.basename,
      status,
      project: fm.project || null,
      sessionIds,
      priority: fm.priority || '',
      created: fm.created || file.stat.ctime?.toString() || '',
      updated: file.stat.mtime?.toString() || '',
    };
  } catch {
    return null;
  }
}

// ===== 创建 =====

export async function createTask(
  app: App,
  opts: { title: string; project: string | null; priority: '高' | '中' | '低' | ''; status?: TaskStatus; initialSessionId?: string },
): Promise<SessionTask | null> {
  await ensureStoreDir(app);
  const fileName = genTaskFileName(opts.title);
  const filePath = `${taskStore()}/${fileName}`;
  const created = new Date().toISOString().slice(0, 10);
  const status = opts.status || '排队';
  const sessionIds = opts.initialSessionId ? [opts.initialSessionId] : [];

  const frontmatterLines = [
    '---',
    `title: "${opts.title.replace(/"/g, '\\"')}"`,
    `status: ${status}`,
    `project: ${opts.project ? `"${opts.project}"` : 'null'}`,
    `priority: ${opts.priority || '""'}`,
    `created: ${created}`,
    `session_ids: [${sessionIds.map((s) => `"${s}"`).join(', ')}]`,
    'tags: [会话任务, Claude]',
    '---',
    '',
  ].join('\n');
  const content = frontmatterLines + initialBody(opts.title, opts.project);

  try {
    const file = await app.vault.create(filePath, content);
    return await parseTaskFile(app, file);
  } catch (e: any) {
    new Notice(`创建任务失败：${e?.message || e}`);
    return null;
  }
}

// ===== 状态机 =====

export async function updateStatus(app: App, task: SessionTask, status: TaskStatus): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.status = status;
  });
  task.status = status;
}

/** 推进到下一态，到终态停留并提示 */
export async function advanceStatus(app: App, task: SessionTask): Promise<TaskStatus | null> {
  const nx = nextStatus(task.status);
  if (!nx) {
    new Notice('任务已在终态「完结」');
    return null;
  }
  await updateStatus(app, task, nx);
  return nx;
}

// ===== 会话挂载 =====

export async function attachSession(app: App, task: SessionTask, sessionId: string): Promise<void> {
  if (!sessionId || task.sessionIds.includes(sessionId)) return;
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const arr = Array.isArray(fm.session_ids) ? fm.session_ids : (fm.session_ids ? [fm.session_ids] : []);
    if (!arr.includes(sessionId)) arr.push(sessionId);
    fm.session_ids = arr;
  });
  task.sessionIds = [...task.sessionIds, sessionId];
}

export async function detachSession(app: App, task: SessionTask, sessionId: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const arr = Array.isArray(fm.session_ids) ? fm.session_ids : [];
    fm.session_ids = arr.filter((s: string) => s !== sessionId);
  });
  task.sessionIds = task.sessionIds.filter((s) => s !== sessionId);
}

// ===== 项目/标题/优先级编辑 =====

export async function updateTaskMeta(
  app: App,
  task: SessionTask,
  meta: { title?: string; project?: string | null; priority?: '高' | '中' | '低' | '' },
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (meta.title !== undefined) fm.title = meta.title;
    if (meta.project !== undefined) fm.project = meta.project;
    if (meta.priority !== undefined) fm.priority = meta.priority;
  });
  if (meta.title !== undefined) task.title = meta.title;
  if (meta.project !== undefined) task.project = meta.project;
  if (meta.priority !== undefined) task.priority = meta.priority;
}

// ===== 删除 =====

export async function deleteTask(app: App, task: SessionTask): Promise<void> {
  const file = app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.trashFile(file);
}

// ===== Phase 10: loop 起新会话 =====

/** 解析 .cmd 包装脚本 → (node, [cli.js])，使 Windows 下可无 shell 直跑，规避 shell 注入面 */
function parseCmdWrapper(cmdPath: string): { cmd: string; args: string[] } | null {
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    const dir = path.dirname(cmdPath) + path.sep;
    const expand = (p: string) => p.replace(/%~dp0/gi, dir);
    // npm .cmd 包装内形如：node "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
    const m = text.match(/"([^"]*\.js)"/i);
    if (m) {
      const js = expand(m[1].trim());
      if (js && fs.existsSync(js)) {
        return { cmd: 'node', args: [js] };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 解析 claude 可执行目标：优先解析为可直接 spawn 的 (cmd, 前置 args)，避免依赖 shell。返回 null 表示不可用。 */
function resolveClaudeCli(): { cmd: string; args: string[] } | null {
  const cfg = getSessionConfig();

  const useFile = (p: string): { cmd: string; args: string[] } | null => {
    const low = p.toLowerCase();
    if (low.endsWith('.cmd') || low.endsWith('.bat')) return parseCmdWrapper(p);
    if (fs.existsSync(p)) return { cmd: p, args: [] }; // 直接可执行（exe/无扩展脚本）
    return null;
  };

  // 1. 用户配置（优先，存在性 + 可执行性校验）
  if (cfg.claudeCliPath && cfg.claudeCliPath.trim()) {
    const r = useFile(cfg.claudeCliPath.trim());
    if (r) return r;
    return null; // 配置了但不可用 → 尽快失败，避免黑盒
  }

  // 2. Windows 自动探测：npm 全局布局（claude.cmd → cli.js，或直接 cli.js / claude.exe）
  if (process.platform === 'win32') {
    const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
    const candidates = npmDir ? [
      path.join(npmDir, 'claude.cmd'),
      path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      path.join(npmDir, 'claude.exe'),
    ] : [];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = useFile(c);
      if (r) return r;
    }
  }

  // 3. POSIX：PATH 中的 claude 走 shebang 可执行，spawn 无 shell 直接运行，安全
  if (process.platform !== 'win32') {
    return { cmd: 'claude', args: [] };
  }

  // Windows 且未能在已知位置解析到可直跑文件 → 明确报错（引导用户到设置页配置完整路径）
  return null;
}

export interface LoopResult {
  ok: boolean;
  newSessionId?: string;
  error?: string;
  output?: string;
}

/** 统一子进程执行管道：error / stdout / stderr / close 解析与回写。settle 保证只 resolve 一次。 */
function pumpLoopProcess(
  child: ReturnType<typeof spawn>,
  app: App,
  task: SessionTask,
  prompt: string,
  settle: (r: LoopResult) => void,
): void {
  let stdout = '';
  let stderr = '';

  child.on('error', (err: any) => {
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL') {
      settle({ ok: false, error: '未找到 claude CLI，请安装 Claude Code 或检查设置页「claude CLI 路径」' });
    } else {
      settle({ ok: false, error: `CLI 启动失败：${err?.message || err}` });
    }
  });

  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
    if (stdout.length > 4 * 1024 * 1024) {
      child.kill();
      settle({ ok: false, error: 'CLI 输出超限' });
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 4 * 1024 * 1024) {
      child.kill();
      settle({ ok: false, error: 'CLI 错误输出超限' });
    }
  });

  child.on('close', async () => {
    // 回填 frontmatter + 正文 loop 历史
    const parseAndWrite = async (): Promise<LoopResult> => {
      if (!stdout.trim()) {
        return { ok: false, error: 'CLI 无输出', output: stderr.slice(0, 500) };
      }
      let obj: any;
      try {
        obj = JSON.parse(stdout);
      } catch {
        return { ok: false, error: '无法解析 CLI 输出 JSON', output: stdout.slice(0, 500) };
      }
      if (obj.is_error) {
        return { ok: false, error: `Claude 返回错误：${obj.api_error_status || obj.result || ''}`, output: stdout.slice(0, 500) };
      }
      const newId = obj.session_id as string | undefined;
      if (!newId) {
        return { ok: false, error: 'CLI 输出未含 session_id', output: stdout.slice(0, 500) };
      }

      const file = app.vault.getAbstractFileByPath(task.path);
      if (file instanceof TFile) {
        try {
          await app.fileManager.processFrontMatter(file, (fm) => {
            const arr = Array.isArray(fm.session_ids) ? fm.session_ids : (fm.session_ids ? [fm.session_ids] : []);
            if (!arr.includes(newId)) arr.push(newId);
            fm.session_ids = arr;
          });
          task.sessionIds = [...task.sessionIds, newId];
          const dateStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const entry = `\n- [${dateStr}] loop → 会话 \`${newId.slice(0, 8)}…\` 起新，指令：${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}\n`;
          await app.vault.process(file, (content) => {
            const marker = '## loop 历史';
            const idx = content.indexOf(marker);
            if (idx === -1) return content + entry;
            const afterMarker = content.indexOf('\n##', idx + marker.length);
            const insertPos = afterMarker === -1 ? content.length : afterMarker;
            return content.slice(0, insertPos) + entry + content.slice(insertPos);
          });
        } catch (e: any) {
          return { ok: false, error: `新会话已创建但回写失败：${e?.message || e}`, output: newId };
        }
      }
      return { ok: true, newSessionId: newId };
    };

    settle(await parseAndWrite());
  });
}

/**
 * 用 claude CLI 起新会话（fork 分叉）：保留原会话上下文，生成独立新 session。
 * 成功后：新 session_id 回填 frontmatter session_ids + 正文追加 loop 历史条目。
 * 安全：不经过 shell（Windows 直接 node cli.js 或 exe），参数数组由 Node 逐项传递。
 * @param prompt 发给新会话的首条指令（任务描述+审查意见）
 */
export function runLoop(app: App, task: SessionTask, prompt: string): Promise<LoopResult> {
  return new Promise((resolve) => {
    const cli = resolveClaudeCli();
    if (!cli) {
      resolve({ ok: false, error: '未找到可用的 claude CLI，请在设置页「claude CLI 路径」填写 cli.js 或可执行文件的完整路径' });
      return;
    }

    // 会话 id 白名单校验，杜绝非 UUID 输入注入
    const newSession = task.sessionIds[task.sessionIds.length - 1] || '';
    if (newSession && !/^[0-9a-fA-F-]{8,64}$/.test(newSession)) {
      resolve({ ok: false, error: '会话 id 非法，已中止 loop' });
      return;
    }

    // 组装参数数组（数组传参 + 无 shell → Node 逐项转义，无注入面）
    const args: string[] = [...cli.args];
    if (newSession) args.push('--resume', newSession, '--fork-session');
    const promptArg = prompt.replace(/\n/g, ' ').slice(0, 4000);
    args.push('--print', '--output-format', 'json', '-p', promptArg);

    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (r: LoopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // 180s 超时兜底
    const timer = window.setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      settle({ ok: false, error: 'CLI 执行超时（180s）' });
    }, 180000);

    try {
      child = spawn(cli.cmd, args, { windowsHide: true });
    } catch (e: any) {
      settle({ ok: false, error: `CLI 启动失败：${e?.message || e}` });
      return;
    }

    pumpLoopProcess(child, app, task, prompt, settle);
  });
}

// ===== Phase 10: 完结本地归档 =====

/** 结束任务时，把任务摘要追加写入会话任务/已完结归档.md（纯本地轻量归档，不调 Skill） */
export async function finishTask(app: App, task: SessionTask): Promise<void> {
  const archivePath = `${taskStore()}/已完结归档.md`;
  const dateStr = new Date().toISOString().slice(0, 10);
  const projCell = task.project ? `[[${task.project}]]` : '—';
  const sessCell = task.sessionIds.length
    ? task.sessionIds.map((s) => `\`${s.slice(0, 8)}…\``).join(' ')
    : '—';
  const row = `| ${dateStr} | ${projCell} | ${task.title} | ${(task.priority as string) || '—'} | ${task.sessionIds.length} | ${sessCell} |`;

  const sepLine = '|------|------|------|--------|----------|----------|';
  const f = app.vault.getAbstractFileByPath(archivePath);

  if (!(f instanceof TFile)) {
    // 文件不存在：创建表头 + 首行
    const content = `# 已完结任务归档

> 任务完结时自动追写。新条目在表格顶部。

| 完结日期 | 项目 | 任务 | 优先级 | loop 次数 | 挂载会话 |
${sepLine}
${row}
`;
    await app.vault.create(archivePath, content);
    return;
  }

  // 文件已存在：插到分隔行后（新行在上）
  let old = await app.vault.read(f);
  const sepIdx = old.indexOf(sepLine);
  if (sepIdx === -1) {
    // 缺分隔行（如旧文件被手改）：重建标准表头，旧表格行作为历史数据保留在分隔行下
    const header = `# 已完结任务归档\n\n> 任务完结时自动追写。新条目在表格顶部。\n\n| 完结日期 | 项目 | 任务 | 优先级 | loop 次数 | 挂载会话 |\n${sepLine}\n${row}\n`;
    await app.vault.modify(f, header + old);
  } else {
    old = old.slice(0, sepIdx + sepLine.length) + '\n' + row + old.slice(sepIdx + sepLine.length);
    await app.vault.modify(f, old);
  }
}