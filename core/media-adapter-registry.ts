/**
 * Generic registry for provider-side media adapters.
 *
 * Provider declarations say a model exists; adapter registration says this
 * runtime can execute the model protocol.
 */

export class MediaAdapterRegistry {
  declare _adapters: Map<string, any>;
  declare _protocolAdapters: Map<string, any>;
  declare _adapterKeys: Map<string, any>;

  constructor() {
    this._adapters = new Map();
    this._protocolAdapters = new Map();
    this._adapterKeys = new Map();
  }

  register(adapter: any) {
    if (!adapter?.id) throw new Error("media adapter requires id");
    this._adapters.set(adapter.id, adapter);
    const aliases = Array.isArray(adapter.aliases) ? adapter.aliases.filter(Boolean) : [];
    const protocolIds = [
      ...(adapter.protocolId ? [adapter.protocolId] : []),
      ...(Array.isArray(adapter.protocolIds) ? adapter.protocolIds : []),
    ].filter(Boolean);
    for (const alias of aliases) this._adapters.set(alias, adapter);
    for (const protocolId of protocolIds) this._protocolAdapters.set(protocolId, adapter);
    this._adapterKeys.set(adapter.id, { aliases, protocolIds });
  }

  unregister(adapterId: any) {
    const adapter = this._adapters.get(adapterId);
    const canonicalId = adapter?.id || adapterId;
    const keys = this._adapterKeys.get(canonicalId);
    this._adapters.delete(canonicalId);
    for (const alias of keys?.aliases || []) this._adapters.delete(alias);
    for (const protocolId of keys?.protocolIds || []) this._protocolAdapters.delete(protocolId);
    this._adapterKeys.delete(canonicalId);
  }

  get(adapterId: any) {
    return this._adapters.get(adapterId) || null;
  }

  getProtocol(protocolId: any) {
    return this._protocolAdapters.get(protocolId) || null;
  }

  getByType(type: any) {
    const result = [];
    const seen = new Set();
    for (const adapter of this._adapters.values()) {
      if (!Array.isArray(adapter.types) || !adapter.types.includes(type) || seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }

  getDefault(type: any) {
    for (const adapter of this._adapters.values()) {
      if (Array.isArray(adapter.types) && adapter.types.includes(type)) return adapter;
    }
    return null;
  }

  list() {
    const seen = new Set();
    const result = [];
    for (const adapter of this._adapters.values()) {
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }
}
