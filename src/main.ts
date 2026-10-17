import { App, Modal, Plugin, TFile, TFolder, TAbstractFile, Notice, WorkspaceLeaf } from 'obsidian';
import { TeamPluginSettings, DEFAULT_SETTINGS } from './types';
import { JwtPayload } from './utils/api';
import { TeamPluginSettingTab } from './settings';
import { TeamManager, PluginSync, Collaboration, CollabEditor } from './core';
import { Summarizer } from './ai';
import { DailyReport, MonthlyReport } from './reports';
import { ReportModal, TeamView, TEAM_VIEW_TYPE, LoginModal, CreateTeamModal } from './ui';
import { CommentModal } from './ui/CommentModal';

export default class TeamPlugin extends Plugin {
    settings: TeamPluginSettings;

    // Core modules
    teamManager: TeamManager;
    pluginSync: PluginSync;
    summarizer: Summarizer;
    collaboration: Collaboration;
    collabEditor: CollabEditor;

    // Report generators
    dailyReport: DailyReport;
    monthlyReport: MonthlyReport;

    /** 由 WebSocket 触发的重命名，避免再次同步到云端造成循环 */
    pendingRemoteRenames = new Set<string>();
    /** 恢复团队文件夹时，忽略这一轮连带触发的子路径重命名 */
    private suppressRenamePrefixes = new Set<string>();
    private renameBatch: Array<{ file: TAbstractFile; oldPath: string }> = [];
    private renameBatchTimer: number | null = null;

    private collabStatusEl: HTMLElement | null = null;

    async onload() {
        // Load settings
        await this.loadSettings();

        // Initialize modules
        this.initializeModules();

        // Register team drive auto mount
        this.setupTeamDriveAutoMount();

        // 监听团队云盘文件重命名，同步到云端
        this.setupTeamDriveRenameSync();

        // Register view
        this.registerView(
            TEAM_VIEW_TYPE,
            (leaf) => new TeamView(leaf, this)
        );

        // Add ribbon icon
        this.addRibbonIcon('users', '团队协作', () => {
            void this.activateTeamView();
        });

        // Register commands
        this.registerCommands();

        // Add settings tab
        this.addSettingTab(new TeamPluginSettingTab(this.app, this));

        // Setup auto daily report
        this.setupAutoDailyReport();

        // Token 过期自动登出
        this.checkTokenExpiry();

        // 当 Yjs WebSocket 收到 4001 时自动登出
        this.collabEditor.onAuthFailed = () => {
            void this.handleAuthExpired();
        };

        this.collabStatusEl = this.addStatusBarItem();
        this.collabStatusEl.addClass('team-collab-status');
        this.collabEditor.setStatusCallback((_status, info) => {
            if (!this.collabStatusEl) return;
            this.collabStatusEl.setText(info || '');
        });
    }

    async loadSettings() {
        const saved = await this.loadData() as Partial<TeamPluginSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    }

    /**
     * 解码 JWT payload（不验证签名），检查 exp 是否已过期
     */
    private checkTokenExpiry(): void {
        const token = this.settings.apiKey;
        if (!token) return;
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return;
            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload;
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                console.warn('[Auth] JWT 已过期，自动登出');
                void this.handleAuthExpired();
            }
        } catch {
            // token 格式异常，忽略
        }
    }

    /**
     * 登录态失效时统一处理：清空凭证、停止协同、提醒用户
     */
    async handleAuthExpired(): Promise<void> {
        // 避免重复触发
        if (!this.settings.apiKey) return;
        this.settings.apiKey = '';
        this.settings.userId = '';
        this.settings.username = '';
        await this.saveSettings();
        if (this.collabEditor.isActive) {
            this.collabEditor.stopCollab();
        }
        new Notice('登录已过期，请重新登录');
        // 刷新团队面板
        for (const leaf of this.app.workspace.getLeavesOfType(TEAM_VIEW_TYPE)) {
            if (leaf.view instanceof TeamView) {
                void leaf.view.render();
            }
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateModules();
    }

    private initializeModules() {
        // Core
        this.teamManager = new TeamManager(this.app, this.settings);
        this.pluginSync = new PluginSync(this.app, this.settings);
        this.collaboration = new Collaboration(this.app, this.settings);
        this.collabEditor = new CollabEditor(this.app, this, this.settings);

        // AI
        this.summarizer = new Summarizer(this.app);
        this.summarizer.initProvider(this.settings);

        // Reports
        this.dailyReport = new DailyReport(this.app, this.settings, this.summarizer);
        this.monthlyReport = new MonthlyReport(this.app, this.settings, this.summarizer);
    }

    private updateModules() {
        this.teamManager.updateSettings(this.settings);
        this.pluginSync.updateSettings(this.settings);
        this.collaboration.updateSettings(this.settings);
        this.collabEditor.updateSettings(this.settings);
        this.summarizer.initProvider(this.settings);
        this.dailyReport.updateSettings(this.settings);
        this.monthlyReport.updateSettings(this.settings);
    }

    private setupTeamDriveRenameSync() {
        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                if (!this.settings.apiKey || !oldPath.startsWith('团队云盘/')) return;
                if (this.pendingRemoteRenames.has(oldPath)) {
                    this.pendingRemoteRenames.delete(oldPath);
                    return;
                }
                for (const prefix of this.suppressRenamePrefixes) {
                    if (oldPath === prefix || oldPath.startsWith(`${prefix}/`)) return;
                }

                this.renameBatch.push({ file, oldPath });
                if (this.renameBatchTimer !== null) window.clearTimeout(this.renameBatchTimer);
                this.renameBatchTimer = window.setTimeout(() => {
                    this.renameBatchTimer = null;
                    const batch = this.renameBatch.splice(0);
                    void this.flushTeamDriveRenames(batch);
                }, 60);
            })
        );
    }

    /**
     * 团队云盘的直接子文件夹就是团队名。改它等于改团队名，必须确认后走服务端改名，
     * 否则下次同步会按旧团队名再下一份，其他成员也拿不到新路径。
     * 团队文件夹里面的子文件夹和文档仍按普通重命名同步。
     */
    private async flushTeamDriveRenames(batch: Array<{ file: TAbstractFile; oldPath: string }>): Promise<void> {
        const consumed = new Set<TAbstractFile>();
        for (const item of batch) {
            if (!(item.file instanceof TFolder)) continue;
            const oldParts = item.oldPath.split('/');
            if (oldParts.length !== 2 || oldParts[0] !== '团队云盘') continue;
            for (const other of batch) {
                if (other.oldPath === item.oldPath || other.oldPath.startsWith(`${item.oldPath}/`)) {
                    consumed.add(other.file);
                }
            }
            await this.handleTeamFolderRename(item.file, item.oldPath);
        }

        for (const item of batch) {
            if (consumed.has(item.file) || !(item.file instanceof TFile)) continue;
            if (!item.file.path.startsWith('团队云盘/')) continue;
            const parts = item.file.path.split('/');
            if (parts.length < 3) continue;
            const oldTeam = item.oldPath.split('/')[1];
            const newTeam = parts[1];
            if (oldTeam !== newTeam) continue;
            try {
                const teams = await this.teamManager.getMyTeams();
                const team = teams.find(t => t.name === newTeam);
                if (!team) continue;
                const docs = await this.teamManager.getTeamDocuments(team.id);
                const doc = docs.find(d => d.path === item.oldPath);
                if (!doc) continue;
                await this.teamManager.renameTeamDocument(team.id, doc.id, item.file.path);
                new Notice('已同步重命名到云端');
            } catch (e) {
                new Notice(e instanceof Error ? e.message : String(e));
            }
        }
    }

    private async handleTeamFolderRename(folder: TFolder, oldPath: string): Promise<void> {
        const oldName = oldPath.split('/')[1];
        const newParts = folder.path.split('/');
        const inPlace = newParts.length === 2 && newParts[0] === '团队云盘';
        const newName = inPlace ? newParts[1] : '';

        const restore = async (message?: string) => {
            if (message) new Notice(message);
            await this.restoreVaultPath(folder, oldPath);
        };

        if (!inPlace || !newName.trim() || newName !== newName.trim() || newName === oldName || /[\\/]/.test(newName) || newName.length > 40) {
            await restore('团队文件夹必须留在团队云盘下，并且和团队名一致，已恢复原名');
            return;
        }

        let teams;
        try {
            teams = await this.teamManager.getMyTeams();
        } catch (e) {
            await restore(e instanceof Error ? e.message : '读取团队失败，已恢复文件夹名');
            return;
        }

        const team = teams.find(t => t.name === oldName);
        if (!team) {
            await restore('团队云盘下这一层是团队名，不能单独改。请在团队文件夹里面新建子文件夹');
            return;
        }
        if (teams.some(t => t.id !== team.id && t.name === newName)) {
            await restore(`已有团队叫「${newName}」，已恢复原名`);
            return;
        }

        const member = team.members.find(m => m.userId === this.settings.userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
            await restore('只有所有者或管理员可以修改团队名称，已恢复文件夹名');
            return;
        }

        const confirmed = await this.confirmTeamRename(oldName, newName);
        if (!confirmed) {
            await restore();
            return;
        }

        try {
            await this.teamManager.updateTeamProfile(team.id, {
                name: newName,
                description: team.description || '',
            });
            new Notice('团队名称已更新，其他成员的目录会一起改');
            this.refreshTeamPanels();
            const active = this.app.workspace.getActiveFile();
            if (active instanceof TFile && active.path.startsWith(`团队云盘/${newName}/`)) {
                if (this.collabEditor.isActive) this.collabEditor.stopCollab();
                await this.mountTeamFile(active);
            }
        } catch (e) {
            await restore(e instanceof Error ? e.message : '修改团队名称失败，已恢复文件夹名');
        }
    }

    private confirmTeamRename(oldName: string, newName: string): Promise<boolean> {
        return new Promise(resolve => {
            new TeamRenameConfirmModal(this.app, oldName, newName, resolve).open();
        });
    }

    private async restoreVaultPath(file: TAbstractFile, oldPath: string): Promise<void> {
        if (file.path === oldPath) return;
        const current = file.path;
        this.pendingRemoteRenames.add(current);
        this.suppressRenamePrefixes.add(current);
        try {
            await this.app.vault.rename(file, oldPath);
        } catch (e) {
            this.pendingRemoteRenames.delete(current);
            new Notice(e instanceof Error ? e.message : '无法恢复原路径');
        } finally {
            window.setTimeout(() => this.suppressRenamePrefixes.delete(current), 300);
        }
    }

    private refreshTeamPanels(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(TEAM_VIEW_TYPE)) {
            if (leaf.view instanceof TeamView) {
                void leaf.view.render();
            }
        }
    }

    private setupTeamDriveAutoMount() {
        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                void this.mountTeamFile(file);
            })
        );
    }

    private async mountTeamFile(file: TFile | null): Promise<void> {
        if (!file) {
            if (this.collabEditor.isActive) {
                this.collabEditor.stopCollab();
            }
            return;
        }

        if (file.path.startsWith('团队云盘/')) {
            const parts = file.path.split('/');
            if (parts.length >= 3) {
                const teamName = parts[1];
                try {
                    const teams = await this.teamManager.getMyTeams();
                    const team = teams.find(t => t.name === teamName);
                    if (team) {
                        // 只有通过插件分享过的文档才进入协同；手动创建的文件不在云端，不启动协同
                        const docs = await this.teamManager.getTeamDocuments(team.id);
                        const doc = docs.find(d => d.path === file.path);
                        if (!doc) return;

                        if (!this.collabEditor.isActive || this.collabEditor.activeFilePath !== file.path) {
                            if (this.collabEditor.isActive) {
                                this.collabEditor.stopCollab();
                            }
                            const member = team.members.find(m => m.userId === this.settings.userId);
                            const canEdit = !!member
                                && member.role !== 'viewer'
                                && (doc.permission !== 'read' || member.role === 'owner' || member.role === 'admin');
                            await this.collabEditor.startCollab(team.id, file, { readOnly: !canEdit, documentId: doc.id });
                        }
                    }
                } catch (e) {
                    console.error('Auto-mount failed:', e);
                }
            }
        } else if (this.collabEditor.isActive) {
            this.collabEditor.stopCollab();
        }
    }

    private registerCommands() {
        // Open team view
        this.addCommand({
            id: 'open-team-view',
            name: '打开团队视图',
            callback: () => {
                void this.activateTeamView();
            }
        });

        // Generate daily report
        this.addCommand({
            id: 'generate-daily-report',
            name: '生成日报',
            callback: () => {
                void (async () => {
                    try {
                        const report = await this.dailyReport.generateTodayReport();
                        const file = await this.dailyReport.saveReport(report);
                        new Notice(`日报已生成: ${file.path}`);
                        await this.app.workspace.openLinkText(file.path, '', true);
                    } catch (e) {
                        new Notice(`生成日报失败: ${e}`);
                    }
                })();
            }
        });

        // Generate monthly report
        this.addCommand({
            id: 'generate-monthly-report',
            name: '生成月报',
            callback: () => {
                void (async () => {
                    try {
                        const report = await this.monthlyReport.generateCurrentMonthReport();
                        const file = await this.monthlyReport.saveReport(report);
                        new Notice(`月报已生成: ${file.path}`);
                        await this.app.workspace.openLinkText(file.path, '', true);
                    } catch (e) {
                        new Notice(`生成月报失败: ${e}`);
                    }
                })();
            }
        });

        // Summarize current file
        this.addCommand({
            id: 'summarize-current-file',
            name: 'AI 总结当前文档',
            editorCallback: async (editor, view) => {
                if (!view.file) return;

                if (!this.summarizer.isConfigured()) {
                    new Notice('请先配置 AI API');
                    return;
                }

                try {
                    new Notice('正在生成总结...');
                    const summary = await this.summarizer.summarizeFile(view.file, {
                        language: this.settings.language,
                    });

                    // Insert summary at cursor
                    editor.replaceSelection(`\n\n## AI 总结\n\n${summary}\n`);
                    new Notice('总结已插入');
                } catch (e) {
                    new Notice(`总结失败: ${e}`);
                }
            }
        });

        // Sync plugins from team
        this.addCommand({
            id: 'sync-team-plugins',
            name: '同步团队插件',
            callback: () => {
                void this.syncTeamPlugins();
            }
        });

        // Show installed plugins
        this.addCommand({
            id: 'show-installed-plugins',
            name: '查看已安装插件列表',
            callback: () => {
                void (async () => {
                    const plugins = await this.pluginSync.getInstalledPlugins();
                    const md = this.pluginSync.generatePluginListMarkdown(plugins);

                    const filePath = 'plugins-list.md';
                    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                    if (existingFile instanceof TFile) {
                        await this.app.vault.modify(existingFile, md);
                    } else {
                        await this.app.vault.create(filePath, md);
                    }

                    await this.app.workspace.openLinkText(filePath, '', true);
                })();
            }
        });

        // Open report modal
        this.addCommand({
            id: 'open-report-modal',
            name: '打开报告生成器',
            callback: () => {
                this.openReportModal();
            }
        });

        this.addCommand({
            id: 'comment-selection',
            name: '评论当前选区',
            editorCallback: (editor) => {
                const file = this.app.workspace.getActiveFile();
                const team = this.teamManager.getCurrentTeam();
                if (!file || !team) {
                    new Notice('请先打开团队文档并选中团队');
                    return;
                }
                const quote = editor.getSelection();
                void this.teamManager.getTeamDocuments(team.id).then(docs => {
                    const doc = docs.find(item => item.path === file.path);
                    if (!doc) {
                        new Notice('当前文件不是团队文档');
                        return;
                    }
                    new CommentModal(this.app, this, team.id, doc, quote).open();
                }).catch((error: unknown) => {
                    new Notice(error instanceof Error ? error.message : '无法打开评论');
                });
            }
        });

        // Login / Register
        this.addCommand({
            id: 'login',
            name: '登录 / 注册',
            callback: () => {
                new LoginModal(this.app, this, () => {
                    void this.activateTeamView();
                }).open();
            }
        });

        // Create team
        this.addCommand({
            id: 'create-team',
            name: '创建团队',
            callback: () => {
                if (!this.settings.apiKey) {
                    new Notice('请先登录');
                    new LoginModal(this.app, this, () => {
                        void this.activateTeamView();
                    }).open();
                    return;
                }
                new CreateTeamModal(this.app, this).open();
            }
        });
    }

    private setupAutoDailyReport() {
        if (!this.settings.autoGenerateDailyReport) return;

        // Check every minute
        this.registerInterval(
            window.setInterval(() => {
                const now = new Date();
                const [targetHour, targetMinute] = this.settings.dailyReportTime.split(':').map(Number);

                if (now.getHours() === targetHour && now.getMinutes() === targetMinute) {
                    this.dailyReport.generateTodayReport().then(async (report) => {
                        await this.dailyReport.saveReport(report);
                        new Notice('日报已自动生成');
                    }).catch(e => {
                        console.error('Auto daily report failed:', e);
                    });
                }
            }, 60000)
        );
    }

    async activateTeamView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(TEAM_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
            // Force re-render existing TeamView (e.g. after login)
            const view = leaf.view;
            if (view instanceof TeamView) {
                await view.render();
            }
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: TEAM_VIEW_TYPE, active: true });
        }

        if (leaf) {
            void workspace.revealLeaf(leaf);
        }
    }

    openReportModal() {
        new ReportModal(
            this.app,
            this.settings,
            this.dailyReport,
            this.monthlyReport
        ).open();
    }

    async syncTeamPlugins() {
        if (!this.settings.currentTeamId) {
            new Notice('请先选择一个团队');
            return;
        }

        try {
            new Notice('正在获取团队插件配置...');

            const syncPackage = await this.pluginSync.getTeamPluginConfig(this.settings.currentTeamId);
            const result = await this.pluginSync.installPluginsFromPackage(syncPackage);

            const message = [
                `同步完成:`,
                `已安装: ${result.installed.length}`,
                `已跳过: ${result.skipped.length}`,
                `失败: ${result.failed.length}`,
            ].join('\n');

            new Notice(message);
        } catch (e) {
            new Notice(`同步失败: ${e}`);
        }
    }
}

class TeamRenameConfirmModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        private readonly oldName: string,
        private readonly newName: string,
        private readonly resolveChoice: (ok: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '修改团队名称' });
        contentEl.createEl('p', {
            text: `「${this.oldName}」是团队文件夹，必须和团队名保持一致。子文件夹可以随意新建和改名，这一层不行。`,
        });
        contentEl.createEl('p', {
            text: `是否把团队名称改为「${this.newName}」？确认后云端路径会一起更新，其他成员才能拿到改名后的文档。`,
        });
        const row = contentEl.createDiv('team-confirm-actions');
        const confirm = row.createEl('button', { text: '修改团队名', cls: 'mod-cta' });
        confirm.addEventListener('click', () => this.finish(true));
        const cancel = row.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.finish(false));
    }

    onClose(): void {
        this.contentEl.empty();
        if (this.settled) return;
        this.settled = true;
        this.resolveChoice(false);
    }

    private finish(ok: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveChoice(ok);
        this.close();
    }
}
