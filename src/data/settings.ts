import type { Plugin } from 'obsidian';

// ===== 飞书配置 =====
export interface FeishuConfig {
  /** lark-cli 自定义路径（空字符串 = 自动检测） */
  larkCliPath: string;
  /** 监控的飞书空间 ID 列表 */
  spaces: string[];
  /** 刷新间隔（秒），0 = 手动刷新 */
  refreshInterval: number;
  /** 上次同步时间 */
  lastSyncAt: string | null;
  /** 扫描时排除的文件夹 token 列表 */
  excludedFolders: string[];
  /** 缓存的项目分组结果 */
  cachedProjectGroups?: any[];
  /** 缓存的类型分组结果 */
  cachedTypeGroups?: any[];
  /** 缓存的智能纪要 */
  cachedMinutes?: any[];
  /** 文件归属手动覆盖：fileToken → projectKey */
  fileOverrides?: Record<string, string>;
  /** 深度扫描文件夹上限（默认 100，超过自动截断） */
  scanFolderLimit?: number;
  /** 深度扫描并发批大小（默认 5，云盘多文件夹时加快速度） */
  scanConcurrency?: number;
}

const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  larkCliPath: '',
  spaces: [],
  refreshInterval: 300,
  lastSyncAt: null,
  excludedFolders: [],
  scanFolderLimit: 100,
  scanConcurrency: 5,
};

// ===== 类型 =====
export interface GanttOverride {
  start?: string;
  end?: string;
  progress?: number;
  milestones?: { date: string; label: string; icon?: string }[];
  phases?: { id: string; label: string; start: string; end: string; progress: number }[];
}

// ===== 会话管理配置 =====
export interface SessionConfig {
  /** Claude 会话根目录（默认 ~/.claude/projects），存放各 vault 的 .jsonl */
  sessionRootDir: string;
  /** claude CLI 路径（空 = 自动检测，loop 功能用） */
  claudeCliPath: string;
  /** 会话存档目录（绝对路径），空 = 默认 ~/.claude/archives（独立于清理扫描，且不在 ~/.claude/projects 内） */
  archiveDir: string;
  /** CodeM 会话根目录（默认 ~/.codem/sessions），存放各项目目录的 .jsonl */
  codemRootDir: string;
  /** codem CLI 路径（空 = 自动检测，「在 CodeM 中打开」用） */
  codemCliPath: string;
  /** 收割技能名集合（默认 ['session-harvest']），匹配你的收割 SKILL 名；逗号分隔填多个 */
  harvestSkillNames?: string[];
}

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  sessionRootDir: '',
  claudeCliPath: '',
  archiveDir: '',
  codemRootDir: '',
  codemCliPath: '',
  harvestSkillNames: ['session-harvest'],
};

export interface ProjectMetaOverride {
  systemType?: string;
  tag?: string;
  emoji?: string;
}

interface GanttOverridesData {
  [projectId: string]: GanttOverride;
}

interface ProjectUrlsData {
  [folderName: string]: string;
}

// ===== 插件配置 =====
export interface PluginConfig {
  diaryTemplate: string;
  workLogPath: string;
  projectRoots: string[];
  baseCategories: string[];
  baseTags: string[];
  /** 会话任务存储目录（vault 内相对路径，存放独立任务清单 md） */
  taskStorePath: string;
  /** 可见 Tab 页配置：key 为 tabKey，true=显示 */
  visibleTabs: Record<string, boolean>;
}

const DEFAULT_CONFIG: PluginConfig = {
  diaryTemplate: 'templates/工作日志.md',
  workLogPath: '工作日志',
  projectRoots: [],
  baseCategories: ['通用', '其他'],
  baseTags: ['通用'],
  taskStorePath: '会话任务',
  visibleTabs: {
    calendar: true,
    projects: true,
    todos: true,
    gantt: true,
    feishu: true,
    sessions: true,
  },
};

interface PluginData {
  config?: PluginConfig;
  projectUrls?: ProjectUrlsData;
  ganttOverrides?: GanttOverridesData;
  projectMetaOverrides?: Record<string, ProjectMetaOverride>;
  customCategories?: string[];
  customTags?: string[];
  domainIcons?: Record<string, string>;
  feishu?: FeishuConfig;
  session?: SessionConfig;
  /** 会话标题手动覆盖：sessionId → 自定义标题 */
  sessionTitleOverrides?: Record<string, string>;
  /** 会话项目归属手动覆盖：sessionId → projectPath；null = 显式不归属（区别于未设置） */
  sessionProjectOverrides?: Record<string, string | null>;
}

export function getConfig(): PluginConfig {
  const cfg = { ...DEFAULT_CONFIG, ...dataCache.config };
  // 空值归一化（新用户零配置时兜底，避免空路径前缀导致扫描异常）
  if (!cfg.workLogPath || !cfg.workLogPath.trim()) cfg.workLogPath = '工作日志';
  return cfg;
}

/** 任务存储目录路径（保证非空，兜底默认值） */
export function getTaskStorePath(): string {
  const p = getConfig().taskStorePath;
  return p && p.trim() ? p.trim() : '会话任务';
}

export async function setConfig(config: PluginConfig): Promise<void> {
  dataCache.config = config;
  await persist();
}

export async function resetConfig(): Promise<void> {
  dataCache.config = undefined;
  await persist();
}

// ===== 实例 =====
let pluginInstance: Plugin | null = null;
let dataCache: PluginData = {};
let persistQueue: Promise<void> = Promise.resolve();

/** 插件加载时调用，必须 await */
export async function initSettings(plugin: Plugin): Promise<void> {
  pluginInstance = plugin;
  dataCache = (await plugin.loadData()) ?? {};
}

/** 串行化持久化，防止并发写入互相覆盖 */
function persist(): Promise<void> {
  if (!pluginInstance) return Promise.resolve();
  persistQueue = persistQueue.then(() => pluginInstance!.saveData(dataCache));
  return persistQueue;
}

// ===== URL 管理 =====
export function getProjectUrl(folderName: string): string | null {
  return dataCache.projectUrls?.[folderName] ?? null;
}

export async function setProjectUrl(folderName: string, url: string): Promise<void> {
  if (!dataCache.projectUrls) dataCache.projectUrls = {};
  dataCache.projectUrls[folderName] = url;
  await persist();
}

export async function removeProjectUrl(folderName: string): Promise<void> {
  if (dataCache.projectUrls) {
    delete dataCache.projectUrls[folderName];
  }
  await persist();
}

// ===== 甘特图覆盖数据 =====
export function getGanttOverrides(): GanttOverridesData {
  return dataCache.ganttOverrides ?? {};
}

export async function saveGanttOverride(projectId: string, override: GanttOverride): Promise<void> {
  if (!dataCache.ganttOverrides) dataCache.ganttOverrides = {};
  dataCache.ganttOverrides[projectId] = {
    ...dataCache.ganttOverrides[projectId],
    ...override,
  };
  await persist();
}

export async function removeGanttOverride(projectId: string): Promise<void> {
  if (dataCache.ganttOverrides) {
    delete dataCache.ganttOverrides[projectId];
  }
  await persist();
}

// ===== 项目元数据覆盖 =====
export function getProjectMetaOverrides(): Record<string, ProjectMetaOverride> {
  return dataCache.projectMetaOverrides ?? {};
}

export async function saveProjectMeta(folderName: string, override: ProjectMetaOverride): Promise<void> {
  if (!dataCache.projectMetaOverrides) dataCache.projectMetaOverrides = {};
  dataCache.projectMetaOverrides[folderName] = {
    ...dataCache.projectMetaOverrides[folderName],
    ...override,
  };
  await persist();
}

export async function removeProjectMeta(folderName: string): Promise<void> {
  if (dataCache.projectMetaOverrides) {
    delete dataCache.projectMetaOverrides[folderName];
  }
  await persist();
}

// ===== 自定义类别管理 =====
/** 获取全部系统类别（配置基础 + 自定义） */
export function getAllCategories(): string[] {
  const cfg = getConfig();
  const custom = dataCache.customCategories ?? [];
  return [...new Set([...cfg.baseCategories, ...custom])];
}

export async function addCustomCategory(cat: string): Promise<void> {
  if (!dataCache.customCategories) dataCache.customCategories = [];
  if (!dataCache.customCategories.includes(cat)) {
    dataCache.customCategories.push(cat);
    await persist();
  }
}

/** 获取全部标签（配置基础 + 自定义 + 项目实际） */
export function getAllTags(projectTags?: Set<string>): string[] {
  const cfg = getConfig();
  const custom = dataCache.customTags ?? [];
  const project = projectTags ? Array.from(projectTags) : [];
  return [...new Set([...cfg.baseTags, ...project, ...custom])].sort();
}

export async function addCustomTag(v: string): Promise<void> {
  if (!dataCache.customTags) dataCache.customTags = [];
  if (!dataCache.customTags.includes(v)) {
    dataCache.customTags.push(v);
    await persist();
  }
}

/** 删除自定义类别（返回当前使用该类的项目数，>0 时拒绝删除） */
export function getCategoryUsage(cat: string): number {
  const overrides = dataCache.projectMetaOverrides ?? {};
  let count = 0;
  for (const ov of Object.values(overrides)) {
    if (ov.systemType === cat) count++;
  }
  return count;
}

export async function removeCustomCategory(cat: string): Promise<void> {
  if (!dataCache.customCategories) return;
  dataCache.customCategories = dataCache.customCategories.filter((c) => c !== cat);
  await persist();
}

export async function removeCustomTag(v: string): Promise<void> {
  if (!dataCache.customTags) return;
  dataCache.customTags = dataCache.customTags.filter((c) => c !== v);
  await persist();
}

// ===== 领域图标 =====
// 领域图标（与项目图标不重叠）
const DOMAIN_ICONS = ['🚀','💻','🚗','🏭','🔍'];

export function getDomainIcon(rootName: string): string {
  const saved = dataCache.domainIcons?.[rootName];
  if (saved) return saved;
  // 自动分配：取未被占用的第一个图标
  const used = new Set(Object.values(dataCache.domainIcons ?? {}));
  return DOMAIN_ICONS.find((i) => !used.has(i)) ?? '📁';
}

export async function setDomainIcon(rootName: string, icon: string): Promise<void> {
  if (!dataCache.domainIcons) dataCache.domainIcons = {};
  dataCache.domainIcons[rootName] = icon;
  await persist();
}

// ===== 飞书配置管理 =====
export function getFeishuConfig(): FeishuConfig {
  return { ...DEFAULT_FEISHU_CONFIG, ...dataCache.feishu };
}

export async function setFeishuConfig(config: Partial<FeishuConfig>): Promise<void> {
  dataCache.feishu = { ...DEFAULT_FEISHU_CONFIG, ...dataCache.feishu, ...config };
  await persist();
}

// ===== 会话配置管理 =====
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** 解析会话根目录：用户配置 > 默认 ~/.claude/projects */
export function getSessionRootDir(): string {
  const cfg = getSessionConfig();
  if (cfg.sessionRootDir) return cfg.sessionRootDir;
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 解析会话存档目录：用户配置 > 默认 ~/.claude/archives
 *  默认值 2026-09-14 从 ~/.claude/projects/_archived 迁出：
 *  Claude 30 天清理递归扫 ~/.claude/projects 全树，子目录存档副本被误清；
 *  ~/.claude/archives 在清理范围之外，存档副本不再被自动删除。 */
export function getSessionArchiveDir(): string {
  const cfg = getSessionConfig();
  if (cfg.archiveDir) return cfg.archiveDir;
  return path.join(os.homedir(), '.claude', 'archives');
}

/** 解析 CodeM 会话根目录：用户配置 > 默认 ~/.codem/sessions */
export function getCodemRootDir(): string {
  const cfg = getSessionConfig();
  if (cfg.codemRootDir) return cfg.codemRootDir;
  return path.join(os.homedir(), '.codem', 'sessions');
}

/** 解析 codem CLI 路径：用户配置 > 自动检测（~/.codem/bin/codem.cmd） > 'codem' */
export function getCodemCliPath(): string {
  const cfg = getSessionConfig();
  if (cfg.codemCliPath) return cfg.codemCliPath;
  // 实测：codem 未进入 PATH，安装器固定生成 ~/.codem/bin/codem.cmd（Node 启动器）
  const candidate = path.join(os.homedir(), '.codem', 'bin', 'codem.cmd');
  return fs.existsSync(candidate) ? candidate : 'codem';
}

/** 收割技能名集合（默认 ['session-harvest']）；检测会话是否执行过收割时按此名单匹配。
 *  兼容各自不同的命名——自己的收割 SKILL 只要把配置改成对应名字即可识别。 */
export function getHarvestSkillNames(): string[] {
  const names = getSessionConfig().harvestSkillNames;
  if (Array.isArray(names) && names.length > 0) {
    return names.map((n) => String(n).trim()).filter(Boolean);
  }
  return ['session-harvest'];
}

export async function setHarvestSkillNames(names: string[]): Promise<void> {
  await setSessionConfig({ harvestSkillNames: names.map((n) => String(n).trim()).filter(Boolean) });
}

export function getSessionConfig(): SessionConfig {
  return { ...DEFAULT_SESSION_CONFIG, ...dataCache.session };
}

export async function setSessionConfig(config: Partial<SessionConfig>): Promise<void> {
  dataCache.session = { ...DEFAULT_SESSION_CONFIG, ...dataCache.session, ...config };
  await persist();
}

// ===== 会话标题覆盖 =====

export function getSessionTitleOverride(sessionId: string): string | null {
  return dataCache.sessionTitleOverrides?.[sessionId] ?? null;
}

export async function setSessionTitleOverride(sessionId: string, title: string): Promise<void> {
  if (!dataCache.sessionTitleOverrides) dataCache.sessionTitleOverrides = {};
  if (title.trim()) {
    dataCache.sessionTitleOverrides[sessionId] = title.trim();
  } else {
    delete dataCache.sessionTitleOverrides[sessionId];
  }
  await persist();
}

// ===== 会话项目归属覆盖 =====

export function getSessionProjectOverride(sessionId: string): string | null | undefined {
  if (dataCache.sessionProjectOverrides && sessionId in dataCache.sessionProjectOverrides) {
    return dataCache.sessionProjectOverrides[sessionId];
  }
  return undefined; // undefined = 未设置，null = 显式设为不归属
}

export async function setSessionProjectOverride(sessionId: string, projectPath: string | null): Promise<void> {
  if (!dataCache.sessionProjectOverrides) dataCache.sessionProjectOverrides = {};
  if (projectPath) {
    dataCache.sessionProjectOverrides[sessionId] = projectPath;
  } else {
    // 显式设为 null 表示"不归属"，区别于 undefined（未设置）
    dataCache.sessionProjectOverrides[sessionId] = null;
  }
  await persist();
}

// ===== 会话覆盖清理（删除会话时调用） =====

/** 删除会话时清理其标题/归属覆盖，避免 data.json 残留孤儿记录 */
export async function removeSessionOverrides(sessionId: string): Promise<void> {
  let changed = false;
  if (dataCache.sessionTitleOverrides && sessionId in dataCache.sessionTitleOverrides) {
    delete dataCache.sessionTitleOverrides[sessionId];
    changed = true;
  }
  if (dataCache.sessionProjectOverrides && sessionId in dataCache.sessionProjectOverrides) {
    delete dataCache.sessionProjectOverrides[sessionId];
    changed = true;
  }
  if (changed) await persist();
}
