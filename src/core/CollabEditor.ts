/**
 * CollabEditor - 实时协同编辑核心模块
 * 
 * 使用 Yjs (CRDT) + WebSocket + CodeMirror 6 绑定
 * 实现飞书/腾讯文档式的实时多人协同编辑
 */

import { App, Notice, TFile, Plugin } from 'obsidian';
import { TeamPluginSettings } from '../types';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { getMarkdownEditorView } from '../utils/obsidian';
import { AnnotationHost, teamAnnotationExtension } from './DocAnnotations';
import { MentionHost, teamMentionExtension } from './DocMentions';
import { devLog } from '../utils/devLog';

/** 协同会话信息 */
interface CollabSession {
    ydoc: Y.Doc;
    provider: WebsocketProvider;
    file: TFile;
    roomName: string;
    cleanup: () => void;
}

/** 协同状态回调 */
export type CollabStatusCallback = (status: 'connecting' | 'connected' | 'disconnected', info?: string) => void;

export class CollabEditor {
    private app: App;
    private plugin: Plugin;
    private settings: TeamPluginSettings;
    private activeSession: CollabSession | null = null;
    private onStatusChange: CollabStatusCallback | null = null;
    public collabCompartment: Compartment;
    public onAuthFailed: (() => void) | null = null;
    private sessionReadOnly = false;
    private annotationTeamId = '';
    private annotationDocId = '';

    constructor(app: App, plugin: Plugin, settings: TeamPluginSettings) {
        this.app = app;
        this.plugin = plugin;
        this.settings = settings;
        this.collabCompartment = new Compartment();
        // 全局注册 Compartment 占位符，以便在每个编辑器中都能动态注入
        this.plugin.registerEditorExtension(this.collabCompartment.of([]));
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    /** 设置状态回调 */
    setStatusCallback(callback: CollabStatusCallback) {
        this.onStatusChange = callback;
    }

    /** 获取当前是否有活跃的协同会话 */
    get isActive(): boolean {
        return this.activeSession !== null;
    }

    /** 获取当前协同的文件路径 */
    get activeFilePath(): string | null {
        return this.activeSession?.file.path || null;
    }

    /**
     * 开始协同编辑当前打开的文件
     */
    async startCollab(teamId: string, file: TFile, options?: { readOnly?: boolean; documentId?: string }): Promise<void> {
        // 如果已有会话，先停止
        if (this.activeSession) {
            this.stopCollab();
        }
        this.sessionReadOnly = !!options?.readOnly;
        this.annotationTeamId = teamId;
        this.annotationDocId = options?.documentId || '';

        // 获取 WebSocket 地址
        const wsUrl = this.getWebSocketUrl();
        const roomName = `team:${teamId}:${file.path}`;

        this.onStatusChange?.('connecting', `正在连接协同...`);

        // 创建 Yjs 文档
        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codemirror');

        devLog('[CollabEditor] WebSocket', { url: wsUrl, room: roomName });
        const provider = new WebsocketProvider(wsUrl, roomName, ydoc, {
            params: {
                token: this.settings.apiKey,
                room: roomName,
            },
            connect: true,
        });

        // 设置用户信息（用于远程光标显示）。颜色按用户名固定，避免每次重连变色。
        const displayName = this.settings.username || '匿名';
        const color = this.colorForName(displayName);
        provider.awareness.setLocalStateField('user', {
            name: displayName,
            color,
            colorLight: this.lighten(color),
        });
        const onAwareness = () => this.publishPresence(file, provider);
        provider.awareness.on('change', onAwareness);

        // 监听连接状态
        provider.on('status', (event: { status: string }) => {
            devLog('[CollabEditor] Provider 状态', event.status);
            if (event.status === 'connected') {
                this.publishPresence(file, provider);
            } else if (event.status === 'disconnected') {
                this.onStatusChange?.('disconnected', '连接断开，正在重连...');
            }
        });

        provider.on('connection-error', (event: Event) => {
            console.error('[CollabEditor] WebSocket 连接错误:', event);
        });

        provider.on('connection-close', (event: CloseEvent | null) => {
            console.warn('[CollabEditor] WebSocket 连接关闭:', event?.code, event?.reason);
            if (event?.code === 4001 && this.onAuthFailed) {
                this.onAuthFailed();
            }
        });

        // 等待首次同步完成
        await new Promise<void>((resolve) => {
            if (provider.synced) {
                resolve();
            } else {
                provider.once('sync', () => resolve());
            }
            window.setTimeout(() => resolve(), 5000);
        });
        devLog('[CollabEditor] 同步结束', { length: ytext.length, connected: provider.wsconnected });

        // 如果这是新文档（服务器上还没有内容），用本地内容初始化
        // 优先使用 EditorView 当前内容（含未保存编辑），否则用 vault 文件内容
        if (ytext.length === 0) {
            const editorView = this.getEditorView(file);
            const localContent = editorView
                ? editorView.state.doc.toString()
                : await this.app.vault.read(file);
            if (localContent.length > 0) {
                ytext.insert(0, localContent);
            }
        }

        // 等待编辑器完全渲染就绪（Obsidian 的 file-open 事件触发时 MarkdownView 可能还没初始化完成）
        await new Promise<void>(resolve => window.setTimeout(resolve, 600));
        devLog('[CollabEditor] 开始绑定编辑器', { length: ytext.length, synced: provider.synced });

        // 绑定到 CodeMirror 6 编辑器
        const cleanup = this.bindToEditor(file, ydoc, provider);

        this.activeSession = {
            ydoc,
            provider,
            file,
            roomName,
            cleanup: () => {
                provider.awareness.off('change', onAwareness);
                cleanup();
            },
        };

        new Notice(`开始协同编辑「${file.basename}」`);
    }

    /**
     * 停止协同编辑
     */
    stopCollab(): void {
        if (!this.activeSession) return;

        const fileName = this.activeSession.file.basename;

        // 清理编辑器绑定
        this.activeSession.cleanup();

        // 断开 WebSocket
        this.activeSession.provider.disconnect();
        this.activeSession.provider.destroy();
        this.activeSession.ydoc.destroy();

        this.activeSession = null;
        this.onStatusChange?.('disconnected', '已停止协同');

        new Notice(`已停止协同编辑「${fileName}」`);
    }

    /**
     * 绑定 Yjs 到当前打开文件的 CodeMirror 6 编辑器
     */
    private bindToEditor(file: TFile, ydoc: Y.Doc, provider: WebsocketProvider): () => void {
        const ytext = ydoc.getText('codemirror');
        const undoManager = new Y.UndoManager(ytext);
        let isCleaned = false;
        let retryTimer: number | null = null;

        const doInject = (editorView: EditorView) => {
            if (isCleaned) return;

            // 切换笔记时编辑器会被复用，旧的协同还挂着。先卸掉，再改正文，否则会去写只读的 doc。
            try {
                editorView.dispatch({
                    effects: this.collabCompartment.reconfigure([]),
                });
            } catch (error) {
                console.error('[CollabEditor] 卸载旧协同失败', error);
            }

            const currentDoc = editorView.state.doc.toString();
            const ytextContent = ytext.toString();
            if (currentDoc !== ytextContent) {
                try {
                    editorView.dispatch({
                        changes: { from: 0, to: editorView.state.doc.length, insert: ytextContent },
                    });
                } catch (error) {
                    console.error('[CollabEditor] 对齐文档失败', error);
                }
            }

            const collabExtension = yCollab(ytext, provider.awareness, { undoManager });
            const extensions = [collabExtension];
            if (this.annotationTeamId && this.annotationDocId) {
                const host = this.plugin as unknown as AnnotationHost & MentionHost;
                extensions.push(teamAnnotationExtension({
                    teamId: this.annotationTeamId,
                    documentId: this.annotationDocId,
                    host,
                }));
                extensions.push(teamMentionExtension({
                    teamId: this.annotationTeamId,
                    documentId: this.annotationDocId,
                    readOnly: this.sessionReadOnly,
                    host,
                }));
            }
            if (this.sessionReadOnly) {
                extensions.push(EditorView.editable.of(false));
            }
            try {
                editorView.dispatch({
                    effects: this.collabCompartment.reconfigure(extensions),
                });
            } catch (error) {
                console.error('[CollabEditor] 挂载协同失败', error);
                new Notice('协同编辑启动失败');
            }
            devLog('[CollabEditor] 协同扩展已挂上');
        };

        const editorView = this.getEditorView(file);
        devLog('[CollabEditor] EditorView', editorView ? '已拿到' : '稍后重试');
        if (editorView) {
            doInject(editorView);
        } else {
            // 编辑器还没就绪，启动重试轮询
            console.warn('[CollabEditor] EditorView 首次获取失败，启动重试...');
            let retries = 0;
            const maxRetries = 15;
            const poll = () => {
                if (isCleaned) return;
                retries++;
                const ev = this.getEditorView(file);
                devLog('[CollabEditor] 重试获取 EditorView', { retry: retries, found: !!ev });
                if (ev) {
                    doInject(ev);
                } else if (retries < maxRetries) {
                    retryTimer = window.setTimeout(poll, 300);
                } else {
                    console.error('[CollabEditor] 重试 ' + maxRetries + ' 次后仍无法获取 EditorView');
                }
            };
            retryTimer = window.setTimeout(poll, 300);
        }

        // 返回清理函数
        return () => {
            isCleaned = true;
            if (retryTimer) window.clearTimeout(retryTimer);
            try {
                // 找到当前活跃的 EditorView 来卸载扩展
                const ev = this.getEditorView(file);
                if (ev) {
                    ev.dispatch({
                        effects: this.collabCompartment.reconfigure([])
                    });
                }
            } catch {
                // Ignore if view is already destroyed
            }
            undoManager.destroy();
        };
    }

    /**
     * 获取文件对应的 CodeMirror 6 EditorView 实例
     */
    private getEditorView(file: TFile): EditorView | null {
        return getMarkdownEditorView(file, this.app);
    }

    /**
     * 获取 WebSocket 地址
     */
    private getWebSocketUrl(): string {
        // 优先使用插件中单独配置的 wsUrl
        if (this.settings.wsUrl) {
            return this.settings.wsUrl.trim();
        }

        // 未配置的情况下，尝试从常规的 serverUrl 自动推导
        const httpUrl = this.settings.serverUrl.replace(/\/+$/, '');
        const wsUrl = httpUrl.replace(/^http/, 'ws') + '/ws/collab';
        return wsUrl;
    }

    /** 当前文档里除自己以外的在线协作者 */
    private listPeerNames(provider: WebsocketProvider): string[] {
        const names: string[] = [];
        provider.awareness.getStates().forEach((state, clientId) => {
            if (clientId === provider.awareness.clientID) return;
            const user = (state as { user?: { name?: string } }).user;
            if (user?.name) names.push(user.name);
        });
        return names;
    }

    private publishPresence(file: TFile, provider: WebsocketProvider): void {
        const peers = this.listPeerNames(provider);
        const who = peers.length > 0 ? ` · 同时在线: ${peers.join('、')}` : '';
        const mode = this.sessionReadOnly ? '只读查看' : '协同编辑中';
        this.onStatusChange?.('connected', `${mode}: ${file.basename}${who}`);
    }

    /** 同一用户名始终得到同一种光标颜色 */
    private colorForName(name: string): string {
        const colors = ['#30bced', '#6eeb83', '#ffbc42', '#e84855', '#8ac926', '#ff6b6b', '#4ecdc4', '#a06cd5'];
        let hash = 0;
        for (const ch of name) {
            hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        }
        return colors[hash % colors.length];
    }

    private lighten(hex: string): string {
        return `${hex}33`;
    }
}
