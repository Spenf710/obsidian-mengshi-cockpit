import { App, TFile } from 'obsidian';
import { getProjectUrl, getProjectMetaOverrides, getAllCategories, getAllTags, getConfig } from './settings';

// ===== 类型定义 =====
export interface ProjectInfo {
  folderName: string;
  name: string;
  emoji: string;
  folderPath: string;
  readmePath: string | null;
  description: string;
  fileCount: number;
  lastModified: number;
  tag: string;
  systemType: string;
  baseUrl: string | null;
  source: string;
}

export interface ProjectGroup {
  key: string;
  label: string;
  projects: ProjectInfo[];
}

// ===== 分类映射表（空，用户自行创建项目后自动扫描） =====
export const PROJECT_META: Record<string, {
  name: string;
  emoji: string;
  tag: string;
  systemType: string;
  description: string;
  baseUrl?: string;
}> = {};

// ===== 扫描逻辑 =====

function isReadme(file: TFile): boolean {
  return file.name.endsWith('.README.md') || file.name === 'README.md';
}

function findReadme(files: TFile[]): TFile | null {
  const pri = files.find((f) => f.name.endsWith('.README.md'));
  if (pri) return pri;
  return files.find((f) => f.name === 'README.md') ?? null;
}

function extractDescription(content: string): string | null {
  const match = content.match(/^>\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractBaseUrl(content: string): string | null {
  const match = content.match(/https:\/\/[^\s)]+\.feishu\.cn\/[^\s)]+/);
  return match ? match[0] : null;
}

// ===== 读写 README 中的云文档链接 =====
const README_URL_SECTION = '## 📊 云文档';

/** 把项目 URL 写入 README 文件 */
export async function writeUrlToReadme(
  app: App,
  folderPath: string,
  url: string,
  projectName: string,
): Promise<boolean> {
  const readme = findReadmeInFolder(app, folderPath);
  if (!readme) return false;

  const linkLine = `- [${projectName} 云文档](${url})`;

  await app.vault.process(readme, (content) => {
    const lines = content.split('\n');
    let headerLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === README_URL_SECTION) { headerLine = i; break; }
    }

    if (headerLine >= 0) {
      let found = false;
      for (let i = headerLine + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) break;
        if (/\[.+\]\(https?:\/\/.+\.feishu\.cn/.test(lines[i])) {
          lines[i] = linkLine;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.splice(headerLine + 1, 0, '', linkLine);
      }
    } else {
      lines.push('', '---', '', README_URL_SECTION, '', linkLine);
    }

    return lines.join('\n');
  });

  return true;
}

/** 从 README 中移除云文档链接 */
export async function removeUrlFromReadme(
  app: App,
  folderPath: string,
): Promise<boolean> {
  const readme = findReadmeInFolder(app, folderPath);
  if (!readme) return false;

  await app.vault.process(readme, (content) => {
    const lines = content.split('\n');
    let headerLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === README_URL_SECTION) { headerLine = i; break; }
    }
    if (headerLine < 0) return content;

    for (let i = headerLine + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break;
      if (/\[.+\]\(https?:\/\/.+\.feishu\.cn/.test(lines[i])) {
        lines[i] = '';
        break;
      }
    }
    return lines.join('\n');
  });

  return true;
}

function findReadmeInFolder(app: App, folderPath: string): TFile | null {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) return null;
  const children = (folder as any).children as TFile[] | undefined;
  if (!children) return null;
  const mdFiles = children.filter((f) => f.name.endsWith('.md'));
  return findReadme(mdFiles);
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return tags;
  const fm = frontmatterMatch[1];
  const tagLines = fm.match(/^\s*-\s+(.+)$/gm);
  if (tagLines) {
    for (const line of tagLines) {
      const tag = line.replace(/^\s*-\s+/, '').trim();
      if (tag && tag !== '项目索引') tags.push(tag);
    }
  }
  return tags;
}

function extractTableField(content: string, field: string): string | null {
  const regex = new RegExp(`\\*\\*${field}\\*\\*\\s*[：:\\|]\\s*(.+?)(?:\\s*[\\|~]|$)`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

/** 所有可用系统类别（供标签编辑下拉选择，含自定义） */
export function getCategories(): string[] {
  return getAllCategories();
}

/** 获取项目显示名 */
export function getProjectDisplayName(folderName: string): string {
  return folderName.replace(/^\d+\./, '');
}

/** 所有可用标签（供标签编辑下拉选择，含自定义） */
export function getTags(): string[] {
  const projectTags = new Set(Object.values(PROJECT_META).map((m) => m.tag));
  return getAllTags(projectTags);
}

function mapTechToSystem(tech: string): string {
  const t = tech.toLowerCase();
  if (t.includes('多维表') || t.includes('零代码')) return '多维表';
  if (t.includes('python') || t.includes('rpa')) return 'RPA自动化';
  if (t.includes('llm') || t.includes('ai') || t.includes('aily') || t.includes('claude')) return 'AI智能体';
  if (t.includes('plugin') || t.includes('插件')) return '工具开发';
  return '其他';
}

function inferEmoji(tags: string[]): string {
  const tagSet = new Set(tags);
  if (tagSet.has('AI智能体')) return '🧠';
  if (tagSet.has('RPA自动化')) return '📦';
  if (tagSet.has('多维表')) return '📋';
  if (tagSet.has('工具开发')) return '⚙';
  return '📁';
}

export async function scanProjects(app: App): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const allFiles = app.vault.getFiles();

  for (const root of getConfig().projectRoots) {
    const source = root;
    const rootPath = root + '/';

    const subFolders = new Set<string>();
    for (const file of allFiles) {
      if (file.path.startsWith(rootPath)) {
        const sub = file.path.slice(rootPath.length).split('/')[0];
        if (sub) subFolders.add(sub);
      }
    }

    for (const folderName of subFolders) {
      const folderPath = rootPath + folderName;
      const meta = PROJECT_META[folderName];

      const folderFiles = allFiles.filter((f) => f.path.startsWith(folderPath + '/'));
      const mdFiles = folderFiles.filter((f) => f.name.endsWith('.md'));
      const readme = findReadme(mdFiles);

      const fileCount = mdFiles.filter((f) => !isReadme(f)).length;

      let lastModified = 0;
      for (const f of folderFiles) {
        if (f.stat.mtime > lastModified) lastModified = f.stat.mtime;
      }

      let readmeContent = '';
      if (readme) {
        try {
          readmeContent = await app.vault.cachedRead(readme);
        } catch { /* ignore */ }
      }

      const liveDesc = extractDescription(readmeContent);
      const liveBase = extractBaseUrl(readmeContent);
      const liveTags = extractTags(readmeContent);
      const liveTech = extractTableField(readmeContent, '技术栈');
      const liveTag = extractTableField(readmeContent, '所属标签');
      const liveProjectType = extractTableField(readmeContent, '项目类型');

      if (meta) {
        const project: ProjectInfo = {
          folderName,
          name: getProjectDisplayName(folderName),
          emoji: meta.emoji,
          folderPath,
          readmePath: readme?.path ?? null,
          description: liveDesc || meta.description,
          fileCount,
          lastModified,
          tag: liveTag || meta.tag,
          systemType: liveProjectType || meta.systemType,
          baseUrl: liveBase || getProjectUrl(folderName) || meta.baseUrl || null,
          source,
        };
        const overrides = getProjectMetaOverrides();
        const ov = overrides[folderName];
        if (ov) {
          if (ov.tag !== undefined) project.tag = ov.tag;
          if (ov.systemType !== undefined) project.systemType = ov.systemType;
          if (ov.emoji !== undefined) project.emoji = ov.emoji;
        }
        projects.push(project);
      } else {
        const rawName = folderName.replace(/^\d+\./, '');
        const project: ProjectInfo = {
          folderName,
          name: rawName,
          emoji: inferEmoji(liveTags),
          folderPath,
          readmePath: readme?.path ?? null,
          description: liveDesc || '暂无描述',
          fileCount,
          lastModified,
          tag: liveTag || '通用',
          systemType: liveProjectType || (liveTech
            ? mapTechToSystem(liveTech)
            : liveTags.find((t) => getAllCategories().includes(t)) || '其他'),
          baseUrl: liveBase || getProjectUrl(folderName) || null,
          source,
        };
        const overrides = getProjectMetaOverrides();
        const ov = overrides[folderName];
        if (ov) {
          if (ov.tag !== undefined) project.tag = ov.tag;
          if (ov.systemType !== undefined) project.systemType = ov.systemType;
          if (ov.emoji !== undefined) project.emoji = ov.emoji;
        }
        projects.push(project);
      }
    }
  }

  return projects.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source, 'zh');
    return a.folderName.localeCompare(b.folderName, 'zh');
  });
}

// ===== 分组工具 =====
export function groupBySource(projects: ProjectInfo[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const sourceMap = new Map<string, ProjectInfo[]>();
  for (const p of projects) sourceMap.set(p.source, [...(sourceMap.get(p.source) ?? []), p]);
  for (const [src, projs] of sourceMap) {
    groups.push({ key: src, label: `${src}（${projs.length}）`, projects: projs });
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

export function groupByTag(projects: ProjectInfo[]): ProjectGroup[] {
  const map = new Map<string, ProjectInfo[]>();
  for (const p of projects) {
    const list = map.get(p.tag) ?? [];
    list.push(p);
    map.set(p.tag, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === '通用') return 1;
      if (b === '通用') return -1;
      return a.localeCompare(b);
    })
    .map(([key, projs]) => ({ key, label: key, projects: projs }));
}

export function groupBySystem(projects: ProjectInfo[]): ProjectGroup[] {
  const map = new Map<string, ProjectInfo[]>();
  for (const p of projects) {
    const list = map.get(p.systemType) ?? [];
    list.push(p);
    map.set(p.systemType, list);
  }
  return Array.from(map.entries())
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([key, projs]) => ({ key, label: key, projects: projs }));
}

// ===== 格式化工具 =====
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;
  const days = Math.floor(diff / 86400000);

  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}