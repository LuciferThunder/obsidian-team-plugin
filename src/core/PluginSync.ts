import { App, requestUrl, type PluginManifest } from 'obsidian';
import { PluginInfo, PluginSyncPackage } from '../types/document';
import { TeamPluginSettings } from '../types';
import { readResponseJson } from '../utils/api';
import { getEnabledPluginIds, getPluginInstaller } from '../utils/obsidian';

interface InstalledPluginEntry {
    manifest?: PluginManifest;
}

interface PluginsRegistry {
    plugins?: Record<string, InstalledPluginEntry>;
}

export class PluginSync {
    private app: App;
    private settings: TeamPluginSettings;

    constructor(app: App, settings: TeamPluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    private getApiUrl(apiPath: string): string {
        return `${this.settings.serverUrl}${apiPath}`;
    }

    private async request<T>(apiPath: string, method: string, body?: unknown): Promise<T> {
        const response = await requestUrl({
            url: this.getApiUrl(apiPath),
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.apiKey}`,
                'X-User-Id': this.settings.userId,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (response.status >= 400) {
            throw new Error(`API error: ${response.status}`);
        }

        return readResponseJson<T>(response);
    }

    private getPluginsRegistry(): Record<string, InstalledPluginEntry> {
        const host = (this.app as App & { plugins?: PluginsRegistry }).plugins;
        const source = host?.plugins;
        const registry: Record<string, InstalledPluginEntry> = {};
        if (!source) return registry;
        for (const key in source) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
            const entry = source[key];
            if (entry) registry[key] = entry;
        }
        return registry;
    }

    private getPluginDataPath(pluginId: string): string {
        return `${this.app.vault.configDir}/plugins/${pluginId}/data.json`;
    }

    /**
     * Get list of installed plugins
     */
    async getInstalledPlugins(): Promise<PluginInfo[]> {
        const plugins: PluginInfo[] = [];
        const enabledPlugins = getEnabledPluginIds(this.app);
        const adapter = this.app.vault.adapter;

        const registry = this.getPluginsRegistry();
        for (const key in registry) {
            if (!Object.prototype.hasOwnProperty.call(registry, key)) continue;
            const manifest = registry[key]?.manifest;
            const id = manifest?.id;
            if (!id) continue;

            try {
                const hasSettings = await adapter.exists(this.getPluginDataPath(id));

                if (id !== 'team-collaboration' &&
                    !this.settings.excludedPlugins.includes(id)) {
                    plugins.push({
                        id,
                        name: manifest.name,
                        version: manifest.version,
                        enabled: enabledPlugins.has(id),
                        hasSettings,
                    });
                }
            } catch (e) {
                console.error(`Error reading manifest for ${id}:`, e);
            }
        }

        return plugins;
    }

    /**
     * Create a sync package with plugin list and optional settings
     */
    async createSyncPackage(): Promise<PluginSyncPackage> {
        const plugins = await this.getInstalledPlugins();
        const settings: Record<string, unknown> = {};
        const adapter = this.app.vault.adapter;

        if (this.settings.syncPluginSettings) {
            for (const plugin of plugins) {
                if (plugin.hasSettings) {
                    const dataPath = this.getPluginDataPath(plugin.id);
                    try {
                        const dataContent = await adapter.read(dataPath);
                        settings[plugin.id] = JSON.parse(dataContent) as unknown;
                    } catch (e) {
                        console.error(`Error reading settings for ${plugin.id}:`, e);
                    }
                }
            }
        }

        return {
            plugins,
            settings,
            timestamp: Date.now(),
        };
    }

    /**
     * Share plugin configuration with team
     */
    async sharePluginConfig(teamId: string): Promise<void> {
        const syncPackage = await this.createSyncPackage();

        await this.request('/api/plugins/share', 'POST', {
            teamId,
            ...syncPackage,
        });
    }

    /**
     * Get shared plugin configuration from team
     */
    async getTeamPluginConfig(teamId: string): Promise<PluginSyncPackage> {
        return await this.request<PluginSyncPackage>(`/api/teams/${teamId}/plugins`, 'GET');
    }

    /**
     * Install plugins from sync package
     * Note: This will only install from community plugins, not arbitrary sources
     */
    async installPluginsFromPackage(syncPackage: PluginSyncPackage): Promise<{
        installed: string[];
        failed: string[];
        skipped: string[];
    }> {
        const installed: string[] = [];
        const failed: string[] = [];
        const skipped: string[] = [];

        const currentPlugins = await this.getInstalledPlugins();
        const currentPluginIds = new Set(currentPlugins.map(p => p.id));

        for (const plugin of syncPackage.plugins) {
            if (currentPluginIds.has(plugin.id)) {
                skipped.push(plugin.id);
                continue;
            }

            try {
                const communityPlugins = getPluginInstaller(this.app);

                if (communityPlugins?.installPlugin) {
                    await communityPlugins.installPlugin(plugin.id);
                    installed.push(plugin.id);

                    if (syncPackage.settings[plugin.id] && this.settings.syncPluginSettings) {
                        await this.applyPluginSettings(plugin.id, syncPackage.settings[plugin.id]);
                    }
                }
            } catch (e) {
                console.error(`Failed to install plugin ${plugin.id}:`, e);
                failed.push(plugin.id);
            }
        }

        return { installed, failed, skipped };
    }

    /**
     * Apply settings to a plugin
     */
    private async applyPluginSettings(pluginId: string, settings: unknown): Promise<void> {
        const dataPath = this.getPluginDataPath(pluginId);

        try {
            await this.app.vault.adapter.write(dataPath, JSON.stringify(settings, null, 2));
        } catch (e) {
            console.error(`Error applying settings for ${pluginId}:`, e);
        }
    }

    /**
     * Generate plugin list markdown
     */
    generatePluginListMarkdown(plugins: PluginInfo[]): string {
        let md = '# 插件列表\n\n';
        md += `共 ${plugins.length} 个插件\n\n`;
        md += '| 插件名称 | ID | 版本 | 状态 |\n';
        md += '|---------|-----|------|------|\n';

        for (const plugin of plugins) {
            const status = plugin.enabled ? '启用' : '禁用';
            md += `| ${plugin.name} | ${plugin.id} | ${plugin.version} | ${status} |\n`;
        }

        return md;
    }
}
