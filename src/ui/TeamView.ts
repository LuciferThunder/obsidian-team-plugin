import { App, ItemView, WorkspaceLeaf, Menu, Modal, Notice, requestUrl, setIcon, TFile, TFolder, FuzzySuggestModal } from 'obsidian';
import { formatHourMinute } from '../utils/dates';
import { devLog } from '../utils/devLog';
import type TeamPlugin from '../main';
import { Team, TeamMember, TeamRole } from '../types/team';
import type { TeamMention } from '../core/TeamManager';
import { TeamDocument } from '../types/document';
import { getErrorMessage, readResponseJson, TeamDriveChangedMessage } from '../utils/api';
import { CreateTeamModal } from './CreateTeamModal';
import { InviteMemberModal } from './InviteMemberModal';
import { LoginModal } from './LoginModal';
import { HistoryModal } from './HistoryModal';
import { CommentModal } from './CommentModal';
import { EditTeamModal } from './EditTeamModal';
export const TEAM_VIEW_TYPE = 'team-view';

export class TeamView extends ItemView {
    private plugin: TeamPlugin;
    private currentTeam: Team | null = null;
    private teamDocs: TeamDocument[] = [];
    private teamWs: WebSocket | null = null;
    private teamWsTeamId: string | null = null;
    private isDisconnectingWs = false;
    private renderInProgress = false;
    private onlineUserIds = new Set<string>();
    private searchQuery = '';
    private activity: Array<{ actorName: string; action: string; detail: string; createdAt: number }> = [];
    private mentions: TeamMention[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: TeamPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return TEAM_VIEW_TYPE;
    }

    getDisplayText(): string {
        return '团队协作';
    }

    getIcon(): string {
        return 'users';
    }

    async onOpen() {
        await this.render();
    }

    async onClose() {
        this.disconnectTeamWebSocket();
    }

    /** 获取团队事件 WebSocket 地址（从 wsUrl 或 serverUrl 推导） */
    private getTeamWebSocketUrl(): string {
        let base: string;
        if (this.plugin.settings.wsUrl?.trim()) {
            const ws = this.plugin.settings.wsUrl.trim();
            base = ws.includes('/ws/collab') ? ws.replace(/\/ws\/collab\/?$/, '/ws/collab/team') : ws.replace(/\/+$/, '') + '/ws/collab/team';
        } else {
            const httpUrl = this.plugin.settings.serverUrl.replace(/\/+$/, '');
            base = httpUrl.replace(/^http/, 'ws') + '/ws/collab/team';
        }
        return base;
    }

    private reconnectTimer: number | null = null;

    private logTeamWs(action: string, detail?: Record<string, unknown>): void {
        devLog(`[TeamCollab] ${action}`, detail);
    }

    /** 连接团队事件 WebSocket，收到 team_drive_changed 时自动刷新 */
    private connectTeamWebSocket(): void {
        if (!this.currentTeam || !this.plugin.settings.apiKey) return;
        // 已连接同一团队时不再重复连接，避免 render 导致反复断开重连
        if (this.teamWs?.readyState === WebSocket.OPEN && this.teamWsTeamId === this.currentTeam.id) return;
        this.disconnectTeamWebSocket();

        const baseUrl = this.getTeamWebSocketUrl();
        let wsUrl: string;
        try {
            const url = new URL(baseUrl);
            url.searchParams.set('token', this.plugin.settings.apiKey);
            url.searchParams.set('teamId', this.currentTeam.id);
            wsUrl = url.toString();
        } catch (e) {
            this.logTeamWs('connect_fail', { reason: 'URL 解析失败', error: String(e) });
            return;
        }

        const tryConnect = () => {
            if (!this.currentTeam || !this.plugin.settings.apiKey) return;
            this.logTeamWs('connect', { teamId: this.currentTeam.id, url: baseUrl });
            try {
                const ws = new WebSocket(wsUrl);
                ws.onopen = () => {
                    this.reconnectTimer = null;
                    this.teamWsTeamId = this.currentTeam?.id ?? null;
                    this.logTeamWs('connected', { teamId: this.currentTeam!.id });
                };
                ws.onmessage = async (ev) => {
                    try {
                        const data = JSON.parse(ev.data as string) as TeamDriveChangedMessage;
                        if (data.type === 'presence' && Array.isArray(data.users)) {
                            this.onlineUserIds = new Set(data.users.map(user => user.userId));
                            this.paintOnline();
                            return;
                        }
                        if (data.type === 'mention' && data.recipientId === this.plugin.settings.userId && data.filePath) {
                            this.rememberMention(data);
                            new Notice(this.mentionText(data));
                            window.setTimeout(() => {
                                void this.render();
                            }, this.renderInProgress ? 400 : 0);
                            return;
                        }
                        if (data.type === 'team_drive_changed') {
                            const deleted = data.deleted ?? [];
                            const renamed = data.renamed ?? [];
                            this.logTeamWs('message', { type: 'team_drive_changed', deleted, renamed });
                            for (const path of deleted) {
                                const file = this.app.vault.getAbstractFileByPath(path);
                                if (file && file instanceof TFile) {
                                    try {
                                        await this.app.fileManager.trashFile(file);
                                    } catch {
                                        // 文件可能已被删除或路径已变更，忽略 ENOENT
                                    }
                                }
                            }
                            for (const { from, to } of renamed) {
                                const file = this.app.vault.getAbstractFileByPath(from);
                                if (file && file instanceof TFile) {
                                    try {
                                        this.plugin.pendingRemoteRenames.add(from);
                                        await this.app.vault.rename(file, to);
                                    } catch {
                                        this.plugin.pendingRemoteRenames.delete(from);
                                        // 重命名失败时忽略
                                    }
                                }
                                const parentPath = from.split('/').slice(0, -1).join('/');
                                const parent = this.app.vault.getAbstractFileByPath(parentPath);
                                if (parent instanceof TFolder && parent.children.length === 0) {
                                    try {
                                        await this.app.fileManager.trashFile(parent);
                                    } catch {
                                        // 空目录删不掉时忽略
                                    }
                                }
                            }
                            void this.render();
                        }
                    } catch {
                        // ignore
                    }
                };
                ws.onclose = (ev) => {
                    this.teamWs = null;
                    const hint = ev.code === 1006 ? ' (可能原因: 代理/防火墙未转发 WebSocket、服务未启、SSL 证书问题)' : '';
                    this.logTeamWs('close', {
                        code: ev.code,
                        reason: (ev.reason || '') + hint,
                        clean: ev.wasClean,
                    });
                    // 4001 = 未授权（token 过期），触发自动登出
                    if (ev.code === 4001) {
                        void this.plugin.handleAuthExpired();
                        return;
                    }
                    if (!this.isDisconnectingWs) this.scheduleReconnect();
                };
                ws.onerror = () => {
                    this.teamWs = null;
                    this.logTeamWs('error', { teamId: this.currentTeam!.id });
                    if (!this.isDisconnectingWs) this.scheduleReconnect();
                };
                this.teamWs = ws;
            } catch (e) {
                this.logTeamWs('connect_fail', { reason: 'new WebSocket 异常', error: String(e) });
                this.scheduleReconnect();
            }
        };

        tryConnect();
    }

    /** 断线后延迟重连（非轮询，仅重连 WebSocket） */
    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.currentTeam || !this.plugin.settings.apiKey) return;
        this.logTeamWs('reconnect_schedule', { delayMs: 3000 });
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connectTeamWebSocket();
        }, 3000);
    }

    /** 断开团队事件 WebSocket */
    private disconnectTeamWebSocket(): void {
        if (this.reconnectTimer) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.isDisconnectingWs = true;
        this.teamWsTeamId = null;
        if (this.teamWs) {
            this.logTeamWs('disconnect');
            this.teamWs.close();
            this.teamWs = null;
        }
        window.setTimeout(() => { this.isDisconnectingWs = false; }, 0);
    }

    async render() {
        // 防止「新建文档」等操作触发多次 render（本地回调 + WebSocket 推送）并发执行导致 UI 重复
        if (this.renderInProgress) return;
        this.renderInProgress = true;
        try {
            await this.doRender();
        } finally {
            this.renderInProgress = false;
        }
    }

    private async doRender() {
        const container = this.contentEl;
        container.empty();
        container.addClass('team-view');

        // Header
        const header = container.createDiv('team-view-header');
        const titleRow = header.createDiv('team-header-row');
        titleRow.createEl('h4', { text: '团队协作' });
        if (this.plugin.settings.apiKey) {
            this.iconButton(titleRow, 'log-out', '退出登录', 'team-icon-btn', () => {
                void this.logout();
            });
        }
        const currentUserEl = header.createEl('p', { cls: 'team-current-user' });
        currentUserEl.textContent = `当前用户: ${this.plugin.settings.username || '未设置'}`;

        // Check login status — validate token against server
        if (!this.plugin.settings.apiKey) {
            this.renderLoginPrompt(container);
            return;
        }

        // Verify token is still valid
        const isValid = await this.validateSession();
        if (!isValid) {
            // Stale token — clear saved auth and show login
            this.plugin.settings.apiKey = '';
            this.plugin.settings.userId = '';
            this.plugin.settings.username = '';
            await this.plugin.saveSettings();
            this.renderLoginPrompt(container);
            return;
        }

        // Team selector
        await this.renderTeamSelector(container);

        if (this.currentTeam) {
            try {
                this.activity = await this.plugin.teamManager.getActivity(this.currentTeam.id);
            } catch {
                this.activity = [];
            }
            try {
                const fresh = await this.plugin.teamManager.getMentions(this.currentTeam.id);
                this.mentions = this.mergeMentions(fresh);
            } catch {
                this.mentions = this.mentions.slice(0, 20);
            }
            this.renderTeamCard(container);
            // Members section
            this.renderMembers(container);
            this.renderMentions(container);
            this.renderActivity(container);

            // Team Drive documents section
            await this.renderTeamDrive(container);

            // Actions section
            this.renderActions(container);

            // 订阅团队事件 WebSocket：他人删除/新增共享文档时，实时推送并刷新
            this.connectTeamWebSocket();
        } else {
            this.disconnectTeamWebSocket();
            container.createEl('p', {
                text: '请选择或创建一个团队',
                cls: 'team-view-empty'
            });
        }
    }

    /**
     * Validate saved token against the server.
     * Returns true if token is valid and user exists.
     */
    private async validateSession(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/me`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`,
                    'X-User-Id': this.plugin.settings.userId || '',
                },
            });
            const user = readResponseJson<{ id?: string }>(response);
            return response.status === 200 && !!user.id;
        } catch {
            return false;
        }
    }

    private renderLoginPrompt(container: Element) {
        const loginDiv = container.createDiv('team-login-prompt');
        loginDiv.createEl('p', { text: '请先登录以使用团队协作功能' });

        const loginBtn = loginDiv.createEl('button', {
            text: '登录 / 注册',
            cls: 'action-btn'
        });
        loginBtn.addEventListener('click', () => {
            new LoginModal(this.app, this.plugin, () => {
                void this.render();
            }).open();
        });

        // Show logged-in user
        if (this.plugin.settings.username) {
            loginDiv.createEl('p', {
                text: `当前用户: ${this.plugin.settings.username}`,
                cls: 'current-user'
            });
        }
    }

    private async renderTeamSelector(container: Element) {
        // 拉取当前用户的邀请
        try {
            const invitations = await this.plugin.teamManager.getMyInvitations();
            if (invitations && invitations.length > 0) {
                const inviteDiv = container.createDiv('team-invitations');
                this.sectionHeading(inviteDiv, 'mail', `你有 ${invitations.length} 个待处理邀请`);

                for (const inv of invitations) {
                    const item = inviteDiv.createDiv('invitation-item');
                    const teamLabel = inv.teamName || inv.teamId.substring(0, 8);
                    const inviterLabel = inv.inviterName || '未知';
                    item.createSpan({ text: `${inviterLabel} 邀请你加入「${teamLabel}」(${inv.role === 'member' ? '成员' : inv.role === 'admin' ? '管理员' : inv.role})` });

                    const actions = item.createDiv('invitation-actions');
                    const acceptBtn = actions.createEl('button', { text: '接受', cls: 'action-btn accept-btn' });
                    const rejectBtn = actions.createEl('button', { text: '拒绝', cls: 'action-btn reject-btn' });

                    acceptBtn.addEventListener('click', () => {
                        void (async () => {
                            try {
                                const newTeam = await this.plugin.teamManager.acceptInvitation(inv.id);
                                new Notice(`已加入团队: ${newTeam.name}`);
                                this.plugin.settings.currentTeamId = newTeam.id;
                                await this.plugin.saveSettings();
                                this.currentTeam = newTeam;
                                this.plugin.teamManager.setCurrentTeam(newTeam);
                                await this.render();
                            } catch {
                                new Notice(`接受邀请失败，可能已过期或已处理`);
                                await this.render();
                            }
                        })();
                    });

                    rejectBtn.addEventListener('click', () => {
                        void (async () => {
                            try {
                                await this.plugin.teamManager.rejectInvitation(inv.id);
                                new Notice('已拒绝邀请');
                                await this.render();
                            } catch {
                                new Notice(`拒绝邀请失败，可能已过期或已处理`);
                                await this.render();
                            }
                        })();
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load invitations:', e);
        }

        const selectorDiv = container.createDiv('team-selector');
        const select = selectorDiv.createEl('select', { cls: 'team-select' });
        select.createEl('option', { text: '选择团队...', value: '' });

        try {
            const teams = await this.plugin.teamManager.getMyTeams();

            for (const team of teams) {
                const option = select.createEl('option', {
                    text: team.name,
                    value: team.id,
                });

                if (team.id === this.plugin.settings.currentTeamId) {
                    option.selected = true;
                    this.currentTeam = team;
                    this.plugin.teamManager.setCurrentTeam(team);
                }
            }
        } catch (e) {
            console.error('Failed to load teams:', e);
        }

        select.addEventListener('change', () => {
            void (async () => {
                this.plugin.settings.currentTeamId = select.value;
                await this.plugin.saveSettings();

                if (select.value) {
                    this.currentTeam = await this.plugin.teamManager.getTeam(select.value);
                    this.plugin.teamManager.setCurrentTeam(this.currentTeam);
                } else {
                    this.currentTeam = null;
                    this.plugin.teamManager.setCurrentTeam(null);
                }

                await this.render();
            })();
        });

        // Create team button
        this.iconButton(selectorDiv, 'plus', '创建新团队', 'team-create-btn team-icon-btn', () => {
            new CreateTeamModal(this.app, this.plugin).open();
        });
    }

    private iconButton(parent: Element, icon: string, label: string, cls: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
        const button = (parent as HTMLElement).createEl('button', {
            cls,
            attr: { 'aria-label': label, title: label },
        });
        setIcon(button, icon);
        const iconOnly = cls.split(' ').some(name => name === 'doc-icon-btn' || name === 'team-icon-btn');
        if (!iconOnly) {
            button.createSpan({ text: label, cls: 'team-btn-label' });
        }
        button.type = 'button';
        const stop = (event: Event) => event.stopPropagation();
        button.addEventListener('pointerdown', stop);
        button.addEventListener('mousedown', stop);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick(event);
        });
        return button;
    }

    private sectionHeading(parent: Element, icon: string, text: string): void {
        const heading = (parent as HTMLElement).createEl('h5', { cls: 'team-section-title' });
        setIcon(heading.createSpan({ cls: 'team-section-icon' }), icon);
        heading.createSpan({ text });
    }

    private renderTeamCard(container: Element): void {
        if (!this.currentTeam) return;
        const team = this.currentTeam;
        const card = container.createDiv('team-card');
        const main = card.createDiv('team-card-main');
        main.createEl('h3', { text: team.name, cls: 'team-card-name' });
        const description = team.description?.trim();
        main.createEl('p', {
            text: description || '还没有简介',
            cls: description ? 'team-card-desc' : 'team-card-desc is-empty',
        });
        const me = team.members.find(member => member.userId === this.plugin.settings.userId);
        if (me) {
            main.createSpan({ text: this.getRoleText(me.role), cls: 'team-card-role' });
        }
        if (this.plugin.teamManager.hasPermission('manage_settings')) {
            this.iconButton(card, 'pencil', '编辑团队', 'team-icon-btn', () => {
                new EditTeamModal(this.app, this.plugin, team, () => {
                    void this.render();
                }).open();
            });
            const row = card.createDiv('team-setting-row');
            row.createSpan({ text: '允许成员邀请' });
            const toggle = row.createEl('input', { type: 'checkbox' });
            toggle.checked = !!team.settings?.allowMemberInvite;
            toggle.addEventListener('change', () => {
                void this.plugin.teamManager.updateTeamSettings(team.id, { allowMemberInvite: toggle.checked })
                    .then(updated => {
                        this.currentTeam = updated;
                        this.plugin.teamManager.setCurrentTeam(updated);
                    })
                    .catch((error: unknown) => {
                        toggle.checked = !toggle.checked;
                        new Notice(getErrorMessage(error) || '设置失败');
                    });
            });
        }
    }

    private async logout(): Promise<void> {
        this.disconnectTeamWebSocket();
        this.plugin.settings.apiKey = '';
        this.plugin.settings.userId = '';
        this.plugin.settings.username = '';
        this.currentTeam = null;
        this.plugin.teamManager.setCurrentTeam(null);
        await this.plugin.saveSettings();
        await this.render();
    }

    private paintOnline(): void {
        this.contentEl.querySelectorAll<HTMLElement>('.member-item').forEach(item => {
            const userId = item.getAttribute('data-user-id');
            const online = !!userId && this.onlineUserIds.has(userId);
            const badge = item.querySelector('.member-online');
            if (online && !badge) {
                const info = item.querySelector('.member-info');
                if (info instanceof HTMLElement) {
                    info.createSpan({ text: '在线', cls: 'member-online' });
                }
            } else if (!online && badge) {
                badge.remove();
            }
        });
    }

    private activitySubject(item: { action: string; detail: string }): string {
        if (item.action === 'permission' || item.action === 'team_updated') {
            return item.detail.split(' → ')[0];
        }
        if (item.action === 'comment') return item.detail.split(':')[0];
        return item.detail;
    }

    /** 同一人反复改同一篇文档的权限，只留最新一条 */
    private compactActivity(): Array<{ actorName: string; action: string; detail: string; createdAt: number }> {
        const seen = new Set<string>();
        const rows = [];
        for (const item of this.activity) {
            if (item.action === 'permission') {
                const key = `${item.actorName}\0${this.activitySubject(item)}`;
                if (seen.has(key)) continue;
                seen.add(key);
            }
            rows.push(item);
            if (rows.length >= 5) break;
        }
        return rows;
    }

    private shortFileName(path: string): string {
        const base = (path.split('/').pop() || path).replace(/\.md$/i, '');
        return base.length > 14 ? `${base.slice(0, 14)}…` : base;
    }

    private relativeTime(ts: number): string {
        const delta = Date.now() - ts;
        if (delta < 60_000) return '刚刚';
        if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
        const date = new Date(ts);
        const hm = formatHourMinute(ts);
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        if (ts >= start.getTime()) return hm;
        return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
    }

    private activityLine(item: { actorName: string; action: string; detail: string; createdAt: number }): string {
        const when = this.relativeTime(item.createdAt);
        const file = this.shortFileName(this.activitySubject(item));
        switch (item.action) {
            case 'document_created': return `${when} ${item.actorName} 新建了「${file}」`;
            case 'document_deleted': return `${when} ${item.actorName} 删除了「${file}」`;
            case 'comment': return `${when} ${item.actorName} 评论了「${file}」`;
            case 'permission': {
                const state = item.detail.includes('只读') ? '只读' : '可编辑';
                return `${when} ${item.actorName} 把「${file}」改为${state}`;
            }
            case 'team_updated': return `${when} ${item.actorName} 更新了团队`;
            default: return `${when} ${item.actorName} ${item.detail}`;
        }
    }

    private rememberMention(data: TeamDriveChangedMessage): void {
        if (!data.filePath || !data.actorName) return;
        const item: TeamMention = {
            id: data.id || `live-${data.createdAt || Date.now()}-${data.fileId || ''}`,
            actorName: data.actorName,
            fileId: data.fileId || '',
            filePath: data.filePath,
            kind: data.kind || 'body',
            excerpt: data.excerpt || '',
            createdAt: data.createdAt || Date.now(),
        };
        this.mentions = [item, ...this.mentions.filter(row => row.id !== item.id)].slice(0, 20);
    }

    private mergeMentions(fresh: TeamMention[]): TeamMention[] {
        const seen = new Set(fresh.map(item => item.id));
        const extra = this.mentions.filter(item => !seen.has(item.id));
        return [...extra, ...fresh].slice(0, 20);
    }

    private mentionText(item: { actorName?: string; filePath?: string; kind?: string }): string {
        const who = item.actorName || '有人';
        const file = this.shortFileName(item.filePath || '');
        if (item.kind === 'annotation') return `${who} 在「${file}」的标注里提到了你`;
        if (item.kind === 'comment') return `${who} 在「${file}」的评论里提到了你`;
        return `${who} 在「${file}」里提到了你`;
    }

    private renderMentions(container: Element): void {
        if (this.mentions.length === 0) return;
        const section = container.createDiv('team-mentions');
        this.sectionHeading(section, 'at-sign', '提及我');
        for (const item of this.mentions.slice(0, 5)) {
            const line = section.createEl('p', { cls: 'activity-item mention-item' });
            line.textContent = `${this.relativeTime(item.createdAt)} ${this.mentionText(item)}`;
            line.addEventListener('click', () => {
                void this.openTeamPath(item.filePath);
            });
        }
    }

    private async openTeamPath(localPath: string): Promise<void> {
        if (!localPath || !this.currentTeam) return;
        const teamPrefix = `团队云盘/${this.currentTeam.name}`;
        let file = this.app.vault.getAbstractFileByPath(localPath);
        if (!file) {
            if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                await this.app.vault.createFolder('团队云盘');
            }
            if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                await this.app.vault.createFolder(teamPrefix);
            }
            file = await this.app.vault.create(localPath, '');
        }
        await this.app.workspace.openLinkText(localPath, '', false);
    }

    private renderActivity(container: Element): void {
        const section = container.createDiv('team-activity');
        this.sectionHeading(section, 'activity', '团队动态');
        const rows = this.compactActivity();
        if (rows.length === 0) {
            section.createEl('p', { text: '还没有动态', cls: 'empty-message' });
            return;
        }
        for (const item of rows) {
            section.createEl('p', { text: this.activityLine(item), cls: 'activity-item' });
        }
    }

    private renderMembers(container: Element) {
        if (!this.currentTeam) return;

        const membersDiv = container.createDiv('team-members');
        this.sectionHeading(membersDiv, 'users', '团队成员');

        const memberList = membersDiv.createEl('ul', { cls: 'member-list' });

        for (const member of this.currentTeam.members) {
            const li = memberList.createEl('li', { cls: 'member-item' });
            li.setAttribute('data-user-id', member.userId);

            // Avatar
            const avatar = li.createDiv('member-avatar');
            avatar.textContent = member.username.charAt(0).toUpperCase();

            // Info
            const info = li.createDiv('member-info');
            info.createSpan({ text: member.username, cls: 'member-name' });
            info.createSpan({ text: this.getRoleText(member.role), cls: 'member-role' });
            if (this.onlineUserIds.has(member.userId)) {
                info.createSpan({ text: '在线', cls: 'member-online' });
            }

            // Context menu
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showMemberMenu(e, member);
            });
        }

        // Invite button
        if (this.plugin.teamManager.hasPermission('manage_members')) {
            this.iconButton(membersDiv, 'user-plus', '邀请成员', 'team-invite-btn', () => {
                if (this.currentTeam) {
                    new InviteMemberModal(this.app, this.plugin, this.currentTeam.id).open();
                }
            });
        }
    }

    private async renderTeamDrive(container: Element) {
        if (!this.currentTeam) return;

        const driveDiv = container.createDiv('team-drive');
        this.sectionHeading(driveDiv, 'folder', '团队文件库');

        const toolbar = driveDiv.createDiv('team-drive-toolbar');
        this.iconButton(toolbar, 'plus', '新建文档', 'team-toolbar-btn', () => {
            void (async () => {
                const filename = `未命名文档-${Date.now()}.md`;
                const teamPrefix = `团队云盘/${this.currentTeam!.name}`;
                const fullPath = `${teamPrefix}/${filename}`;
                try {
                    await this.plugin.teamManager.createTeamDocument(this.currentTeam!.id, fullPath);
                    new Notice(`已在云端创建文档: ${filename}`);
                    await this.render();
                } catch (e: unknown) {
                    new Notice(`创建云文档失败: ${getErrorMessage(e)}`);
                }
            })();
        });
        this.iconButton(toolbar, 'upload', '上传本地文件', 'team-toolbar-btn', () => {
            this.showLocalFilePicker();
        });

        const searchRow = driveDiv.createDiv('team-search-row');
        const searchInput = searchRow.createEl('input', { type: 'text', placeholder: '搜索标题或正文' });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                this.searchQuery = searchInput.value.trim();
                void this.render();
            }
        });
        this.iconButton(searchRow, 'search', '搜索', 'team-search-btn', () => {
            this.searchQuery = searchInput.value.trim();
            void this.render();
        });

        try {
            this.teamDocs = await this.plugin.teamManager.getTeamDocuments(this.currentTeam.id);

            // 新文件自动出现在左侧团队云盘：为云端有但本地无的文档创建空文件
            const teamPrefix = `团队云盘/${this.currentTeam.name}`;
            for (const doc of this.teamDocs) {
                if (!this.app.vault.getAbstractFileByPath(doc.path)) {
                    if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                        await this.app.vault.createFolder('团队云盘');
                    }
                    if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                        await this.app.vault.createFolder(teamPrefix);
                    }
                    await this.app.vault.create(doc.path, '');
                }
            }

            let docsToShow = this.teamDocs;
            if (this.searchQuery) {
                const hits = await this.plugin.teamManager.searchDocuments(this.currentTeam.id, this.searchQuery);
                const ids = new Set(hits.map(hit => hit.id));
                docsToShow = this.teamDocs.filter(doc => ids.has(doc.id));
            }

            if (docsToShow.length === 0) {
                driveDiv.createEl('p', { text: this.searchQuery ? '没有匹配的文档' : '云盘是空的', cls: 'empty-message' });
            } else {
                const docList = driveDiv.createEl('ul', { cls: 'doc-list' });

                for (const doc of docsToShow) {
                    const li = docList.createEl('li', { cls: 'doc-item' });

                    const leftDiv = li.createDiv({ cls: 'doc-item-left' });
                    const icon = leftDiv.createSpan({ cls: 'doc-icon' });
                    setIcon(icon, 'file-text');
                    const filename = doc.path.split('/').pop() || doc.path;
                    leftDiv.createSpan({ text: filename, cls: 'doc-title' });

                    const rightDiv = li.createDiv({ cls: 'doc-item-right' });
                    if (doc.lastEditorName) {
                        rightDiv.createSpan({ text: `最后由 ${doc.lastEditorName} 编辑`, cls: 'doc-editor' });
                    }

                    if (this.plugin.teamManager.hasPermission('manage_settings')) {
                        this.iconButton(
                            rightDiv,
                            doc.permission === 'read' ? 'lock' : 'lock-open',
                            doc.permission === 'read' ? '改为可编辑' : '改为只读',
                            'doc-icon-btn',
                            (event) => {
                                event.stopPropagation();
                                const next = doc.permission === 'read' ? 'write' : 'read';
                                void this.plugin.teamManager.setDocumentPermission(this.currentTeam!.id, doc.id, next)
                                    .then(() => this.render())
                                    .catch((err: unknown) => new Notice(getErrorMessage(err) || '修改权限失败'));
                            },
                        );
                    } else if (doc.permission === 'read') {
                        const lock = rightDiv.createSpan({ cls: 'doc-perm-label' });
                        setIcon(lock, 'lock');
                        lock.setAttribute('aria-label', '只读');
                    }

                    this.iconButton(rightDiv, 'message-square', '评论', 'doc-comment-btn', () => {
                        const teamId = this.currentTeam?.id;
                        if (!teamId) {
                            new Notice('请先选择团队');
                            return;
                        }
                        // 等这一下点击结束再打开，避免弹窗被同一次点击立刻关掉
                        window.setTimeout(() => {
                            try {
                                new CommentModal(this.app, this.plugin, teamId, doc).open();
                            } catch (error: unknown) {
                                new Notice(getErrorMessage(error) || '无法打开评论');
                            }
                        }, 0);
                    });

                    this.iconButton(rightDiv, 'history', '历史版本', 'doc-icon-btn', (event) => {
                        event.stopPropagation();
                        new HistoryModal(this.app, this.plugin, this.currentTeam!.id, doc.id, doc.path).open();
                    });

                    this.iconButton(rightDiv, 'trash-2', '删除', 'doc-icon-btn', (event) => {
                        event.stopPropagation();
                        void (async () => {
                            try {
                                if (this.plugin.collabEditor.isActive && this.plugin.collabEditor.activeFilePath === doc.path) {
                                    this.plugin.collabEditor.stopCollab();
                                }
                                await this.plugin.teamManager.deleteTeamDocument(this.currentTeam!.id, doc.id);
                                const localFile = this.app.vault.getAbstractFileByPath(doc.path);
                                if (localFile instanceof TFile) {
                                    await this.app.fileManager.trashFile(localFile);
                                }
                                new Notice('已从云端删除此文件');
                                await this.render();
                            } catch (err: unknown) {
                                new Notice(getErrorMessage(err) || '删除失败');
                            }
                        })();
                    });

                    // 点击时自动与本地目录挂钩，并抛给 Obsidian 的文件系统去开启
                    li.addEventListener('click', (event) => {
                        const target = event.target as HTMLElement | null;
                        if (target?.closest('button, .doc-item-right')) return;
                        void (async () => {
                            const teamPrefix = `团队云盘/${this.currentTeam!.name}`;
                            const localPath = doc.path;

                            let file = this.app.vault.getAbstractFileByPath(localPath);
                            if (!file) {
                                if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                                    await this.app.vault.createFolder('团队云盘');
                                }
                                if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                                    await this.app.vault.createFolder(teamPrefix);
                                }
                                file = await this.app.vault.create(localPath, '');
                            }

                            await this.app.workspace.openLinkText(localPath, '', false);
                            new Notice(`正在为您接入团队文档...`);
                        })();
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load team docs:', e);
            driveDiv.createEl('p', { text: '加载云盘失败', cls: 'error-message' });
        }
    }

    private renderActions(container: Element) {
        const actionsDiv = container.createDiv('team-actions');
        this.iconButton(actionsDiv, 'plug', '同步插件', 'action-btn', () => {
            void this.plugin.syncTeamPlugins();
        });
        this.iconButton(actionsDiv, 'clipboard-list', '生成报告', 'action-btn', () => {
            this.plugin.openReportModal();
        });

        const me = this.currentTeam?.members.find(member => member.userId === this.plugin.settings.userId);
        if (me && me.role !== 'owner' && this.currentTeam) {
            const team = this.currentTeam;
            this.iconButton(actionsDiv, 'log-out', '离开团队', 'action-btn', () => {
                new ConfirmActionModal(this.app, '离开团队', `确定离开「${team.name}」？`, '离开', () => {
                    void this.plugin.teamManager.leaveTeam(team.id).then(async () => {
                        this.plugin.settings.currentTeamId = '';
                        await this.plugin.saveSettings();
                        this.currentTeam = null;
                        new Notice('已离开团队');
                        await this.render();
                    }).catch((error: unknown) => new Notice(getErrorMessage(error) || '离开失败'));
                }).open();
            });
        }
        if (this.plugin.teamManager.hasPermission('delete_team') && this.currentTeam) {
            const team = this.currentTeam;
            this.iconButton(actionsDiv, 'trash-2', '删除团队', 'action-btn team-danger-btn', () => {
                new ConfirmActionModal(this.app, '删除团队', `确定删除「${team.name}」？云端文档会一起删除。`, '删除', () => {
                    void this.plugin.teamManager.deleteTeam(team.id).then(async () => {
                        this.plugin.settings.currentTeamId = '';
                        await this.plugin.saveSettings();
                        this.currentTeam = null;
                        new Notice('团队已删除');
                        await this.render();
                    }).catch((error: unknown) => new Notice(getErrorMessage(error) || '删除失败'));
                }, true).open();
            });
        }
    }

    private getRoleText(role: string): string {
        const roleMap: Record<string, string> = {
            'owner': '所有者',
            'admin': '管理员',
            'member': '成员',
            'viewer': '访客'
        };
        return roleMap[role] || role;
    }

    private showMemberMenu(event: MouseEvent, member: TeamMember) {
        const menu = new Menu();

        if (this.currentTeam?.ownerId === this.plugin.settings.userId && member.userId !== this.plugin.settings.userId) {
            const roles: TeamRole[] = ['admin', 'member', 'viewer'];
            for (const role of roles) {
                if (member.role === role) continue;
                menu.addItem(item => item
                    .setTitle(`设为${this.getRoleText(role)}`)
                    .setIcon('user-cog')
                    .onClick(() => {
                        void this.plugin.teamManager.updateMemberRole(this.currentTeam!.id, member.userId, role)
                            .then(() => this.render())
                            .catch((error: unknown) => new Notice(getErrorMessage(error) || '修改角色失败'));
                    })
                );
            }
        }

        if (this.plugin.teamManager.hasPermission('manage_members') &&
            member.userId !== this.plugin.settings.userId &&
            member.role !== 'owner') {
            menu.addItem(item => item
                .setTitle('移除成员')
                .setIcon('user-minus')
                .onClick(() => {
                    void (async () => {
                        if (this.currentTeam) {
                            await this.plugin.teamManager.removeMember(this.currentTeam.id, member.userId);
                            await this.render();
                        }
                    })();
                })
            );
        }

        menu.showAtMouseEvent(event);
    }

    /**
     * 弹出本地文件选择器，让用户选取已有的 .md 文件上传到团队云盘
     */
    private showLocalFilePicker() {
        if (!this.currentTeam) return;
        const team = this.currentTeam;
        const teamPrefix = `团队云盘/${team.name}`;

        // 收集 vault 中所有 .md 文件（排除已在团队云盘目录下的）
        const allFiles = this.app.vault.getMarkdownFiles().filter(f => !f.path.startsWith('团队云盘/'));

        if (allFiles.length === 0) {
            new Notice('没有找到可上传的本地 Markdown 文件');
            return;
        }

        // 使用 Obsidian 的 FuzzySuggestModal 供用户搜索选择
        const modal = new LocalFileSuggestModal(this.app, allFiles, (file: TFile) => {
            void (async () => {
                try {
                    const content = await this.app.vault.read(file);
                    const cloudPath = `${teamPrefix}/${file.name}`;

                    await this.plugin.teamManager.createTeamDocument(team.id, cloudPath, content);

                    if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                        await this.app.vault.createFolder('团队云盘');
                    }
                    if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                        await this.app.vault.createFolder(teamPrefix);
                    }

                    if (!this.app.vault.getAbstractFileByPath(cloudPath)) {
                        await this.app.vault.rename(file, cloudPath);
                    }

                    new Notice(`已将「${file.name}」上传到团队云盘`);
                    await this.render();
                } catch (e: unknown) {
                    new Notice(`上传失败: ${getErrorMessage(e)}`);
                }
            })();
        });
        modal.open();
    }
}

/**
 * 本地文件模糊搜索弹窗
 */
class ConfirmActionModal extends Modal {
    private readonly title: string;
    private readonly message: string;
    private readonly confirmText: string;
    private readonly onConfirm: () => void;
    private readonly destructive: boolean;

    constructor(app: App, title: string, message: string, confirmText: string, onConfirm: () => void, destructive = false) {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmText = confirmText;
        this.onConfirm = onConfirm;
        this.destructive = destructive;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });
        const row = contentEl.createDiv('team-confirm-actions');
        const confirm = row.createEl('button', { text: this.confirmText, cls: this.destructive ? 'mod-warning' : 'mod-cta' });
        confirm.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });
        const cancel = row.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class LocalFileSuggestModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onChoose: (file: TFile) => void;

    constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.setPlaceholder('搜索并选择要上传的本地文件...');
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChoose(item);
    }
}
