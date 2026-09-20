import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { Plugin } from 'obsidian';
import {
  getConfig,
  setConfig,
  resetConfig,
  type PluginConfig,
  getSessionConfig,
  setSessionConfig,
  getFeishuConfig,
  setFeishuConfig,
} from '../data/settings';
import { installHarvestSkill } from '../data/harvestSkill';

export class WorkbenchSettingsTab extends PluginSettingTab {
  private config: PluginConfig;

  constructor(app: App, private plugin: Plugin) {
    super(app, plugin);
    this.config = { ...getConfig() };
  }

  display(): void {
    this.config = { ...getConfig() };
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setHeading().setName('猛士驾驶舱 设置');

    // ===== 基础路径 =====
    new Setting(containerEl).setHeading().setName('📁 基础路径');

    new Setting(containerEl)
      .setName('工作日志目录')
      .setDesc('存放每日日志的文件夹路径')
      .addText((t) =>
        t.setValue(this.config.workLogPath)
          .setPlaceholder('工作日志')
          .onChange((v) => this.config.workLogPath = v));

    new Setting(containerEl)
      .setName('日记模板')
      .setDesc('创建新日记时使用的模板文件路径')
      .addText((t) =>
        t.setValue(this.config.diaryTemplate)
          .setPlaceholder('templates/工作日志.md')
          .onChange((v) => this.config.diaryTemplate = v));

    new Setting(containerEl)
      .setName('项目根目录')
      .addText((t) => {
        t.setPlaceholder('例: 项目管理-客户');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            this.config.projectRoots.push(t.getValue().trim());
            t.setValue('');
            this.renderRoots(rootsContainer);
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = containerEl.querySelector('input[placeholder="例: 项目管理-客户"]') as HTMLInputElement;
        if (input && input.value.trim()) {
          this.config.projectRoots.push(input.value.trim());
          input.value = '';
          this.renderRoots(rootsContainer);
        }
      }));

    const rootsContainer = containerEl.createDiv();
    this.renderRoots(rootsContainer);

    // ===== 类别与车型 =====
    new Setting(containerEl).setHeading().setName('🏷️ 类别与标签');

    new Setting(containerEl)
      .setName('默认类别')
      .addText((t) => {
        t.setPlaceholder('新类别名');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            if (!this.config.baseCategories.includes(t.getValue().trim())) {
              this.config.baseCategories.push(t.getValue().trim());
              t.setValue('');
              this.renderList(catContainer, this.config.baseCategories, (v) => { this.config.baseCategories = v; });
            }
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = containerEl.querySelector('input[placeholder="新类别名"]') as HTMLInputElement;
        if (input && input.value.trim() && !this.config.baseCategories.includes(input.value.trim())) {
          this.config.baseCategories.push(input.value.trim());
          input.value = '';
          this.renderList(catContainer, this.config.baseCategories, (v) => { this.config.baseCategories = v; });
        }
      }));

    const catContainer = containerEl.createDiv();
    this.renderList(catContainer, this.config.baseCategories, (v) => { this.config.baseCategories = v; });

    new Setting(containerEl)
      .setName('默认标签')
      .addText((t) => {
        t.setPlaceholder('新标签名');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            if (!this.config.baseTags.includes(t.getValue().trim())) {
              this.config.baseTags.push(t.getValue().trim());
              t.setValue('');
              this.renderList(tagContainer, this.config.baseTags, (v) => { this.config.baseTags = v; });
            }
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = containerEl.querySelector('input[placeholder="新标签名"]') as HTMLInputElement;
        if (input && input.value.trim() && !this.config.baseTags.includes(input.value.trim())) {
          this.config.baseTags.push(input.value.trim());
          input.value = '';
          this.renderList(tagContainer, this.config.baseTags, (v) => { this.config.baseTags = v; });
        }
      }));

    const tagContainer = containerEl.createDiv();
    this.renderList(tagContainer, this.config.baseTags, (v) => { this.config.baseTags = v; });

    // ===== Tab 页配置 =====
    new Setting(containerEl).setHeading().setName('📑 Tab 页');

    const TAB_LABELS: Record<string, string> = {
      calendar: '📅 日历',
      projects: '📂 项目',
      todos: '✅ 待办',
      gantt: '📊 排期',
      feishu: '📡 飞书',
      sessions: '💬 会话',
    };

    for (const [key, label] of Object.entries(TAB_LABELS)) {
      const isVisible = this.config.visibleTabs?.[key] !== false;
      new Setting(containerEl)
        .setName(label)
        .addToggle((t) => t.setValue(isVisible).onChange((v) => {
          if (!this.config.visibleTabs) this.config.visibleTabs = {};
          this.config.visibleTabs[key] = v;
        }));
    }

    // ===== 日历显示 =====
    new Setting(containerEl).setHeading().setName('📅 日历显示');

    new Setting(containerEl)
      .setName('显示周六')
      .setDesc('日历是否显示周六列（默认显示；如排班不涉及周六可关闭）')
      .addToggle((t) => t.setValue(this.config.showSaturday !== false).onChange((v) => { this.config.showSaturday = v; }));

    new Setting(containerEl)
      .setName('显示周日')
      .setDesc('日历是否显示周日列（默认显示；周日也常需要安排工作/补班）')
      .addToggle((t) => t.setValue(this.config.showSunday !== false).onChange((v) => { this.config.showSunday = v; }));

    new Setting(containerEl)
      .setName('显示节假日 / 调休补班')
      .setDesc('按国务院放假安排标注休假日（红）与调休补班日（蓝），默认显示')
      .addToggle((t) => t.setValue(this.config.showHolidays !== false).onChange((v) => { this.config.showHolidays = v; }));

    // ===== Claude 会话 =====
    const sessionCfg = { ...getSessionConfig() };
    const sessionText: any = {};

    new Setting(containerEl).setHeading().setName('💬 Claude 会话');

    new Setting(containerEl)
      .setName('会话目录')
      .setDesc('会话 .jsonl 根目录，默认 ~/.claude/projects')
      .addText((t) => {
        t.setValue(sessionCfg.sessionRootDir)
          .setPlaceholder('C:\\Users\\xxx\\.claude\\projects')
          .onChange((v) => { sessionText.sessionRootDir = v; });
      });

    new Setting(containerEl)
      .setName('claude CLI 路径')
      .setDesc('loop 起新会话用，留空自动检测')
      .addText((t) => {
        t.setValue(sessionCfg.claudeCliPath)
          .setPlaceholder('claude')
          .onChange((v) => { sessionText.claudeCliPath = v; });
      });

    new Setting(containerEl)
      .setName('会话存档目录')
      .setDesc('存档会话的存放路径，留空时默认 ~/.claude/archives（在 Claude 30 天清理范围外）')
      .addText((t) => {
        t.setValue(sessionCfg.archiveDir)
          .setPlaceholder('留空使用默认路径')
          .onChange((v) => { sessionText.archiveDir = v; });
      });

    // ===== CodeM 会话 =====
    new Setting(containerEl).setHeading().setName('🏷 CodeM 会话');

    new Setting(containerEl)
      .setName('CodeM 会话目录')
      .setDesc('CodeM 会话 .jsonl 根目录，默认 ~/.codem/sessions')
      .addText((t) => {
        t.setValue(sessionCfg.codemRootDir)
          .setPlaceholder('C:\\Users\\xxx\\.codem\\sessions')
          .onChange((v) => { sessionText.codemRootDir = v; });
      });

    new Setting(containerEl)
      .setName('codem CLI 路径')
      .setDesc('「在 CodeM 中打开」续接会话用，留空自动检测（codem）')
      .addText((t) => {
        t.setValue(sessionCfg.codemCliPath)
          .setPlaceholder('codem')
          .onChange((v) => { sessionText.codemCliPath = v; });
      });

    // ===== 收割技能 =====
    new Setting(containerEl).setHeading().setName('🌾 收割技能');

    new Setting(containerEl)
      .setName('收割技能名')
      .setDesc('会话「已收割」按此名单匹配。默认 session-harvest；用自己的收割 SKILL 名替换，多个用逗号分隔。留空 = 默认')
      .addText((t) => {
        t.setValue((sessionCfg.harvestSkillNames || ['session-harvest']).join(','))
          .setPlaceholder('session-harvest')
          .onChange((v) => { sessionText.harvestSkillNames = v.split(',').map((s) => s.trim()).filter(Boolean); });
      });

    new Setting(containerEl)
      .setName('一键注册收割 SKILL')
      .setDesc('把内置的通用「会话知识收割」模板写入本机技能目录（Claude Code ~/.claude/skills、CodeM ~/.agents/skills），无需手动拷贝。已有文件会自动备份为 .bak。登录态不影响，仅写本地文件')
      .addButton((b) => b
        .setButtonText('🤖 Claude Code')
        .setCta()
        .onClick(async () => {
          const res = installHarvestSkill('claude');
          const r = res[0];
          new Notice(r.ok
            ? (r.existed ? `✅ 已注册（原文件已备份为 .bak）: ${r.path}` : `✅ 已注册: ${r.path}`)
            : `❌ 注册失败: ${r.error}`);
        }))
      .addButton((b) => b
        .setButtonText('🏷 CodeM')
        .setCta()
        .onClick(async () => {
          const res = installHarvestSkill('codem');
          const r = res[0];
          new Notice(r.ok
            ? (r.existed ? `✅ 已注册（原文件已备份为 .bak）: ${r.path}` : `✅ 已注册: ${r.path}`)
            : `❌ 注册失败: ${r.error}`);
        }))
      .addButton((b) => b
        .setButtonText('🌐 都装')
        .onClick(async () => {
          const res = installHarvestSkill('both');
          const okN = res.filter((r) => r.ok).length;
          const err = res.filter((r) => !r.ok);
          new Notice(err.length === 0
            ? `✅ 已注册 ${okN} 处（已存在则备份 .bak）`
            : `⚠️ 注册 ${okN} 处，失败 ${err.length} 处：${err[0].error}`);
        }));

    // ===== 飞书 =====
    const feishuCfg = { ...getFeishuConfig() };
    const feishuText: any = {};

    new Setting(containerEl).setHeading().setName('📡 飞书');

    new Setting(containerEl)
      .setName('lark-cli 路径')
      .setDesc('留空自动检测，失败时手动指定')
      .addText((t) => {
        t.setValue(feishuCfg.larkCliPath)
          .setPlaceholder('留空自动检测')
          .onChange((v) => { feishuText.larkCliPath = v; });
      });

    new Setting(containerEl)
      .setName('扫描文件夹上限')
      .setDesc('深度扫描最多遍历的文件夹数（默认 100；云盘嵌套很深可调大，超出部分标为已达上限）')
      .addText((t) => {
        t.setValue(String(feishuCfg.scanFolderLimit ?? 100))
          .setPlaceholder('100')
          .onChange((v) => { feishuText.scanFolderLimit = parseInt(v, 10) || 100; });
      });

    new Setting(containerEl)
      .setName('扫描并发数')
      .setDesc('同步文件夹时并发加载的批次大小（默认 5；文件夹多可调大到 8~10 提速，飞书接口限频时调小）')
      .addText((t) => {
        t.setValue(String(feishuCfg.scanConcurrency ?? 5))
          .setPlaceholder('5')
          .onChange((v) => { feishuText.scanConcurrency = parseInt(v, 10) || 5; });
      });

    // ===== 操作按钮 =====
    containerEl.createEl('hr');

    new Setting(containerEl)
      .setName('保存设置')
      .setDesc('所有改动一次性保存，需重载插件完全生效')
      .addButton((b) => b
        .setButtonText('💾 保存')
        .setCta()
        .onClick(async () => {
          await setConfig(this.config);
          await setSessionConfig({
            sessionRootDir: sessionText.sessionRootDir ?? '',
            claudeCliPath: sessionText.claudeCliPath ?? '',
            archiveDir: sessionText.archiveDir ?? '',
            codemRootDir: sessionText.codemRootDir ?? '',
            codemCliPath: sessionText.codemCliPath ?? '',
            harvestSkillNames: sessionText.harvestSkillNames || ['session-harvest'],
          });
          await setFeishuConfig({
            larkCliPath: feishuText.larkCliPath ?? '',
            scanFolderLimit: feishuText.scanFolderLimit ?? 100,
            scanConcurrency: feishuText.scanConcurrency ?? 5,
          });
          this.config = { ...getConfig() };
          this.display();
        }));

    new Setting(containerEl)
      .setName('恢复默认')
      .setDesc('将所有配置恢复为默认值')
      .addButton((b) => {
        b.setButtonText('🔄 恢复默认');
        // 1.7.2 无 setDestructive（1.13+ 才有）——用基础类模 red 表达危险操作，保持 minAppVersion 兼容
        if ('setClass' in b && typeof b.setClass === 'function') b.setClass('mod-warning');
        b.onClick(async () => {
          await resetConfig();
          await setSessionConfig({ sessionRootDir: '', claudeCliPath: '', archiveDir: '', codemRootDir: '', codemCliPath: '', harvestSkillNames: ['session-harvest'] });
          await setFeishuConfig({ larkCliPath: '', scanFolderLimit: 100, scanConcurrency: 5 });
          this.config = { ...getConfig() };
          this.display();
        });
      });
  }

  private renderRoots(container: HTMLElement): void {
    container.empty();
    if (this.config.projectRoots.length === 0) {
      container.createEl('p', { text: '（无）', cls: 'setting-item-description' });
      return;
    }
    for (let i = 0; i < this.config.projectRoots.length; i++) {
      const row = container.createDiv({ cls: 'setting-item' });
      row.createSpan({ text: this.config.projectRoots[i], cls: 'setting-item-name' });
      const btn = row.createEl('button', { text: '✕', cls: 'mswb-del-btn' });
      btn.addEventListener('click', () => {
        this.config.projectRoots.splice(i, 1);
        this.renderRoots(container);
      });
    }
  }

  private renderList(container: HTMLElement, items: string[], onChange: (v: string[]) => void): void {
    container.empty();
    for (let i = 0; i < items.length; i++) {
      const row = container.createDiv({ cls: 'setting-item' });
      row.createSpan({ text: items[i], cls: 'setting-item-name' });
      const btn = row.createEl('button', { text: '✕', cls: 'mswb-del-btn' });
      btn.addEventListener('click', () => {
        items.splice(i, 1);
        onChange([...items]);
        this.renderList(container, items, onChange);
      });
    }
  }
}