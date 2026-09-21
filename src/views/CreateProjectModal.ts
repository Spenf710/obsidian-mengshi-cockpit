import { App, Modal, Setting, Notice, TextComponent } from 'obsidian';
import { saveGanttOverride, getAllCategories, getAllTags, getConfig, setConfig, addCustomCategory, addCustomTag } from '../data/settings';
import { addWorkingDays } from '../data/dateUtils';
import { centerModalInWorkbench } from './modalHelpers';

export class CreateProjectModal extends Modal {
  private name = '';
  private tag = '通用';
  private category = '其他';
  private root = '';
  private purpose = '';
  private startDate = '';
  private workDays = 30;
  private endDate = '';

  constructor(app: App) {
    super(app);
    const now = new Date();
    const roots = getConfig().projectRoots;
    this.root = roots[0] ?? '';   // 默认取第一个已配置根目录；空则强制用户新建（含自动注册）
    this.startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.endDate = addWorkingDays(this.startDate, this.workDays);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mswb-modal');

    const titleEl = contentEl.createEl('h3');
    const refreshTitle = () => { titleEl.textContent = `🆕 新建项目（#${this.getNextNumber()}）`; };
    refreshTitle();

    // 存放目录（未配置或空白时强制用户输入新目录名）
    const rootSetting = new Setting(contentEl).setName('存放目录');
    this.makeInlineDropdown(rootSetting.controlEl,
      getConfig().projectRoots, () => this.root,
      v => { this.root = v; refreshTitle(); },
      async v => {
        const cfg = getConfig();
        // 新输入的非空目录：创建文件夹 + 自动注册进 projectRoots（无需手动进设置）
        if (v && !cfg.projectRoots.includes(v)) {
          cfg.projectRoots.push(v); await setConfig(cfg);
          if (v.trim() && !this.app.vault.getAbstractFileByPath(v)) {
            await this.app.vault.createFolder(v.trim());
          }
        }
      });

    // 项目名称 + 项目目的（并排）
    const r1 = contentEl.createDiv({ cls: 'mswb-modal-inlinerow' });
    this.makeField(r1, '项目名称', t => { t.setPlaceholder('例：XX管理系统'); t.onChange(v => this.name = v); });
    this.makeField(r1, '项目目的', t => { t.setPlaceholder('解决什么问题...'); t.onChange(v => this.purpose = v); });

    // 所属标签 + 项目类别（并排）
    const r2 = contentEl.createDiv({ cls: 'mswb-modal-inlinerow' });
    this.makeField(r2, '所属标签', null, ctl => {
      this.makeInlineDropdown(ctl, getAllTags(), () => this.tag, v => this.tag = v, addCustomTag);
    });
    this.makeField(r2, '项目类别', null, ctl => {
      this.makeInlineDropdown(ctl, getAllCategories(), () => this.category, v => this.category = v, addCustomCategory);
    });

    // 开始日期 + 开发周期
    const r3 = contentEl.createDiv({ cls: 'mswb-modal-inlinerow' });
    this.makeField(r3, '开始日期', t => { t.setValue(this.startDate).onChange(v => { this.startDate = v; updateEnd(); }); t.inputEl.type = 'date'; });
    this.makeField(r3, '开发周期', t => {
      t.setValue(String(this.workDays)).onChange(v => {
        const n = parseInt(v, 10); if (!isNaN(n) && n > 0) { this.workDays = n; updateEnd(); }
      });
      t.inputEl.type = 'number';
    });

    // 预计结束
    const endSetting = new Setting(contentEl).setName('预计结束');
    endSetting.addText(t => { t.setValue(this.endDate); t.inputEl.disabled = true; t.inputEl.setCssProps({ opacity: '0.6' }); });
    const refreshEnd = () => { endSetting.controlEl.querySelector('input')!.value = this.endDate; };
    const updateEnd = () => { this.endDate = addWorkingDays(this.startDate, this.workDays); refreshEnd(); };

    // 按钮
    const btnRow = contentEl.createDiv({ cls: 'mswb-modal-actions' });
    btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    btnRow.createEl('button', { text: '创建项目', cls: 'mswb-modal-submit' })
      .addEventListener('click', () => this.submit());
    centerModalInWorkbench(this);
  }

  /** 创建并排字段（textCb 接收官方 TextComponent，替换自造 mock，消掉 no-unsafe 噪音） */
  private makeField(
    row: HTMLElement, label: string,
    textCb?: ((t: TextComponent) => void) | null,
    customCb?: (ctl: HTMLElement) => void,
  ): void {
    const wrap = row.createDiv({ cls: 'mswb-modal-field' });
    wrap.createEl('label', { text: label, cls: 'mswb-modal-label' });
    const ctl = wrap.createDiv();
    if (customCb) {
      customCb(ctl);
    } else if (textCb) {
      // 官方 TextComponent：addText 会正确渲染到 contentEl 并挂 inputEl
      const comp = new TextComponent(ctl);
      comp.inputEl.addClass('mswb-modal-input');
      textCb(comp);
    }
  }

  /** 内联下拉 + 新增 */
  private makeInlineDropdown(
    container: HTMLElement,
    options: string[],
    getCurrent: () => string,
    onSelect: (v: string) => void,
    onAdd?: (v: string) => Promise<void>,
  ): void {
    const showDropdown = () => {
      const cur = getCurrent();
      // 当前值不在选项中 → 直接进入「新增」输入态（未配置根目录时 root=''，select 只会选中
      // 「+ 新增…」且 change 永不触发 = 用户无法输入。修复：无匹配选项直接给输入框）
      if (!options.includes(cur)) {
        showInput();
        return;
      }
      container.empty();
      const sel = container.createEl('select', { cls: 'mswb-modal-input' });
      for (const o of options) sel.createEl('option', { value: o, text: o });
      sel.createEl('option', { value: '__new__', text: '+ 新增…' });
      sel.value = cur;
      sel.addEventListener('change', () => {
        if (sel.value === '__new__') showInput();
        else onSelect(sel.value);
      });
    };

    const saveAndClose = async (val: string) => {
      if (val === '__new__' || !val.trim()) { showInput(); return; }
      onSelect(val);
      if (onAdd) { await onAdd(val.trim()); }
      else if (!options.includes(val)) options.push(val);
      // 有 onAdd 时目录值已由回调注册进 real config，this.root 由 onSelect 更新，
      // 无需重建下拉；直接保持聚焦在当前输入框（已保存完成）
      if (!onAdd) showDropdown();
    };

    const showInput = () => {
      container.empty();
      const input = container.createEl('input', { cls: 'mswb-modal-input' });
      input.type = 'text';
      input.placeholder = '输入新值，回车确认';
      let saving = false;
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          saving = true;
          await saveAndClose(input.value.trim());
        }
        // Esc：无选项场景下重建下拉会再次弹回输入态（死循环观感），故仅保持输入框不动
      });
      input.addEventListener('blur', async () => {
        if (saving) return;
        if (input.value.trim()) await saveAndClose(input.value.trim());
        // 空输入不重建下拉（避免重新触发 showInput 造成焦点死循环）
      });
      input.focus();
    };

    showDropdown();
  }

  private getNextNumber(): number {
    const files = this.app.vault.getFiles();
    let max = 0;
    const pattern = new RegExp(`^${this.root}/(\\d+)\\.`);
    for (const f of files) {
      const match = f.path.match(pattern);
      if (match) { const n = parseInt(match[1], 10); if (n > max) max = n; }
    }
    return max + 1;
  }

  private async submit(): Promise<void> {
    if (!this.name.trim()) { new Notice('请输入项目名称'); return; }
    // ⚠️ 未配置任何根目录时：必须先在「存放目录」输入一个新的目录名（会联动创建+注册）
    if (!this.root || !this.root.trim()) { new Notice('请先在「存放目录」选择或输入一个目录'); return; }
    const num = this.getNextNumber();
    const folderName = `${num}.${this.name.trim()}`;
    const folderPath = `${this.root.trim()}/${folderName}`;
    const readmeName = `${this.name.trim()}.README.md`;

    if (this.app.vault.getAbstractFileByPath(folderPath)) { new Notice(`⚠️ 目录 ${folderPath} 已存在`); return; }
    const rootName = this.root.trim();
    if (!this.app.vault.getAbstractFileByPath(rootName)) await this.app.vault.createFolder(rootName);
    if (!getConfig().projectRoots.includes(rootName)) {
      const cfg = getConfig(); cfg.projectRoots = [...cfg.projectRoots, rootName]; await setConfig(cfg);
    }
    this.root = rootName;
    this.endDate = addWorkingDays(this.startDate, this.workDays);

    const content = [
      '---', 'tags:', '  - 项目索引',
      this.tag !== '通用' ? `  - ${this.tag}` : '', `  - ${this.category}`, '---',
      '', `# ${this.name.trim()}`, '', `> ${this.purpose || '项目描述待补充'}`,
      '', '## 核心信息', '', '| 项目 | 内容 |', '|------|------|',
      `| **项目类型** | ${this.category} |`, `| **所属标签** | ${this.tag} |`,
      `| **开发周期** | ${this.workDays} 工作日 |`, `| **预计周期** | ${this.startDate} ~ ${this.endDate} |`,
      '| **当前状态** | 规划中 |',
      '', '## 排期里程碑', '', '| 节点 | 日期 | 状态 |', '|------|------|------|',
      `| 项目启动 | ${this.startDate} | ⏳ |`, `| 计划完成 | ${this.endDate} | ⏳ |`,
      '', '## 文档索引', '',
      '- [[00-背景与需求|00-背景与需求]]', '- [[01-方案设计|01-方案设计]]',
      '', '---', '', '**相关笔记：**',
    ].filter(l => l !== '').join('\n');

    try {
      await this.app.vault.createFolder(folderPath);
      await this.app.vault.create(`${folderPath}/${readmeName}`, content);
      await this.app.vault.create(`${folderPath}/00-背景与需求.md`, '# 00 — 背景与需求\n\n## 任务来源\n\n\n## 需求描述\n\n');
      await this.app.vault.create(`${folderPath}/01-方案设计.md`, '# 01 — 方案设计\n\n## 技术选型\n\n\n## 架构概要\n\n');
      await saveGanttOverride(folderName, { start: this.startDate, end: this.endDate, progress: 0 });
      new Notice(`✅ 项目「${this.name}」创建成功`);
      this.close();
    } catch (e) { new Notice(`❌ 创建失败：${e}`); }
  }

  onClose(): void { this.contentEl.empty(); }
}
