// ===== 正文语义工具 =====
// 两个插件（猛士驾驶舱、生长）共用

// ===== 停用词 =====

export const EXCERPT_STOP_WORDS = new Set([
  '可以', '这个', '那个', '什么', '怎么', '一个', '我们', '他们', '进行',
  '使用', '通过', '没有', '不是', '以及', '因为', '所以', '如果', '或者',
  '然后', '但是', '已经', '需要', '应该', '可能', '这里', '那里', '这样',
  '那样', '之后', '之前', '其他', '其中', '这些', '那些', '所有', '每个',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from',
  'class', 'interface', 'type', 'true', 'false', 'null', 'undefined',
  'async', 'await', 'new', 'this', 'string', 'number', 'boolean', 'any',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'not',
  'but', 'are', 'was', 'were', 'been', 'has', 'had', 'does', 'did',
]);

/** 通用标题名单——这些标题出现在多个项目，不加上下文无法区分 */
export const GENERIC_TITLES = new Set([
  '背景', '背景与需求', '方案', '方案设计', '架构', '架构设计', '架构总览',
  '开发日志', '使用指南', '需求分析', '需求分析与方案设计', '可行性分析',
  '分工与计划', '分工与协作', '部署', '测试', '总结', '问题记录', '优化',
  '数据存储', '构建与部署', '迭代总结', '甘特图迭代优化', '排期面板详解',
  '功能说明', '功能说明与验证指南', '版本变化分析报告', '规格扩展方案',
  '问题修改记录', '审核结论报告', 'SKILL封装方案',
]);

// ===== 领域检测 =====

export function detectDomain(path: string): string {
  if (path.startsWith('原子笔记/')) return '原子笔记';
  if (path.startsWith('项目管理-系统/')) return '项目管理-系统';
  if (path.startsWith('项目管理-车型/')) return '项目管理-车型';
  if (path.startsWith('日常工作-通用/')) return '日常工作-通用';
  if (path.startsWith('会议记录/')) return '会议记录';
  if (path.startsWith('奇思妙想/')) return '奇思妙想';
  return '其他';
}

// ===== 中文分词（简单 n-gram） =====

export function extractKeywords(text: string, minLen = 2): string[] {
  const chineseWords = text.match(/[一-鿿]{2,}/g) ?? [];
  const englishWords = text.match(/[a-zA-Z]{2,}/g) ?? [];
  const allWords = [...chineseWords, ...englishWords.map((w) => w.toLowerCase())];
  const stopWords = new Set([
    '可以', '这个', '那个', '什么', '怎么', '一个', '我们', '他们',
    '进行', '使用', '通过', '没有', '不是', '以及', '因为', '所以',
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have',
  ]);
  return allWords.filter((w) => w.length >= minLen && !stopWords.has(w));
}

// ===== Jaccard 相似度 =====

export function tagJaccard(tagsA: string[], tagsB: string[]): number {
  if (tagsA.length === 0 && tagsB.length === 0) return 0;
  const setA = new Set(tagsA);
  const setB = new Set(tagsB);
  const intersection = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

export function kwJaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) { if (setB.has(w)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

// ===== 正文关键词提取（RAG-lite 核心） =====

/** 从正文内容提取语义关键词（去 markdown 语法、去停用词、取 TF 前 20） */
export function extractExcerptKeywords(content: string): string[] {
  let body = content;
  const fmMatch = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (fmMatch) body = body.slice(fmMatch[0].length);
  const firstNewline = body.indexOf('\n');
  if (firstNewline > 0) body = body.slice(firstNewline + 1);
  body = body.slice(0, 500);
  body = body
    .replace(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#>|=-]+/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/[^\w一-鿿\s]/g, ' ');
  const chinese = body.match(/[一-鿿]{2,}/g) ?? [];
  const english = (body.match(/[a-zA-Z]{3,}/g) ?? []).map((w) => w.toLowerCase());
  const allWords = [...chinese, ...english];
  const freq = new Map<string, number>();
  for (const w of allWords) {
    if (EXCERPT_STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

/** 从正文生成可读摘要（前 100 字，去 markdown 语法，用于 UI 展示） */
export function buildExcerpt(content: string): string {
  let body = content;
  const fmMatch = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (fmMatch) body = body.slice(fmMatch[0].length);
  const firstNewline = body.indexOf('\n');
  if (firstNewline > 0) body = body.slice(firstNewline + 1);
  body = body
    .replace(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#>|=-]+/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 100);
}

// ===== 上下文命名 =====

export function isGenericTitle(title: string): boolean {
  const clean = title.replace(/^\d+[-.\s]*/, '').trim();
  return GENERIC_TITLES.has(clean);
}

/** 从路径提取项目文件夹名（去数字前缀），无项目上下文返回 null */
export function extractProjectFolder(path: string): string | null {
  const parts = path.split('/');
  if (parts.length < 2) return null;
  const topDir = parts[0];
  if (topDir === '项目管理-系统' || topDir === '项目管理-车型' || topDir === '日常工作-通用') {
    if (parts.length >= 2) {
      return parts[1].replace(/^\d+\.\s*/, '');
    }
  }
  return null;
}

/** 从路径提取项目文件夹原始名（不去数字前缀），用于精确比较 */
export function extractProjectFolderRaw(path: string): string | null {
  const parts = path.split('/');
  if (parts.length < 2) return null;
  const topDir = parts[0];
  if (topDir === '项目管理-系统' || topDir === '项目管理-车型' || topDir === '日常工作-通用') {
    return parts[1] ?? null;
  }
  return null;
}

/** 构建显示标题：通用标题拼接项目名，独特标题直接使用 */
export function buildDisplayTitle(title: string, path: string, domain: string): string {
  const project = extractProjectFolder(path);
  if (domain === '原子笔记' || domain === '奇思妙想') return title;
  if (!project) return title;
  if (title.length > 6 && !isGenericTitle(title)) return title;
  const cleanTitle = title.replace(/^\d+[-.\s]*/, '');
  return `${project} › ${cleanTitle}`;
}

// ===== 工具函数 =====

/** 标准化链接路径（去掉 .md 后缀） */
export function normalizeLink(link: string): string {
  let result = link.trim();
  if (result.endsWith('.md')) result = result.slice(0, -3);
  return result;
}

/** 获取今日日期字符串 YYYY-MM-DD */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 格式化时间距离 */
export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
